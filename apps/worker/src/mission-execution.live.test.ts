import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { missionService, runWorker, type Principal } from "@aep/application";
import type { Mission, MissionId, TenantId, UserId, WorkspaceId } from "@aep/domain";
import { gitHubApp } from "@aep/git-github";
import { PostgresJobQueue, PostgresMissionRepository } from "@aep/postgres";
import {
  TENANT_A,
  USER_A,
  WORKSPACE_A,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "@aep/postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionSetup } from "./execution.ts";

// Sprint 3, end to end: a GitHub issue becomes a mission, an agent writes a plan, a person
// approves it, the worker runs Claude on it in a Docker sandbox, a draft pull request appears, and
// once the repository's CI passes on it the mission is acceptance-ready with a packet. The test
// repository needs a CI workflow that runs on pull requests. Real PostgreSQL (Testcontainers), real Docker, real Claude API (two sessions; costs about
// USD 0.10-0.30) and a real GitHub App. Skipped unless the operator opts in from their own
// terminal with the worker's variables (see execution.ts) plus:
//
//   AEP_LIVE_E2E=1 AEP_GITHUB_TEST_REPO=owner/name AEP_GITHUB_TEST_ISSUE=<number>
//
// Each run uses a new mission, so a new branch and draft pull request; close them by hand.

const env = process.env;
const enabled = env["AEP_LIVE_E2E"] === "1";
const [owner = "", repo = ""] = (env["AEP_GITHUB_TEST_REPO"] ?? "").split("/");
const planner: Principal = {
  tenantId: TENANT_A as TenantId,
  userId: USER_A as UserId,
  role: "planner",
};

let db: TestDatabase;

beforeAll(async () => {
  if (!enabled) return;
  db = await startDatabase();
  await seedTwoTenants(db.admin);
}, 180_000);

afterAll(async () => {
  if (enabled) await db.stop();
});

describe.skipIf(!enabled)("mission end to end", () => {
  it("plans, approves and turns a GitHub issue into an acceptance-ready pull request", async () => {
    const missions = new PostgresMissionRepository(db.app);
    const service = missionService({
      missions,
      newMissionId: () => randomUUID() as MissionId,
      now: () => new Date(),
    });
    const created = await service.create(planner, {
      workspaceId: WORKSPACE_A as WorkspaceId,
      title: "Live end-to-end mission",
      source: {
        kind: "github_issue",
        owner,
        repo,
        issueNumber: Number(env["AEP_GITHUB_TEST_ISSUE"]),
        baseBranch: env["AEP_GITHUB_TEST_BASE"] ?? "main",
      },
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const id = created.value.id;

    const queue = new PostgresJobQueue(db.app);
    // Poll CI every 5 s and give up waiting for a first result after 3 minutes, unless set.
    const setup = executionSetup(
      {
        AEP_VERIFY_POLL_MS: "5000",
        AEP_VERIFY_NO_CI_GRACE_MS: "180000",
        ...env,
      },
      missions,
      queue,
    );
    if (!setup.enabled) throw new Error(`missing ${setup.missing.join(", ")}`);
    const stop = new AbortController();
    const errors: string[] = [];
    const loop = runWorker({
      queue,
      handlers: setup.handlers,
      onDead: setup.onDead,
      workerId: "live-e2e",
      leaseMs: 60_000,
      pollMs: 500,
      signal: stop.signal,
      log: (e) => {
        if (e.error !== undefined) errors.push(e.error);
      },
    });
    /** Waits until the mission leaves `status` (or a job error is logged), up to 9 minutes. */
    const leave = async (status: string): Promise<Mission | undefined> => {
      const deadline = Date.now() + 9 * 60_000;
      for (;;) {
        const mission = await missions.findById(planner.tenantId, id);
        if (mission?.state.status !== status || errors.length > 0 || Date.now() > deadline) {
          return mission;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };

    try {
      expect((await service.startPlanning(planner, id)).ok).toBe(true);
      const planned = await leave("PLANNING");
      expect(errors).toEqual([]);
      expect(planned?.state).toEqual({ status: "AWAITING_PLAN_APPROVAL", planVersion: 1 });
      const plan = await service.getPlan(planner, id);
      if (!plan.ok) throw new Error("no plan");
      console.log(`--- plan version 1 ---\n${plan.value.body}\n---`);
      expect(plan.value.body).toContain("## Acceptance criteria");

      const approved = await service.approvePlan(planner, id, { planVersion: 1 });
      expect(approved.ok && approved.value.state.status).toBe("EXECUTING");
      const executed = await leave("EXECUTING");
      expect(errors).toEqual([]);
      expect(executed?.state).toEqual({ status: "VERIFYING", approvedPlanVersion: 1 });

      const verified = await leave("VERIFYING");
      expect(errors).toEqual([]);
      expect(verified?.state).toEqual({
        status: "ACCEPTANCE_READY",
        approvedPlanVersion: 1,
        packetVersion: 1,
      });
      const packet = await service.getAcceptancePacket(planner, id);
      if (!packet.ok) throw new Error("no acceptance packet");
      console.log(
        `--- acceptance packet 1 ---\n${JSON.stringify(packet.value.content, null, 2)}\n---`,
      );
      expect(packet.value.content.ci.state).toBe("success");
    } finally {
      stop.abort();
      await loop;
    }

    const events = await db.admin
      .selectFrom("mission_events")
      .select(["type", "payload"])
      .where("mission_id", "=", id)
      .orderBy("seq")
      .execute();
    expect(events.map((e) => e.type)).toEqual([
      "StartPlanning",
      "SubmitPlan",
      "ApprovePlan",
      "StartExecution",
      "CompleteExecution",
      "PassVerification",
    ]);
    const completed = events.at(-2)?.payload as { pullRequestNumber: number; costUsd: number };
    const submitted = events[1]?.payload as { costUsd: number };
    console.log(JSON.stringify({ planCostUsd: submitted.costUsd, completed }));

    const app = gitHubApp({
      appId: env["AEP_GITHUB_APP_ID"] ?? "",
      privateKey: readFileSync(env["AEP_GITHUB_PRIVATE_KEY_PATH"] ?? "", "utf8"),
    });
    const { token } = await app.installationToken({ owner, name: repo });
    const pull = await app.request(
      "GET",
      `/repos/${owner}/${repo}/pulls/${String(completed.pullRequestNumber)}`,
      token,
    );
    expect(pull.data).toMatchObject({
      draft: true,
      state: "open",
      head: { ref: `aep/${id}` },
    });
    const files = await app.request(
      "GET",
      `/repos/${owner}/${repo}/pulls/${String(completed.pullRequestNumber)}/files`,
      token,
    );
    expect((files.data as unknown[]).length).toBeGreaterThan(0);
  }, 900_000);
});
