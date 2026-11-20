import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeAgent } from "@aep/agent-claude";
import {
  EXECUTE_MISSION_JOB,
  executeMission,
  failMissionOfDeadJob,
  PLAN_MISSION_JOB,
  planMission,
  VERIFY_MISSION_JOB,
  verifyMission,
  type JobQueue,
  type DeadJobHandler,
  type JobHandler,
  type MissionRepository,
} from "@aep/application";
import { gitHubApp, gitHubGit } from "@aep/git-github";
import { dockerSandbox } from "@aep/sandbox-docker";

// Builds the mission job handlers (mission.plan, mission.execute, mission.verify) from the environment. The worker runs them only when every
// required variable is set; otherwise it reports what is missing and serves health checks only
// (as in Docker Compose, where the worker has no Docker access for sandboxes).
//
// Required: ANTHROPIC_API_KEY, AEP_GITHUB_APP_ID, AEP_GITHUB_PRIVATE_KEY_PATH.
// Optional: AEP_CLAUDE_MODEL, AEP_SANDBOX_IMAGE, AEP_WORK_ROOT, AEP_AGENT_MAX_BUDGET_USD,
// AEP_AGENT_WALL_CLOCK_MS, AEP_AGENT_ALLOW_HOSTS (comma-separated), AEP_GIT_COMMITTER_NAME,
// AEP_GIT_COMMITTER_EMAIL, AEP_VERIFY_POLL_MS, AEP_VERIFY_NO_CI_GRACE_MS, AEP_VERIFY_CI_TIMEOUT_MS.

const REQUIRED = ["ANTHROPIC_API_KEY", "AEP_GITHUB_APP_ID", "AEP_GITHUB_PRIVATE_KEY_PATH"] as const;

export type ExecutionSetup =
  | {
      readonly enabled: true;
      readonly handlers: Readonly<Record<string, JobHandler>>;
      readonly onDead: Readonly<Record<string, DeadJobHandler>>;
    }
  | { readonly enabled: false; readonly missing: readonly string[] };

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function executionSetup(
  env: NodeJS.ProcessEnv,
  missions: MissionRepository,
  jobs: Pick<JobQueue, "enqueue">,
): ExecutionSetup {
  const missing = REQUIRED.filter((name) => (env[name] ?? "") === "");
  if (missing.length > 0) return { enabled: false, missing };
  const image = env["AEP_SANDBOX_IMAGE"] ?? "node:24-bookworm-slim";
  const app = gitHubApp({
    appId: env["AEP_GITHUB_APP_ID"] ?? "",
    privateKey: readFileSync(env["AEP_GITHUB_PRIVATE_KEY_PATH"] ?? "", "utf8"),
  });
  const deps = {
    missions,
    git: gitHubGit({
      app,
      committer: {
        name: env["AEP_GIT_COMMITTER_NAME"] ?? "aep-bot",
        email: env["AEP_GIT_COMMITTER_EMAIL"] ?? "aep-bot@users.noreply.github.com",
      },
    }),
    agent: claudeAgent({
      apiKey: env["ANTHROPIC_API_KEY"] ?? "",
      model: env["AEP_CLAUDE_MODEL"] ?? "claude-sonnet-5-5",
      sandbox: {
        port: dockerSandbox({ proxyImage: image }),
        image,
        limits: { memoryMb: 2048, cpus: 2, pids: 512 },
        allowHosts: (env["AEP_AGENT_ALLOW_HOSTS"] ?? "")
          .split(",")
          .map((h) => h.trim())
          .filter((h) => h !== ""),
      },
    }),
    workRoot: env["AEP_WORK_ROOT"] ?? join(homedir(), ".local", "state", "aep", "work"),
    limits: {
      wallClockMs: positive(env, "AEP_AGENT_WALL_CLOCK_MS", 15 * 60_000),
      maxBudgetUsd: positive(env, "AEP_AGENT_MAX_BUDGET_USD", 1),
    },
    now: () => new Date(),
  };
  const failIfStill = (activeStatus: "PLANNING" | "EXECUTING" | "VERIFYING") =>
    failMissionOfDeadJob({ missions, activeStatus, now: () => new Date() });
  return {
    enabled: true,
    handlers: {
      [PLAN_MISSION_JOB]: planMission(deps),
      [EXECUTE_MISSION_JOB]: executeMission(deps),
      [VERIFY_MISSION_JOB]: verifyMission({
        missions,
        git: deps.git,
        jobs,
        now: deps.now,
        pollMs: positive(env, "AEP_VERIFY_POLL_MS", 30_000),
        noCiGraceMs: positive(env, "AEP_VERIFY_NO_CI_GRACE_MS", 10 * 60_000),
        ciTimeoutMs: positive(env, "AEP_VERIFY_CI_TIMEOUT_MS", 60 * 60_000),
      }),
    },
    onDead: {
      [PLAN_MISSION_JOB]: failIfStill("PLANNING"),
      [EXECUTE_MISSION_JOB]: failIfStill("EXECUTING"),
      [VERIFY_MISSION_JOB]: failIfStill("VERIFYING"),
    },
  };
}
