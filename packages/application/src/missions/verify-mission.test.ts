import type { Mission, MissionState, UserId } from "@aep/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { Job, NewJob } from "../jobs/job-queue.ts";
import { InMemoryMissions } from "./in-memory-missions.ts";
import { fakeGit, MISSION, NOW, source, TENANT, WORKSPACE } from "./mission-test-fakes.ts";
import { verificationJob } from "./mission-workflow.ts";
import { verifyMission } from "./verify-mission.ts";

const USER = "0a000000-0000-4000-8000-0000000000aa" as UserId;
const SHA = "c".repeat(40);
const PLAN =
  "## Summary\nx\n\n## Acceptance criteria\n- tests pass\n\n## Risks and assumptions\n- none";
const MINUTE = 60_000;

let missions: InMemoryMissions;
let git: ReturnType<typeof fakeGit>;
let jobs: NewJob[];
let clock: Date;

/** A mission that went through plan approval and execution, now VERIFYING. */
async function seed(state: MissionState = { status: "VERIFYING", approvedPlanVersion: 1 }) {
  const mission: Mission = {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    id: MISSION,
    title: "Greeting",
    source,
    state: { status: "EXECUTING", approvedPlanVersion: 1 },
    version: 6,
    createdBy: USER,
    createdAt: NOW,
  };
  missions.rows.push(mission);
  missions.plans.push({
    tenantId: TENANT,
    missionId: MISSION,
    version: 1,
    body: PLAN,
    author: { kind: "agent", id: "fake" },
    createdAt: NOW,
    checksumSha256: "d".repeat(64),
  });
  missions.decisions.push({
    tenantId: TENANT,
    missionId: MISSION,
    planVersion: 1,
    decision: "approved",
    decidedBy: USER,
    comment: null,
    decidedAt: NOW,
  });
  // The plan's and the execution's costs are in their events.
  await missions.recordTransition({
    mission,
    state: { status: "EXECUTING", approvedPlanVersion: 1 },
    event: {
      type: "SubmitPlan",
      payload: { planVersion: 1, costUsd: 0.06 },
      actor: { kind: "agent" },
    },
    at: NOW,
  });
  const executing = missions.rows[0];
  if (executing === undefined) throw new Error("setup failed");
  await missions.recordTransition({
    mission: executing,
    state,
    event: {
      type: "CompleteExecution",
      payload: {
        branch: `aep/${MISSION}`,
        commitSha: SHA,
        pullRequestNumber: 7,
        pullRequestUrl: "https://github.com/acme/shop/pull/7",
        costUsd: 0.04,
      },
      actor: { kind: "system" },
    },
    at: NOW,
  });
  missions.events.length = 0;
}

const job = (poll = 0, startedAt = NOW): Job => ({
  id: `job-${String(poll)}`,
  attempt: 1,
  maxAttempts: 5,
  lastError: null,
  ...verificationJob(
    { tenantId: TENANT, id: MISSION },
    { fromVersion: 7, number: poll, startedAt },
  ),
  idempotencyKey: "k",
});

const run = (j = job()) =>
  verifyMission({
    missions,
    git: git.git,
    jobs: {
      enqueue: (next) => {
        jobs.push(next);
        return Promise.resolve({ id: "next", created: true });
      },
    },
    now: () => clock,
    pollMs: 30_000,
    noCiGraceMs: 10 * MINUTE,
    ciTimeoutMs: 60 * MINUTE,
  })(j, new AbortController().signal);

const state = () => missions.rows[0]?.state;

beforeEach(() => {
  missions = new InMemoryMissions(new Map([[TENANT, [WORKSPACE]]]));
  git = fakeGit();
  jobs = [];
  clock = NOW;
});

describe("verifyMission", () => {
  it("builds acceptance packet 1 from passing CI and moves the mission to ACCEPTANCE_READY", async () => {
    await seed();
    git.reportCi([{ name: "node-test", state: "success", url: "https://ci/1" }]);
    await run();

    expect(state()).toEqual({
      status: "ACCEPTANCE_READY",
      approvedPlanVersion: 1,
      packetVersion: 1,
    });
    const packet = missions.packets[0];
    expect(packet?.version).toBe(1);
    expect(packet?.content).toMatchObject({
      plan: { version: 1, acceptanceCriteria: "- tests pass", risks: "- none" },
      approvals: [{ version: 1, decision: "approved", decidedBy: USER }],
      pullRequest: {
        number: 7,
        url: "https://github.com/acme/shop/pull/7",
        branch: `aep/${MISSION}`,
        commitSha: SHA,
      },
      diff: { files: [{ path: "hello.txt", additions: 1, deletions: 0 }], additions: 1 },
      ci: { state: "success" },
      costUsd: 0.1,
    });
    expect(missions.events).toEqual([
      {
        missionId: MISSION,
        type: "PassVerification",
        payload: { packetVersion: 1, ci: "success" },
        actor: { kind: "system" },
      },
    ]);
    expect(jobs).toEqual([]);
  });

  it("fails the mission when a check failed", async () => {
    await seed();
    git.reportCi([
      { name: "node-test", state: "failure", url: null },
      { name: "lint", state: "pending", url: null },
      { name: "e2e", state: "failure", url: null },
    ]);
    await run();
    expect(state()).toMatchObject({ status: "FAILED", reason: "CI failed: node-test, e2e" });
    expect(missions.packets).toEqual([]);
  });

  it("polls again later while checks are pending", async () => {
    await seed();
    git.reportCi([{ name: "node-test", state: "pending", url: null }]);
    clock = new Date(NOW.getTime() + 5 * MINUTE);
    await run(job(3));
    expect(state()?.status).toBe("VERIFYING");
    expect(jobs).toEqual([
      {
        tenantId: TENANT,
        kind: "mission.verify",
        idempotencyKey: `${MISSION}:verify-from-v7-4`,
        payload: { missionId: MISSION, fromVersion: 7, poll: 4, startedAt: NOW.toISOString() },
        runAfter: new Date(clock.getTime() + 30_000),
      },
    ]);
  });

  it("fails the mission when CI does not finish in time", async () => {
    await seed();
    git.reportCi([{ name: "node-test", state: "pending", url: null }]);
    clock = new Date(NOW.getTime() + 61 * MINUTE);
    await run();
    expect(state()).toMatchObject({
      status: "FAILED",
      reason: "CI did not finish within 60 minutes: node-test",
    });
    expect(jobs).toEqual([]);
  });

  it("waits for CI to appear, then accepts without it and says so", async () => {
    await seed();
    clock = new Date(NOW.getTime() + 2 * MINUTE);
    await run();
    expect(state()?.status).toBe("VERIFYING");
    expect(jobs).toHaveLength(1);

    clock = new Date(NOW.getTime() + 11 * MINUTE);
    await run(job(1));
    expect(state()?.status).toBe("ACCEPTANCE_READY");
    expect(missions.packets[0]?.content.ci).toEqual({ state: "none", checks: [] });
    expect(missions.packets[0]?.content.residualRisks[0]).toMatch(/No CI result/);
  });

  it("numbers a new packet after the latest one", async () => {
    await seed();
    git.reportCi([{ name: "node-test", state: "success", url: null }]);
    await run();
    const first = missions.packets[0];
    if (first === undefined) throw new Error("no packet");
    // As after a Retry from a later failure: VERIFYING again.
    const index = missions.rows.findIndex((m) => m.id === MISSION);
    const row = missions.rows[index];
    if (row === undefined) throw new Error("no mission");
    missions.rows[index] = { ...row, state: { status: "VERIFYING", approvedPlanVersion: 1 } };
    await run();
    expect(missions.packets.map((p) => p.version)).toEqual([1, 2]);
  });

  it("does nothing for a mission that is no longer verifying", async () => {
    await seed({ status: "ACCEPTANCE_READY", approvedPlanVersion: 1, packetVersion: 1 });
    await run();
    expect(missions.events).toEqual([]);
    expect(jobs).toEqual([]);
  });

  it("confirms a cancellation", async () => {
    await seed({
      status: "CANCEL_REQUESTED",
      from: { status: "VERIFYING", approvedPlanVersion: 1 },
    });
    await run();
    expect(state()).toEqual({ status: "CANCELLED" });
  });
});
