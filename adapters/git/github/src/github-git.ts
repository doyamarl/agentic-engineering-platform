import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  Checkout,
  CiCheck,
  DraftPullRequest,
  GitPort,
  Issue,
  PublishResult,
  PullRequestFiles,
  RepositoryRef,
} from "@aep/application";
import { errorMessage, GitHubApiError, type GitHubApp } from "./github-app.ts";

// GitPort for GitHub, using the git CLI and a GitHub App (github-app.ts).
//
// The working tree has been edited by an untrusted agent, so every git command here:
// - takes --git-dir/--work-tree explicitly; the metadata lives outside the working tree, and a
//   `.git` the agent creates there is ignored;
// - ignores system and global config, disables hooks and fsmonitor, and allows only the remote's
//   protocol, so nothing in the tree can make git run a program;
// - gets the token through GIT_CONFIG_* environment variables as an extra header scoped to the
//   remote's URL, so it appears neither on the command line nor in any file.

export type GitHubGitConfig = {
  readonly app: GitHubApp;
  readonly committer: { readonly name: string; readonly email: string };
  /** Defaults to https://github.com. Tests point it at a file:// directory of bare repositories. */
  readonly gitUrl?: string;
  /** Branches this adapter may push to. Defaults to `aep/`. */
  readonly branchPrefix?: string;
  /** git binary. Defaults to `git` on PATH. */
  readonly git?: string;
};

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
/** Pages of 100 files read from a pull request; GitHub itself lists at most 3000. */
const MAX_FILE_PAGES = 3;

type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
};
type CommitStatus = { context: string; state: string; target_url: string | null };

function checkRunState(run: CheckRun): CiCheck["state"] {
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "success") return "success";
  if (run.conclusion === "neutral" || run.conclusion === "skipped") return "neutral";
  // failure, cancelled, timed_out, action_required, stale, startup_failure
  return "failure";
}

function statusState(status: CommitStatus): CiCheck["state"] {
  if (status.state === "success") return "success";
  if (status.state === "pending") return "pending";
  return "failure"; // failure, error
}

function checkRepository({ owner, name }: RepositoryRef): void {
  for (const part of [owner, name]) {
    if (!NAME.test(part) || part === "." || part === "..") {
      throw new Error(`invalid repository name: ${owner}/${name}`);
    }
  }
}

export class GitCommandError extends Error {
  readonly exitCode: number | null;

  constructor(args: readonly string[], exitCode: number | null, stderr: string) {
    super(`git ${args[0] ?? ""} failed (exit ${String(exitCode)}): ${stderr.trim()}`);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
  }
}

type GitResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

export function gitHubGit(config: GitHubGitConfig): GitPort {
  const gitUrl = (config.gitUrl ?? "https://github.com").replace(/\/+$/, "");
  const scheme = new URL(gitUrl).protocol.replace(/:$/, "");
  const prefix = config.branchPrefix ?? "aep/";
  const gitBin = config.git ?? "git";

  const hardening = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "protocol.allow=never",
    "-c",
    `protocol.${scheme}.allow=always`,
    "-c",
    "credential.helper=",
  ];

  /** Runs git; `token` adds the auth header, and is scrubbed from any error text. */
  function run(
    args: readonly string[],
    options: { readonly cwd?: string; readonly token?: string } = {},
  ): Promise<GitResult> {
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: process.env["HOME"] ?? "/",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    if (options.token !== undefined) {
      const basic = Buffer.from(`x-access-token:${options.token}`).toString("base64");
      env["GIT_CONFIG_COUNT"] = "1";
      env["GIT_CONFIG_KEY_0"] = `http.${gitUrl}/.extraHeader`;
      env["GIT_CONFIG_VALUE_0"] = `Authorization: Basic ${basic}`;
    }
    return new Promise((resolve, reject) => {
      const child = spawn(gitBin, [...hardening, ...args], {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
      child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
      child.once("error", reject);
      child.once("close", (code) => {
        const scrub = (s: string) =>
          options.token === undefined ? s : s.replaceAll(options.token, "[REDACTED]");
        resolve({ code, stdout, stderr: scrub(stderr) });
      });
    });
  }

  async function ok(args: readonly string[], options?: { cwd?: string; token?: string }) {
    const r = await run(args, options);
    if (r.code !== 0) throw new GitCommandError(args, r.code, r.stderr);
    return r.stdout.trim();
  }

  const inRepo = (c: Checkout) => ["--git-dir", c.gitDir, "--work-tree", c.workTree];

  async function checkRef(kind: "branch" | "base branch", name: string): Promise<void> {
    if (name.startsWith("-") || (await run(["check-ref-format", "--branch", name])).code !== 0) {
      throw new Error(`invalid ${kind} name: ${name}`);
    }
  }

  const remoteUrl = (r: RepositoryRef) => `${gitUrl}/${r.owner}/${r.name}.git`;

  return {
    async readIssue(repository, issueNumber): Promise<Issue> {
      checkRepository(repository);
      if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
        throw new Error(`invalid issue number: ${String(issueNumber)}`);
      }
      const { token } = await config.app.installationToken(repository);
      const path = `/repos/${repository.owner}/${repository.name}/issues/${String(issueNumber)}`;
      const { status, data } = await config.app.request("GET", path, token);
      if (status !== 200) throw new GitHubApiError("GET", path, status, errorMessage(data));
      const issue = data as {
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        pull_request?: unknown;
      };
      // GitHub serves pull requests from the issues endpoint too.
      if (issue.pull_request !== undefined)
        throw new Error(`#${String(issueNumber)} is a pull request`);
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        url: issue.html_url,
      };
    },

    async readCiChecks(repository, sha): Promise<readonly CiCheck[]> {
      checkRepository(repository);
      if (!SHA.test(sha)) throw new Error(`invalid commit sha: ${sha}`);
      const { token } = await config.app.installationToken(repository);
      const commit = `/repos/${repository.owner}/${repository.name}/commits/${sha}`;
      const get = async (path: string) => {
        const { status, data } = await config.app.request("GET", path, token);
        if (status !== 200) throw new GitHubApiError("GET", path, status, errorMessage(data));
        return data;
      };
      const runs = (await get(`${commit}/check-runs?per_page=100`)) as { check_runs: CheckRun[] };
      const statuses = (await get(`${commit}/status?per_page=100`)) as {
        statuses: CommitStatus[];
      };
      return [
        ...runs.check_runs.map((run) => ({
          name: run.name,
          state: checkRunState(run),
          url: run.html_url,
        })),
        ...statuses.statuses.map((status) => ({
          name: status.context,
          state: statusState(status),
          url: status.target_url,
        })),
      ];
    },

    async listPullRequestFiles(repository, number): Promise<PullRequestFiles> {
      checkRepository(repository);
      if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error(`invalid pull request number: ${String(number)}`);
      }
      const { token } = await config.app.installationToken(repository);
      const files: PullRequestFiles["files"][number][] = [];
      for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        const path = `/repos/${repository.owner}/${repository.name}/pulls/${String(number)}/files?per_page=100&page=${String(page)}`;
        const { status, data } = await config.app.request("GET", path, token);
        if (status !== 200) throw new GitHubApiError("GET", path, status, errorMessage(data));
        const batch = data as { filename: string; additions: number; deletions: number }[];
        files.push(
          ...batch.map((f) => ({
            path: f.filename,
            additions: f.additions,
            deletions: f.deletions,
          })),
        );
        if (batch.length < 100) return { files, truncated: false };
      }
      return { files, truncated: true };
    },

    async checkout(repository, baseBranch, directory) {
      checkRepository(repository);
      await checkRef("base branch", baseBranch);
      if (!isAbsolute(directory)) throw new Error("checkout directory must be absolute");
      await mkdir(directory, { recursive: true });
      if ((await readdir(directory)).length > 0) throw new Error("checkout directory is not empty");
      const workTree = join(directory, "work");
      const gitDir = join(directory, "git");
      const { token } = await config.app.installationToken(repository);
      await ok(
        [
          "clone",
          "--template=",
          "--single-branch",
          "--branch",
          baseBranch,
          "--depth",
          "1",
          "--separate-git-dir",
          gitDir,
          "--",
          remoteUrl(repository),
          workTree,
        ],
        { token },
      );
      // The agent works on the tree alone; the metadata stays where the sandbox cannot see it.
      await rm(join(workTree, ".git"), { force: true });
      const checkout = { repository, workTree, gitDir, baseBranch, baseSha: "" };
      const baseSha = await ok([...inRepo(checkout), "rev-parse", "HEAD"]);
      return { ...checkout, baseSha };
    },

    async publish(checkout, request): Promise<PublishResult> {
      if (!request.branch.startsWith(prefix)) {
        throw new Error(`branch must start with ${prefix}: ${request.branch}`);
      }
      await checkRef("branch", request.branch);
      const repo = inRepo(checkout);
      const cwd = checkout.workTree;
      await ok([...repo, "add", "--all"], { cwd });
      // Exit 1 means the index differs from HEAD; a retried publish may find it already committed.
      const staged = await run([...repo, "diff", "--cached", "--quiet"], { cwd });
      if (staged.code === 1) {
        await ok(
          [
            "-c",
            `user.name=${config.committer.name}`,
            "-c",
            `user.email=${config.committer.email}`,
            ...repo,
            "commit",
            "--no-verify",
            "--no-gpg-sign",
            "--message",
            request.message,
          ],
          { cwd },
        );
      } else if (staged.code !== 0) {
        throw new GitCommandError(["diff"], staged.code, staged.stderr);
      }
      const head = await ok([...repo, "rev-parse", "HEAD"], { cwd });
      if (head === checkout.baseSha) return { kind: "no_changes" };
      const { token } = await config.app.installationToken(checkout.repository);
      // The branch belongs to this mission; replacing an earlier attempt's push is intended.
      await ok(
        [
          ...repo,
          "push",
          "--no-verify",
          "--force",
          remoteUrl(checkout.repository),
          `HEAD:refs/heads/${request.branch}`,
        ],
        { cwd, token },
      );
      return { kind: "pushed", sha: head };
    },

    async openDraftPullRequest(checkout, request): Promise<DraftPullRequest> {
      const { repository } = checkout;
      checkRepository(repository);
      if (!request.branch.startsWith(prefix)) {
        throw new Error(`branch must start with ${prefix}: ${request.branch}`);
      }
      const { token } = await config.app.installationToken(repository);
      const base = `/repos/${repository.owner}/${repository.name}/pulls`;
      type Pull = { number: number; html_url: string };
      const created = await config.app.request("POST", base, token, {
        title: request.title,
        head: request.branch,
        base: checkout.baseBranch,
        body: request.body,
        draft: true,
      });
      if (created.status === 201) {
        const pull = created.data as Pull;
        return { number: pull.number, url: pull.html_url, created: true };
      }
      if (created.status === 422) {
        // Most likely a retry: the pull request for this branch already exists.
        const head = encodeURIComponent(`${repository.owner}:${request.branch}`);
        const open = await config.app.request("GET", `${base}?head=${head}&state=open`, token);
        const existing = open.status === 200 ? (open.data as Pull[])[0] : undefined;
        if (existing !== undefined) {
          return { number: existing.number, url: existing.html_url, created: false };
        }
      }
      throw new GitHubApiError("POST", base, created.status, errorMessage(created.data));
    },
  };
}
