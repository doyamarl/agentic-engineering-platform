import { createHash } from "node:crypto";
import type {
  AcceptancePacket,
  Mission,
  MissionId,
  Plan,
  TenantId,
  UserId,
  WorkspaceId,
} from "@aep/domain";
import { draftMission } from "@aep/domain";
import type { NewJob } from "@aep/application";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapTenant } from "./bootstrap.ts";
import { issueApiToken, PostgresIdentity } from "./identity.ts";
import { PostgresMissionRepository } from "./mission-repository.ts";
import { PostgresWorkspaceDirectory } from "./workspace-directory.ts";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
  WORKSPACE_A,
  WORKSPACE_B,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "./test-support.ts";

let db: TestDatabase;

beforeAll(async () => {
  db = await startDatabase();
}, 180_000);

afterAll(async () => {
  await db.stop();
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
});

describe("API token identity", () => {
  const issueForAlice = () =>
    issueApiToken(db.admin, { tenantId: TENANT_A, userId: USER_A, name: "laptop" });

  it("resolves an issued token to the member's tenant, user and current role", async () => {
    const token = await issueForAlice();
    expect(await new PostgresIdentity(db.app).authenticate(token)).toEqual({
      tenantId: TENANT_A,
      userId: USER_A,
      role: "planner",
    });

    await db.admin
      .updateTable("memberships")
      .set({ role: "viewer" })
      .where("user_id", "=", USER_A)
      .execute();
    expect((await new PostgresIdentity(db.app).authenticate(token))?.role).toBe("viewer");
  });

  it("stores only the SHA-256 digest of the token", async () => {
    const token = await issueForAlice();
    const rows = await db.admin.selectFrom("api_tokens").select("token_hash").execute();
    expect(rows).toEqual([{ token_hash: createHash("sha256").update(token).digest("hex") }]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it.each([
    ["an unknown token", `aep_${"A".repeat(43)}`],
    ["an empty string", ""],
    ["a token without the prefix", "A".repeat(47)],
    ["an oversized value", `aep_${"A".repeat(10_000)}`],
  ])("rejects %s", async (_, credential) => {
    await issueForAlice();
    expect(await new PostgresIdentity(db.app).authenticate(credential)).toBeUndefined();
  });

  it("rejects a revoked token", async () => {
    const token = await issueForAlice();
    await db.admin.updateTable("api_tokens").set({ revoked_at: new Date() }).execute();
    expect(await new PostgresIdentity(db.app).authenticate(token)).toBeUndefined();
  });

  it("rejects an expired token", async () => {
    const token = await issueApiToken(db.admin, {
      tenantId: TENANT_A,
      userId: USER_A,
      name: "ci",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await new PostgresIdentity(db.app).authenticate(token)).toBeUndefined();
  });

  it("refuses to issue a token for a user who is not a member of the tenant", async () => {
    await expect(
      issueApiToken(db.admin, { tenantId: TENANT_A, userId: USER_B, name: "x" }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("PostgresMissionRepository (runtime role, RLS active)", () => {
  const mission = (
    tenantId: string,
    workspaceId: string,
    createdBy: string,
    id: string,
    createdAt: string,
  ): Mission => {
    const drafted = draftMission({
      tenantId: tenantId as TenantId,
      workspaceId: workspaceId as WorkspaceId,
      id: id as MissionId,
      title: `mission ${id.slice(-3)}`,
      createdBy: createdBy as UserId,
      createdAt: new Date(createdAt),
    });
    if (!drafted.ok) throw new Error("invalid fixture");
    return drafted.value;
  };

  const a1 = mission(
    TENANT_A,
    WORKSPACE_A,
    USER_A,
    "0a000000-0000-4000-8000-00000000a001",
    "2026-11-13T01:00:00Z",
  );
  const a2 = mission(
    TENANT_A,
    WORKSPACE_A,
    USER_A,
    "0a000000-0000-4000-8000-00000000a002",
    "2026-11-13T02:00:00Z",
  );
  const b1 = mission(
    TENANT_B,
    WORKSPACE_B,
    USER_B,
    "0b000000-0000-4000-8000-00000000b001",
    "2026-11-13T03:00:00Z",
  );

  let repo: PostgresMissionRepository;

  beforeEach(async () => {
    repo = new PostgresMissionRepository(db.app);
    for (const m of [a1, a2, b1])
      expect(await repo.insert(m)).toEqual({ ok: true, value: undefined });
  });

  it("round-trips a mission", async () => {
    expect(await repo.findById(a1.tenantId, a1.id)).toEqual(a1);
  });

  it("does not find another tenant's mission by id", async () => {
    expect(await repo.findById(a1.tenantId, b1.id)).toBeUndefined();
  });

  it("lists the tenant's missions newest first, honouring the limit", async () => {
    expect(await repo.list(a1.tenantId, { limit: 10 })).toEqual([a2, a1]);
    expect(await repo.list(a1.tenantId, { limit: 1 })).toEqual([a2]);
    expect(
      await repo.list(a1.tenantId, { limit: 10, workspaceId: WORKSPACE_B as WorkspaceId }),
    ).toEqual([]);
  });

  it("reports a workspace of another tenant as not found", async () => {
    const crossTenant = {
      ...a1,
      id: "0a000000-0000-4000-8000-00000000a009" as MissionId,
      workspaceId: WORKSPACE_B as WorkspaceId,
    };
    expect(await repo.insert(crossTenant)).toEqual({
      ok: false,
      error: { kind: "WorkspaceNotFound" },
    });
  });

  it("round-trips a mission's source", async () => {
    const source = {
      kind: "github_issue" as const,
      owner: "acme",
      repo: "shop",
      issueNumber: 12,
      baseBranch: "main",
    };
    const withSource = { ...a1, id: "0a000000-0000-4000-8000-00000000a010" as MissionId, source };
    await repo.insert(withSource);
    expect(await repo.findById(a1.tenantId, withSource.id)).toEqual(withSource);
  });

  describe("recordTransition", () => {
    const at = new Date("2026-11-14T00:00:00Z");
    const change = (m: Mission, enqueue?: NewJob) => ({
      mission: m,
      state: { status: "PLANNING" } as const,
      event: { type: "StartPlanning", payload: { note: "x" }, actor: { kind: "system" } } as const,
      at,
      ...(enqueue === undefined ? {} : { enqueue }),
    });

    it("updates state and version, appends a numbered event, and enqueues in one transaction", async () => {
      const job: NewJob = {
        tenantId: a1.tenantId,
        kind: "mission.plan",
        idempotencyKey: a1.id,
        payload: { missionId: a1.id },
      };
      const first = await repo.recordTransition(change(a1, job));
      expect(first.ok && first.value).toMatchObject({ state: { status: "PLANNING" }, version: 2 });
      expect(await repo.findById(a1.tenantId, a1.id)).toMatchObject({ version: 2 });
      if (!first.ok) return;
      await repo.recordTransition({
        ...change(first.value),
        state: { status: "AWAITING_PLAN_APPROVAL", planVersion: 1 },
        event: { type: "SubmitPlan", payload: {}, actor: { kind: "agent", id: "claude" } },
      });
      const events = await db.admin
        .selectFrom("mission_events")
        .select(["seq", "type", "actor_kind", "actor_id", "payload"])
        .where("mission_id", "=", a1.id)
        .orderBy("seq")
        .execute();
      expect(events).toEqual([
        {
          seq: "1",
          type: "StartPlanning",
          actor_kind: "system",
          actor_id: null,
          payload: { note: "x" },
        },
        { seq: "2", type: "SubmitPlan", actor_kind: "agent", actor_id: "claude", payload: {} },
      ]);
      const jobs = await db.admin.selectFrom("jobs").select(["kind", "tenant_id"]).execute();
      expect(jobs).toEqual([{ kind: "mission.plan", tenant_id: a1.tenantId }]);
    });

    it("refuses a stale version and writes nothing", async () => {
      expect((await repo.recordTransition(change(a1))).ok).toBe(true);
      const job: NewJob = {
        tenantId: a1.tenantId,
        kind: "mission.plan",
        idempotencyKey: "stale",
        payload: {},
      };
      expect(await repo.recordTransition(change(a1, job))).toEqual({
        ok: false,
        error: { kind: "Conflict" },
      });
      const count = async (table: "mission_events" | "jobs") =>
        (await db.admin.selectFrom(table).select("tenant_id").execute()).length;
      expect(await count("mission_events")).toBe(1);
      expect(await count("jobs")).toBe(0);
    });

    it("lists events oldest first, after a seq, within the tenant only", async () => {
      const first = await repo.recordTransition(change(a1));
      if (!first.ok) throw new Error("setup failed");
      await repo.recordTransition({
        ...change(first.value),
        state: { status: "AWAITING_PLAN_APPROVAL", planVersion: 1 },
        event: {
          type: "SubmitPlan",
          payload: { planVersion: 1, costUsd: 0.06 },
          actor: { kind: "agent", id: "claude" },
        },
      });
      expect(await repo.listEvents(a1.tenantId, a1.id, { limit: 10 })).toEqual([
        {
          seq: 1,
          type: "StartPlanning",
          payload: { note: "x" },
          actor: { kind: "system" },
          occurredAt: at,
        },
        {
          seq: 2,
          type: "SubmitPlan",
          payload: { planVersion: 1, costUsd: 0.06 },
          actor: { kind: "agent", id: "claude" },
          occurredAt: at,
        },
      ]);
      expect(
        (await repo.listEvents(a1.tenantId, a1.id, { afterSeq: 1, limit: 10 })).map((e) => e.seq),
      ).toEqual([2]);
      expect((await repo.listEvents(a1.tenantId, a1.id, { limit: 1 })).map((e) => e.seq)).toEqual([
        1,
      ]);
      expect(await repo.listEvents(b1.tenantId, a1.id, { limit: 10 })).toEqual([]);
    });

    it("cannot change another tenant's mission", async () => {
      const forged = { ...b1, tenantId: a1.tenantId };
      expect(await repo.recordTransition(change(forged))).toEqual({
        ok: false,
        error: { kind: "Conflict" },
      });
      expect(await repo.findById(b1.tenantId, b1.id)).toEqual(b1);
    });
  });

  describe("plans", () => {
    const at = new Date("2026-11-14T00:00:00Z");
    const plan = (m: Mission, version: number, body = `plan ${String(version)}`): Plan => ({
      tenantId: m.tenantId,
      missionId: m.id,
      version,
      body,
      author: { kind: "agent", id: "claude" },
      createdAt: at,
    });
    const submit = (m: Mission, p: Plan) =>
      repo.recordTransition({
        mission: m,
        state: { status: "AWAITING_PLAN_APPROVAL", planVersion: p.version },
        event: { type: "SubmitPlan", payload: {}, actor: { kind: "agent", id: "claude" } },
        at,
        plan: p,
      });

    it("stores a plan with its change and finds it by version or as the latest", async () => {
      const first = await submit(a1, plan(a1, 1, "## Summary\nこんにちは"));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      await submit(first.value, plan(a1, 2));
      const v1 = await repo.findPlan(a1.tenantId, a1.id, 1);
      expect(v1).toEqual({
        ...plan(a1, 1, "## Summary\nこんにちは"),
        checksumSha256: createHash("sha256").update("## Summary\nこんにちは").digest("hex"),
      });
      expect((await repo.findPlan(a1.tenantId, a1.id))?.version).toBe(2);
      expect(await repo.findPlan(a1.tenantId, a1.id, 3)).toBeUndefined();
      expect(await repo.findPlan(a2.tenantId, a2.id)).toBeUndefined();
    });

    it("reports a version that already exists as a Conflict and rolls back the change", async () => {
      const first = await submit(a1, plan(a1, 1));
      if (!first.ok) throw new Error("setup failed");
      expect(await submit(first.value, plan(a1, 1, "other"))).toEqual({
        ok: false,
        error: { kind: "Conflict" },
      });
      expect(await repo.findById(a1.tenantId, a1.id)).toMatchObject({ version: 2 });
      expect((await repo.findPlan(a1.tenantId, a1.id, 1))?.body).toBe("plan 1");
      const events = await db.admin.selectFrom("mission_events").select("seq").execute();
      expect(events).toHaveLength(1);
    });

    it("records a person's decision with the change, and finds the latest for a version", async () => {
      const submitted = await submit(a1, plan(a1, 1));
      if (!submitted.ok) throw new Error("setup failed");
      const decided = await repo.recordTransition({
        mission: submitted.value,
        state: { status: "PLANNING" },
        event: {
          type: "RejectPlan",
          payload: { planVersion: 1 },
          actor: { kind: "human", id: USER_A },
        },
        at,
        decision: {
          planVersion: 1,
          decision: "rejected",
          decidedBy: USER_A as UserId,
          comment: "add a test",
        },
      });
      expect(decided.ok).toBe(true);
      expect(await repo.findPlanDecision(a1.tenantId, a1.id, 1)).toEqual({
        planVersion: 1,
        decision: "rejected",
        decidedBy: USER_A,
        comment: "add a test",
        decidedAt: at,
      });
      expect(await repo.findPlanDecision(a1.tenantId, a1.id, 2)).toBeUndefined();
      expect(await repo.findPlanDecision(b1.tenantId, a1.id, 1)).toBeUndefined();
    });

    it("writes no decision when the change is stale", async () => {
      const submitted = await submit(a1, plan(a1, 1));
      if (!submitted.ok) throw new Error("setup failed");
      const stale = await repo.recordTransition({
        mission: a1,
        state: { status: "APPROVED", approvedPlanVersion: 1 },
        event: { type: "ApprovePlan", payload: {}, actor: { kind: "human", id: USER_A } },
        at,
        decision: {
          planVersion: 1,
          decision: "approved",
          decidedBy: USER_A as UserId,
          comment: null,
        },
      });
      expect(stale).toEqual({ ok: false, error: { kind: "Conflict" } });
      expect(await db.admin.selectFrom("approvals").select("id").execute()).toEqual([]);
    });

    it("lists every plan decision of the mission, oldest first", async () => {
      const decide = async (m: Mission, version: number, decision: "approved" | "rejected") => {
        const r = await repo.recordTransition({
          mission: m,
          state:
            decision === "approved"
              ? { status: "APPROVED", approvedPlanVersion: version }
              : { status: "PLANNING" },
          event: { type: "Decide", payload: {}, actor: { kind: "human", id: USER_A } },
          at: new Date(at.getTime() + version * 1000),
          decision: { planVersion: version, decision, decidedBy: USER_A as UserId, comment: null },
        });
        if (!r.ok) throw new Error("decide failed");
        return r.value;
      };
      const afterReject = await decide(a1, 1, "rejected");
      await decide(afterReject, 2, "approved");
      expect(
        (await repo.listPlanDecisions(a1.tenantId, a1.id)).map((d) => [d.planVersion, d.decision]),
      ).toEqual([
        [1, "rejected"],
        [2, "approved"],
      ]);
      expect(await repo.listPlanDecisions(b1.tenantId, a1.id)).toEqual([]);
    });

    it("stores an acceptance packet with its change, checksummed, and finds it", async () => {
      const packet = (version: number) =>
        ({
          tenantId: a1.tenantId,
          missionId: a1.id,
          version,
          createdAt: at,
          content: { schemaVersion: 1, note: `packet ${String(version)} – 日本語` },
        }) as unknown as AcceptancePacket;
      const pass = (m: Mission, version: number) =>
        repo.recordTransition({
          mission: m,
          state: { status: "ACCEPTANCE_READY", approvedPlanVersion: 1, packetVersion: version },
          event: {
            type: "PassVerification",
            payload: { packetVersion: version },
            actor: { kind: "system" },
          },
          at,
          packet: packet(version),
        });
      const first = await pass(a1, 1);
      if (!first.ok) throw new Error("setup failed");
      const stored = await repo.findAcceptancePacket(a1.tenantId, a1.id);
      const json = JSON.stringify(packet(1).content);
      expect(stored).toEqual({
        ...packet(1),
        checksumSha256: createHash("sha256").update(json).digest("hex"),
      });
      expect(await pass(first.value, 1)).toEqual({ ok: false, error: { kind: "Conflict" } });
      expect(await repo.findById(a1.tenantId, a1.id)).toMatchObject({ version: 2 });
      expect(await repo.findAcceptancePacket(a1.tenantId, a1.id, 2)).toBeUndefined();
      expect(await repo.findAcceptancePacket(b1.tenantId, a1.id)).toBeUndefined();
    });

    it("does not show another tenant's plan", async () => {
      expect((await submit(b1, plan(b1, 1))).ok).toBe(true);
      expect(await repo.findPlan(a1.tenantId, b1.id)).toBeUndefined();
      expect(await repo.findPlan(a1.tenantId, b1.id, 1)).toBeUndefined();
    });

    it("refuses a plan of another mission", async () => {
      await expect(submit(a1, plan(a2, 1))).rejects.toThrow(/own mission/);
      expect(await repo.findPlan(a2.tenantId, a2.id)).toBeUndefined();
    });
  });

  it("shows the runtime role nothing outside a tenant scope", async () => {
    const { rows } = await sql<{ n: string }>`select count(*)::text as n from missions`.execute(
      db.app,
    );
    expect(rows[0]?.n).toBe("0");
  });
});

describe("bootstrapTenant (as table owner, RLS forced)", () => {
  it("creates a tenant whose admin token authenticates with the admin role", async () => {
    const created = await bootstrapTenant(db.owner, {
      tenantName: "Demo",
      workspaceName: "Growth",
      adminName: "Operator",
    });

    expect(await new PostgresIdentity(db.app).authenticate(created.token)).toEqual({
      tenantId: created.tenantId,
      userId: created.userId,
      role: "admin",
    });
    const workspaces = await db.admin
      .selectFrom("workspaces")
      .select(["tenant_id", "id"])
      .where("tenant_id", "=", created.tenantId)
      .execute();
    expect(workspaces).toEqual([{ tenant_id: created.tenantId, id: created.workspaceId }]);
  });
});

describe("runtime role privileges", () => {
  it.each([
    ["delete missions", sql`delete from missions`],
    ["update approvals", sql`update approvals set comment = 'x'`],
    ["update plans", sql`update plans set body = 'x'`],
    ["delete plans", sql`delete from plans`],
    ["update acceptance_packets", sql`update acceptance_packets set content = '{}'`],
    ["delete acceptance_packets", sql`delete from acceptance_packets`],
    ["insert tenants", sql`insert into tenants (id, name) values (gen_random_uuid(), 'x')`],
    ["read migration bookkeeping", sql`select * from kysely_migration`],
    ["truncate missions", sql`truncate missions cascade`],
  ])("cannot %s", async (_, statement) => {
    await expect(statement.execute(db.app)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("PostgresWorkspaceDirectory (runtime role, RLS active)", () => {
  it("lists only the tenant's workspaces, by name", async () => {
    await db.admin
      .insertInto("workspaces")
      .values({
        tenant_id: TENANT_A,
        id: "0a000000-0000-4000-8000-0000000000a2",
        name: "Activation",
      })
      .execute();
    const directory = new PostgresWorkspaceDirectory(db.app);
    expect(await directory.list(TENANT_A as TenantId)).toEqual([
      { id: "0a000000-0000-4000-8000-0000000000a2", name: "Activation" },
      { id: WORKSPACE_A, name: "Growth" },
    ]);
    expect(await directory.list(TENANT_B as TenantId)).toEqual([
      { id: WORKSPACE_B, name: "Growth" },
    ]);
  });
});
