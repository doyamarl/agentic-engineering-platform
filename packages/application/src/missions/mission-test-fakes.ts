import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MissionId, MissionSource, TenantId, WorkspaceId } from "@aep/domain";
import type { AgentTask } from "../agents/agent-port.ts";
import { createAgentPort, type ProviderEvent } from "../agents/create-agent-port.ts";
import type {
  Checkout,
  CiCheck,
  GitPort,
  Issue,
  PublishRequest,
  PullRequestFiles,
} from "../git/git-port.ts";

// Fakes for the mission job tests (execute-mission, plan-mission). Test-only: not exported from
// the package.

export const TENANT = "0a000000-0000-4000-8000-000000000001" as TenantId;
export const WORKSPACE = "0a000000-0000-4000-8000-0000000000a1" as WorkspaceId;
export const MISSION = "0a000000-0000-4000-8000-00000000a001" as MissionId;
export const NOW = new Date("2026-11-14T00:00:00Z");
export const source: MissionSource = {
  kind: "github_issue",
  owner: "acme",
  repo: "shop",
  issueNumber: 12,
  baseBranch: "main",
};
export const issue: Issue = {
  number: 12,
  title: "Add a greeting",
  body: "Please add hello.txt.",
  url: "https://github.com/acme/shop/issues/12",
};

export type Behaviour = "edits" | "no-edit" | "fails" | "hangs";

/** AgentPort whose sessions edit the working tree (or not) as told. */
export function fakeAgent() {
  const tasks: AgentTask[] = [];
  let behaviour: Behaviour = "edits";
  let reply: string | undefined;
  async function* launch(task: AgentTask, _c: unknown, signal: AbortSignal) {
    tasks.push(task);
    await Promise.resolve();
    const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0.02 };
    switch (behaviour) {
      case "edits":
        writeFileSync(join(task.workdir, "hello.txt"), "hello\n");
        yield {
          type: "result",
          outcome: { kind: "succeeded", summary: "Added hello.txt." },
          usage,
        };
        return;
      case "no-edit":
        yield {
          type: "result",
          outcome: { kind: "succeeded", summary: reply ?? "Nothing to do." },
          usage,
        };
        return;
      case "fails":
        yield {
          type: "result",
          outcome: { kind: "failed", reason: "budget_exceeded", detail: "budget reached" },
          usage,
        };
        return;
      case "hangs":
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
    }
  }
  const port = createAgentPort({
    provider: "fake",
    capabilities: new Set(["streaming"]),
    model: "fake",
    secrets: [],
    launch: launch as (t: AgentTask, c: unknown, s: AbortSignal) => AsyncIterable<ProviderEvent>,
  });
  return {
    port,
    tasks,
    set: (b: Behaviour) => {
      behaviour = b;
    },
    /** The summary a session that changes nothing ("no-edit") finishes with. */
    reply: (text: string) => {
      reply = text;
    },
  };
}

/** GitPort over the local file system: checkout creates a tree, publish sees new files. */
export function fakeGit() {
  const calls = {
    checkouts: [] as string[],
    published: [] as PublishRequest[],
    pulls: [] as { branch: string; title: string; body: string }[],
  };
  let failCheckout = false;
  let ci: readonly CiCheck[] = [];
  let changed: PullRequestFiles = {
    files: [{ path: "hello.txt", additions: 1, deletions: 0 }],
    truncated: false,
  };
  const git: GitPort = {
    readIssue: () => Promise.resolve(issue),
    checkout(repository, baseBranch, directory) {
      if (failCheckout) return Promise.reject(new Error("GitHub unavailable"));
      calls.checkouts.push(directory);
      const workTree = join(directory, "work");
      mkdirSync(workTree, { recursive: true });
      writeFileSync(join(workTree, "README.md"), "# shop\n");
      return Promise.resolve({
        repository,
        workTree,
        gitDir: join(directory, "git"),
        baseBranch,
        baseSha: "base",
      });
    },
    publish(checkout: Checkout, request) {
      calls.published.push(request);
      const changed = readdirSync(checkout.workTree).length > 1;
      return Promise.resolve(changed ? { kind: "pushed", sha: "abc123" } : { kind: "no_changes" });
    },
    readCiChecks: () => Promise.resolve(ci),
    listPullRequestFiles: () => Promise.resolve(changed),
    openDraftPullRequest(_checkout, request) {
      calls.pulls.push(request);
      return Promise.resolve({
        number: 7,
        url: "https://github.com/acme/shop/pull/7",
        created: true,
      });
    },
  };
  return {
    git,
    calls,
    breakCheckout: () => {
      failCheckout = true;
    },
    /** What readCiChecks reports from now on. */
    reportCi: (checks: readonly CiCheck[]) => {
      ci = checks;
    },
    changeFiles: (files: PullRequestFiles) => {
      changed = files;
    },
  };
}
