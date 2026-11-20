import {
  AcceptancePacketDto,
  ErrorDto,
  MissionDto,
  MissionEventListDto,
  MissionListDto,
  PlanDto,
  WorkspaceListDto,
} from "@aep/contracts";
import { buildAcceptancePacket, type MissionId, type TenantId } from "@aep/domain";
import { issueApiToken, PostgresMissionRepository } from "@aep/postgres";
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
} from "@aep/postgres/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { postgresDependencies } from "./dependencies.ts";

let db: TestDatabase;
let app: FastifyInstance;
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  db = await startDatabase();
  app = buildApp(postgresDependencies(db.app), { logger: false });
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
  tokenA = await issueApiToken(db.admin, { tenantId: TENANT_A, userId: USER_A, name: "a" });
  tokenB = await issueApiToken(db.admin, { tenantId: TENANT_B, userId: USER_B, name: "b" });
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function createAs(token: string, workspaceId: string, title = "Improve signup") {
  const response = await app.inject({
    method: "POST",
    url: "/v1/missions",
    headers: auth(token),
    payload: { workspaceId, title },
  });
  return { status: response.statusCode, body: response.json<unknown>() };
}

describe("health", () => {
  it("answers without authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("GET /v1/workspaces", () => {
  it("lists the caller's tenant's workspaces only", async () => {
    for (const [token, id] of [
      [tokenA, WORKSPACE_A],
      [tokenB, WORKSPACE_B],
    ] as const) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/workspaces",
        headers: auth(token),
      });
      expect(response.statusCode).toBe(200);
      expect(WorkspaceListDto.parse(response.json())).toEqual({ items: [{ id, name: "Growth" }] });
    }
  });

  it("requires authentication", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/workspaces" })).statusCode).toBe(401);
  });
});

describe("authentication", () => {
  it.each([
    ["no header", {}],
    ["an unknown token", auth(`aep_${"A".repeat(43)}`)],
    ["a non-bearer scheme", { authorization: "Basic dXNlcjpwYXNz" }],
  ])("rejects %s with 401", async (_, headers) => {
    const response = await app.inject({ method: "GET", url: "/v1/missions", headers });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(ErrorDto.parse(response.json()).error.code).toBe("unauthorized");
  });
});

describe("POST /v1/missions", () => {
  it("creates a DRAFT mission in the caller's tenant", async () => {
    const { status, body } = await createAs(tokenA, WORKSPACE_A);
    expect(status).toBe(201);
    expect(MissionDto.parse(body)).toMatchObject({
      workspaceId: WORKSPACE_A,
      title: "Improve signup",
      status: "DRAFT",
      version: 1,
      createdBy: USER_A,
    });
  });

  it("accepts the GitHub issue the mission works on, and returns it", async () => {
    const source = {
      kind: "github_issue",
      owner: "acme",
      repo: "shop",
      issueNumber: 12,
      baseBranch: "main",
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/missions",
      headers: auth(tokenA),
      payload: { workspaceId: WORKSPACE_A, title: "Greeting", source },
    });
    expect(created.statusCode).toBe(201);
    const { id } = MissionDto.parse(created.json());
    const read = await app.inject({
      method: "GET",
      url: `/v1/missions/${id}`,
      headers: auth(tokenA),
    });
    expect(MissionDto.parse(read.json()).source).toEqual(source);
  });

  it.each([
    ["an unknown kind", { kind: "gitlab_issue" }],
    ["an extra field", { token: "x" }],
    ["a non-integer issue", { issueNumber: 1.5 }],
    ["a path in the owner", { owner: "../etc" }],
  ])("answers 400 for a source with %s", async (_, change) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/missions",
      headers: auth(tokenA),
      payload: {
        workspaceId: WORKSPACE_A,
        title: "Greeting",
        source: {
          kind: "github_issue",
          owner: "acme",
          repo: "shop",
          issueNumber: 12,
          baseBranch: "main",
          ...change,
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(ErrorDto.parse(response.json()).error.code).toBe("invalid_request");
  });

  it("rejects a client-supplied tenantId instead of ignoring it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/missions",
      headers: auth(tokenA),
      payload: { workspaceId: WORKSPACE_A, title: "x", tenantId: TENANT_B },
    });
    expect(response.statusCode).toBe(400);
    expect(ErrorDto.parse(response.json()).error.code).toBe("invalid_request");
  });

  it("answers 404 for another tenant's workspace", async () => {
    const { status, body } = await createAs(tokenA, WORKSPACE_B);
    expect(status).toBe(404);
    expect(ErrorDto.parse(body).error.code).toBe("not_found");
  });

  it("answers 400 for an empty title", async () => {
    const { status } = await createAs(tokenA, WORKSPACE_A, "  ");
    expect(status).toBe(400);
  });

  it("answers 403 for a viewer", async () => {
    await db.admin
      .updateTable("memberships")
      .set({ role: "viewer" })
      .where("user_id", "=", USER_A)
      .execute();
    const { status, body } = await createAs(tokenA, WORKSPACE_A);
    expect(status).toBe(403);
    expect(ErrorDto.parse(body).error.code).toBe("forbidden");
  });

  it("answers 400 for a malformed JSON body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/missions",
      headers: { ...auth(tokenA), "content-type": "application/json" },
      payload: "{",
    });
    expect(response.statusCode).toBe(400);
    expect(ErrorDto.parse(response.json()).error.code).toBe("invalid_request");
  });
});

describe("tenant isolation over HTTP (PRD §8-A)", () => {
  let missionOfB: string;

  beforeEach(async () => {
    const { body } = await createAs(tokenB, WORKSPACE_B, "B's secret plan");
    missionOfB = MissionDto.parse(body).id;
  });

  it("answers a guessed id of another tenant exactly like a missing id", async () => {
    const guessed = await app.inject({
      method: "GET",
      url: `/v1/missions/${missionOfB}`,
      headers: auth(tokenA),
    });
    const missing = await app.inject({
      method: "GET",
      url: "/v1/missions/0a000000-0000-4000-8000-0000000000ee",
      headers: auth(tokenA),
    });
    expect(guessed.statusCode).toBe(404);
    expect(guessed.body).toBe(missing.body);
  });

  it("lets the owning tenant read it", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/missions/${missionOfB}`,
      headers: auth(tokenB),
    });
    expect(response.statusCode).toBe(200);
    expect(MissionDto.parse(response.json()).title).toBe("B's secret plan");
  });

  it("never lists another tenant's missions, even when filtering by its workspace", async () => {
    await createAs(tokenA, WORKSPACE_A, "A's plan");
    const all = await app.inject({ method: "GET", url: "/v1/missions", headers: auth(tokenA) });
    const filtered = await app.inject({
      method: "GET",
      url: `/v1/missions?workspaceId=${WORKSPACE_B}`,
      headers: auth(tokenA),
    });

    expect(MissionListDto.parse(all.json()).items.map((m) => m.title)).toEqual(["A's plan"]);
    expect(MissionListDto.parse(filtered.json()).items).toEqual([]);
  });

  it("answers 404 for a malformed id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/missions/not-a-uuid",
      headers: auth(tokenA),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /v1/missions query validation", () => {
  it.each(["limit=0", "limit=abc", "unknown=1"])("answers 400 for %s", async (query) => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/missions?${query}`,
      headers: auth(tokenA),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("planning", () => {
  const source = {
    kind: "github_issue",
    owner: "acme",
    repo: "shop",
    issueNumber: 12,
    baseBranch: "main",
  };

  async function missionWith(token: string, workspaceId: string, withSource = true) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/missions",
      headers: auth(token),
      payload: { workspaceId, title: "Greeting", ...(withSource ? { source } : {}) },
    });
    return MissionDto.parse(response.json()).id;
  }

  const startPlanning = (token: string, id: string) =>
    app.inject({ method: "POST", url: `/v1/missions/${id}/plan`, headers: auth(token) });

  /** Simulates the planning job: stores plan `version` with SubmitPlan. */
  async function submitPlan(id: string, version: number, body: string) {
    const repo = new PostgresMissionRepository(db.app);
    const mission = await repo.findById(TENANT_A as TenantId, id as MissionId);
    if (mission === undefined) throw new Error("no mission");
    const recorded = await repo.recordTransition({
      mission,
      state: { status: "AWAITING_PLAN_APPROVAL", planVersion: version },
      event: { type: "SubmitPlan", payload: {}, actor: { kind: "agent", id: "claude" } },
      at: new Date(),
      plan: {
        tenantId: mission.tenantId,
        missionId: mission.id,
        version,
        body,
        author: { kind: "agent", id: "claude" },
        createdAt: new Date("2026-11-14T00:00:00Z"),
      },
    });
    if (!recorded.ok) throw new Error("submit failed");
  }

  it("starts planning (202) and enqueues one planning job", async () => {
    const id = await missionWith(tokenA, WORKSPACE_A);
    const response = await startPlanning(tokenA, id);
    expect(response.statusCode).toBe(202);
    expect(MissionDto.parse(response.json()).status).toBe("PLANNING");
    const again = await startPlanning(tokenA, id);
    expect(again.statusCode).toBe(409);
    expect(ErrorDto.parse(again.json()).error.code).toBe("conflict");
    const jobs = await db.admin.selectFrom("jobs").select(["kind", "tenant_id"]).execute();
    expect(jobs).toEqual([{ kind: "mission.plan", tenant_id: TENANT_A }]);
  });

  it("cancels: 200 when done at once, 202 while work stops, 409 when already cancelled", async () => {
    const cancel = (token: string, id: string) =>
      app.inject({ method: "POST", url: `/v1/missions/${id}/cancel`, headers: auth(token) });
    const draft = await missionWith(tokenA, WORKSPACE_A);
    expect((await cancel(tokenB, draft)).statusCode).toBe(404);
    const done = await cancel(tokenA, draft);
    expect(done.statusCode).toBe(200);
    expect(MissionDto.parse(done.json()).status).toBe("CANCELLED");
    expect((await cancel(tokenA, draft)).statusCode).toBe(409);

    const planning = await missionWith(tokenA, WORKSPACE_A);
    await startPlanning(tokenA, planning);
    const requested = await cancel(tokenA, planning);
    expect(requested.statusCode).toBe(202);
    expect(MissionDto.parse(requested.json()).status).toBe("CANCEL_REQUESTED");
  });

  it("answers 400 for a mission without a source", async () => {
    const id = await missionWith(tokenA, WORKSPACE_A, false);
    const response = await startPlanning(tokenA, id);
    expect(response.statusCode).toBe(400);
  });

  it("answers 403 for a viewer and 404 for another tenant", async () => {
    const id = await missionWith(tokenA, WORKSPACE_A);
    expect((await startPlanning(tokenB, id)).statusCode).toBe(404);
    await db.admin
      .updateTable("memberships")
      .set({ role: "viewer" })
      .where("user_id", "=", USER_A)
      .execute();
    expect((await startPlanning(tokenA, id)).statusCode).toBe(403);
    expect(await db.admin.selectFrom("jobs").select("id").execute()).toEqual([]);
  });

  it("serves the latest plan and each version, to the owning tenant only", async () => {
    const id = await missionWith(tokenA, WORKSPACE_A);
    const get = (token: string, path: string) =>
      app.inject({ method: "GET", url: `/v1/missions/${id}${path}`, headers: auth(token) });
    expect((await get(tokenA, "/plan")).statusCode).toBe(404);

    await startPlanning(tokenA, id);
    await submitPlan(id, 1, "## Summary\nAdd greet");
    const latest = await get(tokenA, "/plan");
    expect(latest.statusCode).toBe(200);
    expect(PlanDto.parse(latest.json())).toEqual({
      missionId: id,
      version: 1,
      body: "## Summary\nAdd greet",
      checksumSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      author: { kind: "agent", id: "claude" },
      createdAt: "2026-11-14T00:00:00.000Z",
    });
    expect(PlanDto.parse((await get(tokenA, "/plans/1")).json()).version).toBe(1);
    for (const path of ["/plans/2", "/plans/0", "/plans/abc", "/plans/1.0"]) {
      expect((await get(tokenA, path)).statusCode).toBe(404);
    }
    expect((await get(tokenB, "/plan")).statusCode).toBe(404);
    expect((await get(tokenB, "/plans/1")).statusCode).toBe(404);
  });
  describe("approval", () => {
    const decide = (token: string, id: string, action: string, payload: object) =>
      app.inject({
        method: "POST",
        url: `/v1/missions/${id}/plan/${action}`,
        headers: auth(token),
        payload,
      });

    async function awaitingApproval() {
      const id = await missionWith(tokenA, WORKSPACE_A);
      await startPlanning(tokenA, id);
      await submitPlan(id, 1, "## Summary\nAdd greet");
      return id;
    }

    it("approves the plan version and starts execution", async () => {
      const id = await awaitingApproval();
      const read = await app.inject({
        method: "GET",
        url: `/v1/missions/${id}`,
        headers: auth(tokenA),
      });
      expect(MissionDto.parse(read.json())).toMatchObject({
        status: "AWAITING_PLAN_APPROVAL",
        planVersion: 1,
      });

      const response = await decide(tokenA, id, "approve", { planVersion: 1, comment: "ok" });
      expect(response.statusCode).toBe(202);
      expect(MissionDto.parse(response.json())).toMatchObject({
        status: "EXECUTING",
        approvedPlanVersion: 1,
      });
      const approvals = await db.admin
        .selectFrom("approvals")
        .select(["subject", "subject_version", "decision", "decided_by", "comment"])
        .execute();
      expect(approvals).toEqual([
        {
          subject: "plan",
          subject_version: 1,
          decision: "approved",
          decided_by: USER_A,
          comment: "ok",
        },
      ]);
      const kinds = await db.admin
        .selectFrom("jobs")
        .select("kind")
        .orderBy("created_at")
        .execute();
      expect(kinds.map((j) => j.kind)).toEqual(["mission.plan", "mission.execute"]);
    });

    it("serves the audit trail to the owning tenant, after a seq", async () => {
      const id = await awaitingApproval();
      await decide(tokenA, id, "approve", { planVersion: 1 });
      const events = (path: string, token = tokenA) =>
        app.inject({
          method: "GET",
          url: `/v1/missions/${id}/events${path}`,
          headers: auth(token),
        });
      const all = MissionEventListDto.parse((await events("")).json()).items;
      expect(all.map((e) => [e.seq, e.type, e.actor.kind])).toEqual([
        [1, "StartPlanning", "human"],
        [2, "SubmitPlan", "agent"],
        [3, "ApprovePlan", "human"],
        [4, "StartExecution", "human"],
      ]);
      expect(all[2]?.actor.id).toBe(USER_A);
      expect(all[2]?.payload).toEqual({ planVersion: 1 });
      const later = MissionEventListDto.parse((await events("?after=2&limit=1")).json()).items;
      expect(later.map((e) => e.seq)).toEqual([3]);
      expect((await events("", tokenB)).statusCode).toBe(404);
      for (const query of ["?limit=0", "?after=-1", "?after=x", "?other=1"]) {
        expect((await events(query)).statusCode).toBe(400);
      }
    });

    it("serves the acceptance packet once verification passed, to the owning tenant", async () => {
      const id = await awaitingApproval();
      const get = (path: string, token = tokenA) =>
        app.inject({ method: "GET", url: `/v1/missions/${id}${path}`, headers: auth(token) });
      expect((await get("/acceptance-packet")).statusCode).toBe(404);

      await decide(tokenA, id, "approve", { planVersion: 1 });
      // Simulates mission.execute and mission.verify.
      const repo = new PostgresMissionRepository(db.app);
      const tenantId = TENANT_A as TenantId;
      const step = async (
        state: Parameters<typeof repo.recordTransition>[0]["state"],
        type: string,
        packet?: boolean,
      ) => {
        const mission = await repo.findById(tenantId, id as MissionId);
        if (mission === undefined) throw new Error("no mission");
        const recorded = await repo.recordTransition({
          mission,
          state,
          event: { type, payload: {}, actor: { kind: "system" } },
          at: new Date(),
          ...(packet === true
            ? {
                packet: buildAcceptancePacket({
                  tenantId,
                  missionId: mission.id,
                  version: 1,
                  createdAt: new Date("2026-11-14T12:00:00Z"),
                  title: mission.title,
                  source: {
                    kind: "github_issue",
                    owner: "acme",
                    repo: "shop",
                    issueNumber: 12,
                    baseBranch: "main",
                  },
                  plan: {
                    version: 1,
                    checksumSha256: "a".repeat(64),
                    body: "## Acceptance criteria\n- ok",
                  },
                  decisions: [],
                  pullRequest: {
                    number: 5,
                    url: "https://github.com/acme/shop/pull/5",
                    branch: "aep/x",
                    commitSha: "b".repeat(40),
                  },
                  files: {
                    files: [{ path: "a.js", additions: 1, deletions: 0 }],
                    truncated: false,
                  },
                  checks: [{ name: "node-test", state: "success", url: null }],
                  costUsd: 0.1,
                }),
              }
            : {}),
        });
        if (!recorded.ok) throw new Error("step failed");
      };
      await step({ status: "VERIFYING", approvedPlanVersion: 1 }, "CompleteExecution");
      await step(
        { status: "ACCEPTANCE_READY", approvedPlanVersion: 1, packetVersion: 1 },
        "PassVerification",
        true,
      );

      const mission = MissionDto.parse((await get("")).json());
      expect(mission).toMatchObject({
        status: "ACCEPTANCE_READY",
        approvedPlanVersion: 1,
        packetVersion: 1,
      });
      const latest = await get("/acceptance-packet");
      expect(latest.statusCode).toBe(200);
      const packet = AcceptancePacketDto.parse(latest.json());
      expect(packet).toMatchObject({
        missionId: id,
        version: 1,
        createdAt: "2026-11-14T12:00:00.000Z",
        content: { ci: { state: "success" }, diff: { additions: 1 }, costUsd: 0.1 },
      });
      expect(packet.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(AcceptancePacketDto.parse((await get("/acceptance-packets/1")).json()).version).toBe(
        1,
      );
      for (const path of ["/acceptance-packets/2", "/acceptance-packets/x"]) {
        expect((await get(path)).statusCode).toBe(404);
      }
      expect((await get("/acceptance-packet", tokenB)).statusCode).toBe(404);
    });

    it("answers 409 for a version that is not awaiting approval", async () => {
      const id = await awaitingApproval();
      const response = await decide(tokenA, id, "approve", { planVersion: 2 });
      expect(response.statusCode).toBe(409);
      expect(ErrorDto.parse(response.json()).error.code).toBe("conflict");
      expect(await db.admin.selectFrom("approvals").select("id").execute()).toEqual([]);
    });

    it("rejects the plan with a reason and plans again", async () => {
      const id = await awaitingApproval();
      const response = await decide(tokenA, id, "reject", {
        planVersion: 1,
        reason: "Add a test.",
      });
      expect(response.statusCode).toBe(202);
      expect(MissionDto.parse(response.json()).status).toBe("PLANNING");
      const jobs = await db.admin.selectFrom("jobs").select("kind").execute();
      expect(jobs.map((j) => j.kind)).toEqual(["mission.plan", "mission.plan"]);
    });

    it.each([
      ["approve", { planVersion: 0 }],
      ["approve", { planVersion: 1, extra: true }],
      ["reject", { planVersion: 1 }],
      ["reject", { planVersion: 1, reason: " " }],
    ])("answers 400 to %s with %j", async (action, payload) => {
      const id = await awaitingApproval();
      expect((await decide(tokenA, id, action, payload)).statusCode).toBe(400);
    });

    it("answers 403 for an engineer and 404 for another tenant", async () => {
      const id = await awaitingApproval();
      expect((await decide(tokenB, id, "approve", { planVersion: 1 })).statusCode).toBe(404);
      await db.admin
        .updateTable("memberships")
        .set({ role: "engineer" })
        .where("user_id", "=", USER_A)
        .execute();
      expect((await decide(tokenA, id, "approve", { planVersion: 1 })).statusCode).toBe(403);
      expect(
        (await decide(tokenA, id, "reject", { planVersion: 1, reason: "no" })).statusCode,
      ).toBe(403);
    });
  });
});
