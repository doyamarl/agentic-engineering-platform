import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkout, GitPort } from "@aep/application";
import { beforeEach, describe, expect, it } from "vitest";
import type { GitHubApp } from "./github-app.ts";
import { gitHubGit } from "./github-git.ts";

// Real git against local bare repositories (file://). The GitHub API is faked; the live test
// covers the real one.

const TOKEN = "ghs_test-installation-token-0000";
const repo = { owner: "acme", name: "shop" };
const committer = { name: "aep-bot", email: "aep-bot@example.test" };

/** git for fixtures, isolated from the developer's own config. */
function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "seed",
      GIT_AUTHOR_EMAIL: "seed@example.test",
      GIT_COMMITTER_NAME: "seed",
      GIT_COMMITTER_EMAIL: "seed@example.test",
    },
  }).trim();
}

type ApiCall = { method: string; path: string; credential: string; body?: unknown };

function fakeApp(responses: { status: number; data: unknown }[] = []) {
  const calls: ApiCall[] = [];
  const app: GitHubApp = {
    installationToken: () =>
      Promise.resolve({ token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000) }),
    request: (method: string, path: string, credential: string, body?: unknown) => {
      calls.push({ method, path, credential, body });
      const next = responses.shift() ?? { status: 500, data: { message: "unexpected" } };
      return Promise.resolve({ ...next, headers: new Headers() });
    },
  };
  return { app, calls };
}

let root: string;
let remote: string;
let baseSha: string;
let port: GitPort;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aep-github-test-"));
  remote = join(root, "remotes", "acme", "shop.git");
  mkdirSync(remote, { recursive: true });
  git(["init", "--bare", "--initial-branch=main", remote]);
  const seed = join(root, "seed");
  git(["init", "--quiet", "--initial-branch=main", seed]);
  writeFileSync(join(seed, "README.md"), "# shop\n");
  git(["add", "."], seed);
  git(["commit", "-m", "seed"], seed);
  git(["push", "--quiet", remote, "HEAD:main"], seed);
  baseSha = git(["rev-parse", "HEAD"], seed);
  port = gitHubGit({ app: fakeApp().app, committer, gitUrl: `file://${join(root, "remotes")}` });
});

const checkoutDir = () => join(root, "checkouts", "m1");

/** Every file under dir, recursively. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

describe("checkout", () => {
  it("clones the base branch into a working tree without .git, metadata kept apart", async () => {
    const c = await port.checkout(repo, "main", checkoutDir());
    expect(c.baseSha).toBe(baseSha);
    expect(readFileSync(join(c.workTree, "README.md"), "utf8")).toBe("# shop\n");
    expect(existsSync(join(c.workTree, ".git"))).toBe(false);
    expect(c.gitDir.startsWith(c.workTree)).toBe(false);
    expect(existsSync(join(c.gitDir, "HEAD"))).toBe(true);
  });

  it("writes the token nowhere on disk", async () => {
    await port.checkout(repo, "main", checkoutDir());
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    for (const f of files(checkoutDir())) {
      const text = readFileSync(f, "latin1");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(basic);
    }
  });

  it("rejects bad names and non-empty directories", async () => {
    await expect(
      port.checkout({ owner: "acme", name: ".." }, "main", checkoutDir()),
    ).rejects.toThrow(/invalid repository/);
    await expect(port.checkout(repo, "--upload-pack=x", checkoutDir())).rejects.toThrow(
      /invalid base branch/,
    );
    mkdirSync(checkoutDir(), { recursive: true });
    writeFileSync(join(checkoutDir(), "x"), "");
    await expect(port.checkout(repo, "main", checkoutDir())).rejects.toThrow(/not empty/);
  });
});

describe("publish", () => {
  let c: Checkout;
  beforeEach(async () => {
    c = await port.checkout(repo, "main", checkoutDir());
  });

  it("reports no changes and pushes nothing for an untouched tree", async () => {
    expect(await port.publish(c, { branch: "aep/m1", message: "m" })).toEqual({
      kind: "no_changes",
    });
    expect(git(["--git-dir", remote, "branch", "--list", "aep/*"])).toBe("");
  });

  it("commits every change as the bot on top of the base and pushes the mission branch", async () => {
    writeFileSync(join(c.workTree, "README.md"), "# shop\nedited\n");
    writeFileSync(join(c.workTree, "new.txt"), "new\n");
    const result = await port.publish(c, { branch: "aep/m1", message: "Add new.txt" });
    expect(result.kind).toBe("pushed");
    const sha = result.kind === "pushed" ? result.sha : "";
    const g = (...a: string[]) => git(["--git-dir", remote, ...a]);
    expect(g("rev-parse", "refs/heads/aep/m1")).toBe(sha);
    expect(g("rev-parse", "refs/heads/main")).toBe(baseSha);
    expect(g("log", "-1", "--format=%P|%an|%cn|%s", sha)).toBe(
      `${baseSha}|aep-bot|aep-bot|Add new.txt`,
    );
    expect(g("show", `${sha}:new.txt`)).toBe("new");
  });

  it("can be repeated after a crash, and replaces an earlier attempt's push", async () => {
    writeFileSync(join(c.workTree, "a.txt"), "a\n");
    const first = await port.publish(c, { branch: "aep/m1", message: "first" });
    expect(await port.publish(c, { branch: "aep/m1", message: "first" })).toEqual(first);

    // A retried job starts from a fresh checkout and produces a different commit.
    const retry = await port.checkout(repo, "main", join(root, "checkouts", "m1-retry"));
    writeFileSync(join(retry.workTree, "b.txt"), "b\n");
    const second = await port.publish(retry, { branch: "aep/m1", message: "second" });
    expect(git(["--git-dir", remote, "rev-parse", "refs/heads/aep/m1"])).toBe(
      second.kind === "pushed" ? second.sha : "",
    );
  });

  it("pushes only to branches under the prefix", async () => {
    writeFileSync(join(c.workTree, "a.txt"), "a\n");
    await expect(port.publish(c, { branch: "main", message: "m" })).rejects.toThrow(/aep\//);
    await expect(port.publish(c, { branch: "aep/../main", message: "m" })).rejects.toThrow(
      /invalid branch/,
    );
    expect(git(["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(baseSha);
  });

  it("runs nothing the working tree or repository could plant (hooks, config, fsmonitor)", async () => {
    const marker = join(root, "PWNED");
    const evil = `#!/bin/sh\ntouch ${marker}\n`;
    // What an agent could leave in the tree: its own .git with hooks and config.
    mkdirSync(join(c.workTree, ".git", "hooks"), { recursive: true });
    writeFileSync(join(c.workTree, ".git", "hooks", "post-commit"), evil);
    chmodSync(join(c.workTree, ".git", "hooks", "post-commit"), 0o755);
    writeFileSync(
      join(c.workTree, ".git", "config"),
      `[core]\n\thooksPath = .git/hooks\n\tfsmonitor = touch ${marker}\n`,
    );
    // Defense in depth: hooks in the real metadata do not run either.
    mkdirSync(join(c.gitDir, "hooks"), { recursive: true });
    for (const hook of ["post-commit", "pre-push", "reference-transaction"]) {
      writeFileSync(join(c.gitDir, "hooks", hook), evil);
      chmodSync(join(c.gitDir, "hooks", hook), 0o755);
    }
    writeFileSync(join(c.workTree, "a.txt"), "a\n");

    const result = await port.publish(c, { branch: "aep/m1", message: "m" });
    expect(result.kind).toBe("pushed");
    expect(existsSync(marker)).toBe(false);
    const tree = git(["--git-dir", remote, "ls-tree", "-r", "--name-only", "refs/heads/aep/m1"]);
    expect(tree.split("\n")).toEqual(["README.md", "a.txt"]);
  });

  it("keeps the token off git's command line", async () => {
    const log = join(root, "argv.log");
    const wrapper = join(root, "git-wrapper.sh");
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexec git "$@"\n`);
    chmodSync(wrapper, 0o755);
    const wrapped = gitHubGit({
      app: fakeApp().app,
      committer,
      gitUrl: `file://${join(root, "remotes")}`,
      git: wrapper,
    });
    const w = await wrapped.checkout(repo, "main", join(root, "checkouts", "wrapped"));
    writeFileSync(join(w.workTree, "a.txt"), "a\n");
    await wrapped.publish(w, { branch: "aep/m1", message: "m" });
    const argv = readFileSync(log, "utf8");
    expect(argv).toContain(" clone ");
    expect(argv).toContain(" push ");
    expect(argv).not.toContain(TOKEN);
    expect(argv).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
  });
});

describe("openDraftPullRequest", () => {
  const checkout: Checkout = {
    repository: repo,
    workTree: "/w",
    gitDir: "/g",
    baseBranch: "main",
    baseSha: "0".repeat(40),
  };
  const request = { branch: "aep/m1", title: "Add new.txt", body: "Mission m1" };

  it("opens a draft pull request from the mission branch into the base", async () => {
    const { app, calls } = fakeApp([
      { status: 201, data: { number: 7, html_url: "https://github.com/acme/shop/pull/7" } },
    ]);
    const pr = await gitHubGit({ app, committer }).openDraftPullRequest(checkout, request);
    expect(pr).toEqual({ number: 7, url: "https://github.com/acme/shop/pull/7", created: true });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/repos/acme/shop/pulls",
        credential: TOKEN,
        body: {
          title: "Add new.txt",
          head: "aep/m1",
          base: "main",
          body: "Mission m1",
          draft: true,
        },
      },
    ]);
  });

  it("returns the open pull request when one already exists (retried job)", async () => {
    const { app, calls } = fakeApp([
      { status: 422, data: { message: "A pull request already exists for acme:aep/m1." } },
      { status: 200, data: [{ number: 7, html_url: "https://github.com/acme/shop/pull/7" }] },
    ]);
    const pr = await gitHubGit({ app, committer }).openDraftPullRequest(checkout, request);
    expect(pr).toEqual({ number: 7, url: "https://github.com/acme/shop/pull/7", created: false });
    expect(calls[1]?.path).toBe("/repos/acme/shop/pulls?head=acme%3Aaep%2Fm1&state=open");
  });

  it("fails on other errors and refuses branches outside the prefix", async () => {
    const { app } = fakeApp([{ status: 403, data: { message: "Resource not accessible" } }]);
    const port = gitHubGit({ app, committer });
    await expect(port.openDraftPullRequest(checkout, request)).rejects.toThrow(/403/);
    await expect(
      port.openDraftPullRequest(checkout, { ...request, branch: "main" }),
    ).rejects.toThrow(/aep\//);
  });
});

describe("readIssue", () => {
  it("returns the issue's title, body and URL", async () => {
    const { app, calls } = fakeApp([
      {
        status: 200,
        data: {
          number: 12,
          title: "Fix",
          body: null,
          html_url: "https://github.com/acme/shop/issues/12",
        },
      },
    ]);
    expect(await gitHubGit({ app, committer }).readIssue(repo, 12)).toEqual({
      number: 12,
      title: "Fix",
      body: "",
      url: "https://github.com/acme/shop/issues/12",
    });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/repos/acme/shop/issues/12" });
  });

  it("rejects pull requests, bad numbers and API errors", async () => {
    const { app } = fakeApp([
      { status: 200, data: { number: 3, title: "PR", body: "", html_url: "u", pull_request: {} } },
      { status: 404, data: { message: "Not Found" } },
    ]);
    const port = gitHubGit({ app, committer });
    await expect(port.readIssue(repo, 3)).rejects.toThrow(/pull request/);
    await expect(port.readIssue(repo, 4)).rejects.toThrow(/404/);
    await expect(port.readIssue(repo, 0)).rejects.toThrow(/invalid issue/);
  });
});

describe("readCiChecks", () => {
  const sha = "a".repeat(40);

  it("combines check runs and commit statuses into one list", async () => {
    const { app, calls } = fakeApp([
      {
        status: 200,
        data: {
          total_count: 4,
          check_runs: [
            { name: "test", status: "completed", conclusion: "success", html_url: "https://ci/1" },
            { name: "lint", status: "in_progress", conclusion: null, html_url: "https://ci/2" },
            { name: "e2e", status: "completed", conclusion: "timed_out", html_url: null },
            { name: "docs", status: "completed", conclusion: "skipped", html_url: "https://ci/4" },
          ],
        },
      },
      {
        status: 200,
        data: {
          statuses: [
            { context: "legacy", state: "failure", target_url: "https://ci/5" },
            { context: "deploy", state: "pending", target_url: null },
          ],
        },
      },
    ]);
    expect(await gitHubGit({ app, committer }).readCiChecks(repo, sha)).toEqual([
      { name: "test", state: "success", url: "https://ci/1" },
      { name: "lint", state: "pending", url: "https://ci/2" },
      { name: "e2e", state: "failure", url: null },
      { name: "docs", state: "neutral", url: "https://ci/4" },
      { name: "legacy", state: "failure", url: "https://ci/5" },
      { name: "deploy", state: "pending", url: null },
    ]);
    expect(calls.map((c) => [c.method, c.path, c.credential])).toEqual([
      ["GET", `/repos/acme/shop/commits/${sha}/check-runs?per_page=100`, TOKEN],
      ["GET", `/repos/acme/shop/commits/${sha}/status?per_page=100`, TOKEN],
    ]);
  });

  it("returns nothing when no CI reported", async () => {
    const { app } = fakeApp([
      { status: 200, data: { total_count: 0, check_runs: [] } },
      { status: 200, data: { state: "pending", statuses: [] } },
    ]);
    expect(await gitHubGit({ app, committer }).readCiChecks(repo, sha)).toEqual([]);
  });

  it("rejects a malformed sha and API errors", async () => {
    const { app } = fakeApp([{ status: 403, data: { message: "Resource not accessible" } }]);
    const port = gitHubGit({ app, committer });
    await expect(port.readCiChecks(repo, "main")).rejects.toThrow(/invalid commit/);
    await expect(port.readCiChecks(repo, sha)).rejects.toThrow(/403/);
  });
});

describe("listPullRequestFiles", () => {
  const file = (i: number) => ({ filename: `f${String(i)}.js`, additions: i, deletions: 1 });

  it("lists the changed files with line counts", async () => {
    const { app, calls } = fakeApp([{ status: 200, data: [file(1), file(2)] }]);
    expect(await gitHubGit({ app, committer }).listPullRequestFiles(repo, 5)).toEqual({
      files: [
        { path: "f1.js", additions: 1, deletions: 1 },
        { path: "f2.js", additions: 2, deletions: 1 },
      ],
      truncated: false,
    });
    expect(calls[0]?.path).toBe("/repos/acme/shop/pulls/5/files?per_page=100&page=1");
  });

  it("reads up to three pages and says when there is more", async () => {
    const page = (start: number) => Array.from({ length: 100 }, (_, i) => file(start + i));
    const { app, calls } = fakeApp([
      { status: 200, data: page(0) },
      { status: 200, data: page(100) },
      { status: 200, data: page(200) },
    ]);
    const result = await gitHubGit({ app, committer }).listPullRequestFiles(repo, 5);
    expect(result.files).toHaveLength(300);
    expect(result.truncated).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("rejects a bad number and API errors", async () => {
    const { app } = fakeApp([{ status: 404, data: { message: "Not Found" } }]);
    const port = gitHubGit({ app, committer });
    await expect(port.listPullRequestFiles(repo, 0)).rejects.toThrow(/invalid pull request/);
    await expect(port.listPullRequestFiles(repo, 5)).rejects.toThrow(/404/);
  });
});
