import type { MissionId, TenantId, UserId, WorkspaceId } from "@aep/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "../principal.ts";
import { InMemoryMissions } from "./in-memory-missions.ts";
import { missionService } from "./mission-service.ts";

const TENANT_A = "0a000000-0000-4000-8000-000000000001" as TenantId;
const TENANT_B = "0b000000-0000-4000-8000-000000000001" as TenantId;
const WORKSPACE_A = "0a000000-0000-4000-8000-0000000000a1" as WorkspaceId;
const WORKSPACE_B = "0b000000-0000-4000-8000-0000000000b1" as WorkspaceId;
const NOW = new Date("2026-11-13T00:00:00Z");

const principal = (tenantId: TenantId, role: Principal["role"]): Principal => ({
  tenantId,
  userId: `${tenantId.slice(0, 2)}000000-0000-4000-8000-0000000000ff` as UserId,
  role,
});

let missions: InMemoryMissions;
let service: ReturnType<typeof missionService>;
let nextId: number;

beforeEach(() => {
  missions = new InMemoryMissions(
    new Map([
      [TENANT_A, [WORKSPACE_A]],
      [TENANT_B, [WORKSPACE_B]],
    ]),
  );
  nextId = 1;
  service = missionService({
    missions,
    newMissionId: () =>
      `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}` as MissionId,
    now: () => NOW,
  });
});

describe("create", () => {
  it("creates a DRAFT mission in the principal's tenant, attributed to the principal", async () => {
    const alice = principal(TENANT_A, "planner");
    const result = await service.create(alice, { workspaceId: WORKSPACE_A, title: "Signup" });

    expect(result).toEqual({
      ok: true,
      value: {
        tenantId: TENANT_A,
        workspaceId: WORKSPACE_A,
        id: "00000000-0000-4000-8000-000000000001",
        title: "Signup",
        state: { status: "DRAFT" },
        version: 1,
        createdBy: alice.userId,
        createdAt: NOW,
      },
    });
  });

  it("records where the work comes from", async () => {
    const source = {
      kind: "github_issue",
      owner: "acme",
      repo: "shop",
      issueNumber: 12,
      baseBranch: "main",
    } as const;
    const result = await service.create(principal(TENANT_A, "planner"), {
      workspaceId: WORKSPACE_A,
      title: "Signup",
      source,
    });
    expect(result.ok && result.value.source).toEqual(source);
    expect(missions.rows[0]?.source).toEqual(source);
  });

  it("rejects an invalid source without writing", async () => {
    const result = await service.create(principal(TENANT_A, "planner"), {
      workspaceId: WORKSPACE_A,
      title: "Signup",
      source: {
        kind: "github_issue",
        owner: "../x",
        repo: "shop",
        issueNumber: 1,
        baseBranch: "main",
      },
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "Invalid", field: "source", reason: "owner and repo must be GitHub names" },
    });
    expect(missions.rows).toEqual([]);
  });

  it("forbids a role without mission:create", async () => {
    const result = await service.create(principal(TENANT_A, "viewer"), {
      workspaceId: WORKSPACE_A,
      title: "Signup",
    });
    expect(result).toEqual({ ok: false, error: { kind: "Forbidden", action: "mission:create" } });
    expect(missions.rows).toEqual([]);
  });

  it("reports another tenant's workspace as not found", async () => {
    const result = await service.create(principal(TENANT_A, "admin"), {
      workspaceId: WORKSPACE_B,
      title: "Signup",
    });
    expect(result).toEqual({ ok: false, error: { kind: "NotFound", resource: "workspace" } });
  });

  it("rejects an invalid title without writing", async () => {
    const result = await service.create(principal(TENANT_A, "admin"), {
      workspaceId: WORKSPACE_A,
      title: " ",
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "Invalid", field: "title", reason: "must be 1-200 characters" },
    });
    expect(missions.rows).toEqual([]);
  });
});

describe("tenant isolation on reads (PRD §8-A)", () => {
  let missionOfB: MissionId;

  beforeEach(async () => {
    const created = await service.create(principal(TENANT_B, "planner"), {
      workspaceId: WORKSPACE_B,
      title: "B's mission",
    });
    if (!created.ok) throw new Error("setup failed");
    missionOfB = created.value.id;
  });

  it("answers a guessed id from another tenant exactly like a missing id", async () => {
    const intruder = principal(TENANT_A, "admin");
    const guessed = await service.get(intruder, missionOfB);
    const missing = await service.get(
      intruder,
      "00000000-0000-4000-8000-0000000000ee" as MissionId,
    );

    expect(guessed).toEqual({ ok: false, error: { kind: "NotFound", resource: "mission" } });
    expect(guessed).toEqual(missing);
  });

  it("lists only the principal's tenant", async () => {
    await service.create(principal(TENANT_A, "planner"), { workspaceId: WORKSPACE_A, title: "A" });
    const listed = await service.list(principal(TENANT_A, "viewer"), {});

    expect(listed.ok && listed.value.map((m) => m.title)).toEqual(["A"]);
  });

  it("lets a same-tenant viewer read", async () => {
    const result = await service.get(principal(TENANT_B, "viewer"), missionOfB);
    expect(result.ok && result.value.title).toBe("B's mission");
  });
});

describe("list limits", () => {
  it.each([0, 101, 1.5])("rejects limit %j", async (limit) => {
    const result = await service.list(principal(TENANT_A, "viewer"), { limit });
    expect(result).toEqual({
      ok: false,
      error: { kind: "Invalid", field: "limit", reason: "must be an integer 1-100" },
    });
  });
});

describe("planning", () => {
  const source = {
    kind: "github_issue",
    owner: "acme",
    repo: "shop",
    issueNumber: 12,
    baseBranch: "main",
  } as const;
  let missionId: MissionId;

  beforeEach(async () => {
    const created = await service.create(principal(TENANT_A, "planner"), {
      workspaceId: WORKSPACE_A,
      title: "Greeting",
      source,
    });
    if (!created.ok) throw new Error("setup failed");
    missionId = created.value.id;
  });

  it("starts planning as the principal and enqueues the planning job", async () => {
    const engineer = principal(TENANT_A, "engineer");
    const result = await service.startPlanning(engineer, missionId);
    expect(result.ok && result.value.state).toEqual({ status: "PLANNING" });
    expect(missions.enqueued.map((j) => j.kind)).toEqual(["mission.plan"]);
    expect(missions.events[0]).toMatchObject({
      type: "StartPlanning",
      actor: { kind: "human", id: engineer.userId },
    });
  });

  it("forbids a viewer", async () => {
    expect(await service.startPlanning(principal(TENANT_A, "viewer"), missionId)).toEqual({
      ok: false,
      error: { kind: "Forbidden", action: "mission:plan" },
    });
    expect(missions.enqueued).toEqual([]);
  });

  it("answers another tenant's mission as not found", async () => {
    expect(await service.startPlanning(principal(TENANT_B, "admin"), missionId)).toEqual({
      ok: false,
      error: { kind: "NotFound", resource: "mission" },
    });
  });

  it("needs a source", async () => {
    const bare = await service.create(principal(TENANT_A, "planner"), {
      workspaceId: WORKSPACE_A,
      title: "No source",
    });
    if (!bare.ok) throw new Error("setup failed");
    expect(await service.startPlanning(principal(TENANT_A, "planner"), bare.value.id)).toEqual({
      ok: false,
      error: { kind: "Invalid", field: "source", reason: "is required to plan a mission" },
    });
  });

  it("reports a second request as a conflict and plans once", async () => {
    const planner = principal(TENANT_A, "planner");
    await service.startPlanning(planner, missionId);
    expect(await service.startPlanning(planner, missionId)).toEqual({
      ok: false,
      error: { kind: "Conflict", reason: "not allowed while the mission is PLANNING" },
    });
    expect(missions.enqueued).toHaveLength(1);
  });

  it("reads plans by version, or the latest, within the tenant only", async () => {
    for (const version of [1, 2]) {
      missions.plans.push({
        tenantId: TENANT_A,
        missionId,
        version,
        body: `plan ${String(version)}`,
        author: { kind: "agent", id: "claude" },
        createdAt: NOW,
        checksumSha256: "0".repeat(64),
      });
    }
    const viewer = principal(TENANT_A, "viewer");
    const latest = await service.getPlan(viewer, missionId);
    expect(latest.ok && latest.value.body).toBe("plan 2");
    const first = await service.getPlan(viewer, missionId, 1);
    expect(first.ok && first.value.body).toBe("plan 1");
    expect(await service.getPlan(viewer, missionId, 3)).toEqual({
      ok: false,
      error: { kind: "NotFound", resource: "plan" },
    });
    expect(await service.getPlan(principal(TENANT_B, "admin"), missionId)).toEqual({
      ok: false,
      error: { kind: "NotFound", resource: "mission" },
    });
  });
});

describe("plan approval", () => {
  const source = {
    kind: "github_issue",
    owner: "acme",
    repo: "shop",
    issueNumber: 12,
    baseBranch: "main",
  } as const;
  let missionId: MissionId;
  const planner = principal(TENANT_A, "planner");

  /** Creates a mission and moves it to AWAITING_PLAN_APPROVAL with plan version 1. */
  beforeEach(async () => {
    const created = await service.create(planner, {
      workspaceId: WORKSPACE_A,
      title: "Greeting",
      source,
    });
    if (!created.ok) throw new Error("setup failed");
    missionId = created.value.id;
    await service.startPlanning(planner, missionId);
    const index = missions.rows.findIndex((m) => m.id === missionId);
    const row = missions.rows[index];
    if (row === undefined) throw new Error("setup failed");
    missions.rows[index] = {
      ...row,
      state: { status: "AWAITING_PLAN_APPROVAL", planVersion: 1 },
      version: row.version + 1,
    };
    missions.enqueued.length = 0;
    missions.events.length = 0;
  });

  it("approves the version, records the decision and starts execution", async () => {
    const result = await service.approvePlan(planner, missionId, {
      planVersion: 1,
      comment: " looks good ",
    });
    expect(result.ok && result.value.state).toEqual({
      status: "EXECUTING",
      approvedPlanVersion: 1,
    });
    expect(missions.decisions).toEqual([
      {
        planVersion: 1,
        decision: "approved",
        decidedBy: planner.userId,
        comment: "looks good",
        decidedAt: NOW,
        missionId,
        tenantId: TENANT_A,
      },
    ]);
    expect(missions.events.map((e) => [e.type, e.actor])).toEqual([
      ["ApprovePlan", { kind: "human", id: planner.userId }],
      ["StartExecution", { kind: "human", id: planner.userId }],
    ]);
    expect(missions.enqueued.map((j) => j.kind)).toEqual(["mission.execute"]);
  });

  it("refuses a stale version", async () => {
    expect(await service.approvePlan(planner, missionId, { planVersion: 2 })).toEqual({
      ok: false,
      error: {
        kind: "Conflict",
        reason: "plan version 2 is not the current version 1",
      },
    });
    expect(missions.decisions).toEqual([]);
  });

  it("starts execution of an approved plan whose start was interrupted, once", async () => {
    const index = missions.rows.findIndex((m) => m.id === missionId);
    const row = missions.rows[index];
    if (row === undefined) throw new Error("setup failed");
    missions.rows[index] = { ...row, state: { status: "APPROVED", approvedPlanVersion: 1 } };
    const result = await service.approvePlan(planner, missionId, { planVersion: 1 });
    expect(result.ok && result.value.state.status).toBe("EXECUTING");
    expect(missions.decisions).toEqual([]);
    expect(await service.approvePlan(planner, missionId, { planVersion: 1 })).toMatchObject({
      ok: false,
      error: { kind: "Conflict" },
    });
    expect(missions.enqueued).toHaveLength(1);
  });

  it("forbids an engineer, and hides another tenant's mission", async () => {
    expect(
      await service.approvePlan(principal(TENANT_A, "engineer"), missionId, { planVersion: 1 }),
    ).toEqual({ ok: false, error: { kind: "Forbidden", action: "plan:approve" } });
    expect(
      await service.rejectPlan(principal(TENANT_A, "engineer"), missionId, {
        planVersion: 1,
        reason: "x",
      }),
    ).toEqual({ ok: false, error: { kind: "Forbidden", action: "plan:approve" } });
    expect(
      await service.approvePlan(principal(TENANT_B, "admin"), missionId, { planVersion: 1 }),
    ).toEqual({ ok: false, error: { kind: "NotFound", resource: "mission" } });
  });

  it("rejects the version with a reason and plans again", async () => {
    const result = await service.rejectPlan(planner, missionId, {
      planVersion: 1,
      reason: " Add a test. ",
    });
    expect(result.ok && result.value.state).toEqual({ status: "PLANNING" });
    expect(missions.decisions[0]).toMatchObject({
      planVersion: 1,
      decision: "rejected",
      comment: "Add a test.",
    });
    expect(missions.enqueued.map((j) => j.kind)).toEqual(["mission.plan"]);
  });

  it.each(["", "  ", "x".repeat(4001)])(
    "needs a rejection reason of 1-4000 characters",
    async (reason) => {
      expect(await service.rejectPlan(planner, missionId, { planVersion: 1, reason })).toEqual({
        ok: false,
        error: { kind: "Invalid", field: "reason", reason: "must be 1-4000 characters" },
      });
    },
  );

  it("bounds an approval comment", async () => {
    expect(
      await service.approvePlan(planner, missionId, { planVersion: 1, comment: "x".repeat(4001) }),
    ).toEqual({
      ok: false,
      error: { kind: "Invalid", field: "comment", reason: "must be at most 4000 characters" },
    });
  });
});

describe("audit trail", () => {
  let missionId: MissionId;
  const planner = principal(TENANT_A, "planner");

  beforeEach(async () => {
    const created = await service.create(planner, {
      workspaceId: WORKSPACE_A,
      title: "Greeting",
      source: {
        kind: "github_issue",
        owner: "acme",
        repo: "shop",
        issueNumber: 1,
        baseBranch: "main",
      },
    });
    if (!created.ok) throw new Error("setup failed");
    missionId = created.value.id;
    await service.startPlanning(planner, missionId);
  });

  it("lists the mission's events oldest first, numbered, to any member of the tenant", async () => {
    const result = await service.listEvents(principal(TENANT_A, "viewer"), missionId, {});
    expect(result).toEqual({
      ok: true,
      value: [
        {
          seq: 1,
          type: "StartPlanning",
          payload: {},
          actor: { kind: "human", id: planner.userId },
          occurredAt: NOW,
        },
      ],
    });
  });

  it("pages after a seq", async () => {
    const page = await service.listEvents(planner, missionId, { afterSeq: 1 });
    expect(page).toEqual({ ok: true, value: [] });
  });

  it("hides another tenant's mission", async () => {
    expect(await service.listEvents(principal(TENANT_B, "admin"), missionId, {})).toEqual({
      ok: false,
      error: { kind: "NotFound", resource: "mission" },
    });
  });

  it.each([
    [{ limit: 0 }, "limit"],
    [{ limit: 501 }, "limit"],
    [{ afterSeq: -1 }, "after"],
    [{ afterSeq: 1.5 }, "after"],
  ])("rejects %j", async (page, field) => {
    expect(await service.listEvents(planner, missionId, page)).toMatchObject({
      ok: false,
      error: { kind: "Invalid", field },
    });
  });
});

describe("cancel", () => {
  let missionId: MissionId;
  const engineer = principal(TENANT_A, "engineer");

  beforeEach(async () => {
    const created = await service.create(engineer, {
      workspaceId: WORKSPACE_A,
      title: "Greeting",
      source: {
        kind: "github_issue",
        owner: "acme",
        repo: "shop",
        issueNumber: 1,
        baseBranch: "main",
      },
    });
    if (!created.ok) throw new Error("setup failed");
    missionId = created.value.id;
  });

  it("cancels a draft at once, as the principal", async () => {
    const result = await service.cancel(engineer, missionId);
    expect(result.ok && result.value.state).toEqual({ status: "CANCELLED" });
    expect(missions.events.at(-1)).toMatchObject({
      type: "Cancel",
      actor: { kind: "human", id: engineer.userId },
    });
  });

  it("asks running work to stop", async () => {
    await service.startPlanning(engineer, missionId);
    const result = await service.cancel(engineer, missionId);
    expect(result.ok && result.value.state).toEqual({
      status: "CANCEL_REQUESTED",
      from: { status: "PLANNING" },
    });
  });

  it("refuses a cancelled mission, a viewer and another tenant", async () => {
    await service.cancel(engineer, missionId);
    expect(await service.cancel(engineer, missionId)).toEqual({
      ok: false,
      error: { kind: "Conflict", reason: "not allowed while the mission is CANCELLED" },
    });
    expect(await service.cancel(principal(TENANT_A, "viewer"), missionId)).toEqual({
      ok: false,
      error: { kind: "Forbidden", action: "mission:cancel" },
    });
    expect(await service.cancel(principal(TENANT_B, "admin"), missionId)).toEqual({
      ok: false,
      error: { kind: "NotFound", resource: "mission" },
    });
  });
});
