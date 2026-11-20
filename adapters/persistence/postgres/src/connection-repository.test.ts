import type { AuditEventInput, NewJob } from "@aep/application";
import type { TenantId, UserId } from "@aep/domain";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresConnections, PostgresConnectorClients } from "./connection-repository.ts";
import { PostgresAuditLog, PostgresMemberRepository } from "./member-repository.ts";
import { withTenantUser } from "./tenant-session.ts";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "./test-support.ts";

// A second member of tenant A: the separation that matters here is between members of one
// organization (ADR-015), not only between tenants.
const USER_A2 = "0a000000-0000-4000-8000-0000000000a2";
const NOW = new Date("2026-11-15T00:00:00Z");
const LATER = new Date("2099-01-01T00:00:00Z");

const alice = { tenantId: TENANT_A as TenantId, userId: USER_A as UserId };
const carol = { tenantId: TENANT_A as TenantId, userId: USER_A2 as UserId };
const bob = { tenantId: TENANT_B as TenantId, userId: USER_B as UserId };

const job = (connectorId: string, key: string): NewJob => ({
  tenantId: TENANT_A as TenantId,
  kind: "connection.test",
  idempotencyKey: `${connectorId}:${key}`,
  payload: { connectorId },
});
const connected: AuditEventInput = {
  type: "connection.connected",
  actorId: USER_A as UserId,
  subjectId: USER_A as UserId,
  payload: { connectorId: "amplitude" },
};

let db: TestDatabase;
let repo: PostgresConnections;

beforeAll(async () => {
  db = await startDatabase();
  repo = new PostgresConnections(db.app);
}, 180_000);

afterAll(async () => {
  await db.stop();
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
  await sql`truncate jobs, connector_clients`.execute(db.admin);
  await db.admin.insertInto("users").values({ id: USER_A2, display_name: "Carol" }).execute();
  await db.admin
    .insertInto("memberships")
    .values({ tenant_id: TENANT_A, user_id: USER_A2, role: "engineer" })
    .execute();
});

const connectAlice = async () => {
  await repo.startAuthorization(alice, {
    connectorId: "amplitude",
    serverId: "us",
    state: "state-a",
    codeVerifier: "verifier-a",
    expiresAt: LATER,
  });
  await repo.answerAuthorization(alice, "state-a", { code: "code-a" }, NOW, (c) => job(c, "x"));
  await repo.saveTokens(
    alice,
    { connectorId: "amplitude", serverId: "us" },
    { accessToken: "sealed-access", refreshToken: "sealed-refresh", expiresAt: LATER },
    NOW,
    connected,
  );
};

describe("PostgresConnections", () => {
  it("goes from started to answered (with the job) to connected", async () => {
    await repo.startAuthorization(alice, {
      connectorId: "amplitude",
      serverId: "us",
      state: "state-a",
      codeVerifier: "verifier-a",
      expiresAt: LATER,
    });
    expect(await repo.list(alice)).toEqual([]);
    const answered = await repo.answerAuthorization(alice, "state-a", { code: "c" }, NOW, (c) =>
      job(c, "x"),
    );
    expect(answered).toEqual({ connectorId: "amplitude" });
    expect(await repo.list(alice)).toMatchObject([{ status: "connecting" }]);
    expect(await db.admin.selectFrom("jobs").select("kind").execute()).toEqual([
      { kind: "connection.test" },
    ]);
    expect(await repo.answeredAuthorization(alice, "amplitude")).toMatchObject({
      code: "c",
      codeVerifier: "verifier-a",
    });
    // Answering again does nothing.
    expect(
      await repo.answerAuthorization(alice, "state-a", { code: "c2" }, NOW, (c) => job(c, "y")),
    ).toBeUndefined();

    await repo.saveTokens(
      alice,
      { connectorId: "amplitude", serverId: "us" },
      { accessToken: "sealed-access" },
      NOW,
      connected,
    );
    expect(await repo.list(alice)).toMatchObject([{ status: "connected", serverId: "us" }]);
    expect(await repo.answeredAuthorization(alice, "amplitude")).toBeUndefined();
  });

  it("refuses an expired authorization", async () => {
    await repo.startAuthorization(alice, {
      connectorId: "amplitude",
      serverId: "us",
      state: "state-old",
      codeVerifier: "v",
      expiresAt: new Date(NOW.getTime() - 1),
    });
    expect(
      await repo.answerAuthorization(alice, "state-old", { code: "c" }, NOW, (c) => job(c, "x")),
    ).toBeUndefined();
  });

  it("does not let another member of the tenant answer, list or read the tokens", async () => {
    await repo.startAuthorization(alice, {
      connectorId: "amplitude",
      serverId: "us",
      state: "state-a",
      codeVerifier: "verifier-a",
      expiresAt: LATER,
    });
    expect(
      await repo.answerAuthorization(carol, "state-a", { code: "stolen" }, NOW, (c) => job(c, "x")),
    ).toBeUndefined();
    await repo.answerAuthorization(alice, "state-a", { code: "code-a" }, NOW, (c) => job(c, "x"));
    await repo.saveTokens(
      alice,
      { connectorId: "amplitude", serverId: "us" },
      { accessToken: "sealed-access" },
      NOW,
      connected,
    );
    expect(await repo.list(carol)).toEqual([]);
    expect(await repo.tokens(carol, "amplitude")).toBeUndefined();
    expect(await repo.tokens(bob, "amplitude")).toBeUndefined();
    expect(await repo.tokens(alice, "amplitude")).toMatchObject({ accessToken: "sealed-access" });
  });

  it("enforces it in the database, whatever the query asks for", async () => {
    await connectAlice();
    const asCarol = (table: "connections" | "connection_tokens" | "connection_authorizations") =>
      withTenantUser(db.app, carol, (trx) => trx.selectFrom(table).selectAll().execute());
    expect(await asCarol("connections")).toEqual([]);
    expect(await asCarol("connection_tokens")).toEqual([]);
    // Even with the admin flag, tokens stay with their owner.
    const tokensAsAdmin = await withTenantUser(db.app, carol, async (trx) => {
      await sql`select set_config('app.connection_admin', 'on', true)`.execute(trx);
      return trx.selectFrom("connection_tokens").selectAll().execute();
    });
    expect(tokensAsAdmin).toEqual([]);
  });

  it("shows admins every member's connection status, but not another tenant's", async () => {
    await connectAlice();
    expect(await repo.listAll(TENANT_A as TenantId)).toMatchObject([
      { userId: USER_A, connectorId: "amplitude", status: "connected" },
    ]);
    expect(await repo.listAll(TENANT_B as TenantId)).toEqual([]);
  });

  it("marks a disconnect with its job, and removes everything when done", async () => {
    await connectAlice();
    expect(await repo.requestDisconnect(carol, "amplitude", NOW, job("amplitude", "c"))).toBe(
      false,
    );
    expect(
      await repo.requestDisconnectAsAdmin(
        TENANT_A as TenantId,
        USER_A as UserId,
        "amplitude",
        NOW,
        job("amplitude", "d"),
      ),
    ).toBe(true);
    expect(await repo.list(alice)).toMatchObject([{ status: "disconnecting" }]);
    await repo.remove(alice, "amplitude", { ...connected, type: "connection.disconnected" });
    expect(await repo.list(alice)).toEqual([]);
    expect(await repo.tokens(alice, "amplitude")).toBeUndefined();
    const audit = await db.admin.selectFrom("audit_events").select("type").execute();
    expect(audit.map((a) => a.type)).toEqual(["connection.connected", "connection.disconnected"]);
  });

  it("disconnects every connection of a member who is disabled", async () => {
    await connectAlice();
    const members = new PostgresMemberRepository(db.app);
    await db.admin
      .updateTable("memberships")
      .set({ role: "admin" })
      .where("user_id", "=", USER_A2)
      .execute();
    const result = await members.update(
      TENANT_A as TenantId,
      {
        userId: USER_A as UserId,
        displayName: "Alice",
        email: null,
        role: "planner",
        disabled: false,
        passwordLogin: false,
        createdAt: NOW,
      },
      { disabled: true },
      [
        {
          type: "member.disabled",
          actorId: USER_A2 as UserId,
          subjectId: USER_A as UserId,
          payload: {},
        },
      ],
    );
    expect(result.ok).toBe(true);
    expect(await repo.list(alice)).toMatchObject([{ status: "disconnecting" }]);
    const jobs = await db.admin.selectFrom("jobs").select(["kind", "payload"]).execute();
    expect(jobs.filter((j) => j.kind === "connection.disconnect")).toMatchObject([
      { payload: { userId: USER_A, connectorId: "amplitude", reason: "member_disabled" } },
    ]);
  });
});

describe("refreshing tokens", () => {
  it("replaces the tokens only while the access token is the one read", async () => {
    await connectAlice();
    expect(
      await repo.replaceTokens(
        alice,
        "amplitude",
        "sealed-access",
        { accessToken: "sealed-2", refreshToken: "sealed-r2" },
        NOW,
      ),
    ).toBe(true);
    // A second refresh that read the old token lost the race.
    expect(
      await repo.replaceTokens(
        alice,
        "amplitude",
        "sealed-access",
        { accessToken: "sealed-3" },
        NOW,
      ),
    ).toBe(false);
    expect(await repo.tokens(alice, "amplitude")).toMatchObject({
      accessToken: "sealed-2",
      refreshToken: "sealed-r2",
    });
    // Nor can another member replace them.
    expect(
      await repo.replaceTokens(carol, "amplitude", "sealed-2", { accessToken: "x" }, NOW),
    ).toBe(false);
  });

  it("marks a connection expired, for its person only", async () => {
    await connectAlice();
    await repo.markExpired(carol, "amplitude", NOW);
    expect(await repo.list(alice)).toMatchObject([{ status: "connected" }]);
    await repo.markExpired(alice, "amplitude", NOW);
    expect(await repo.list(alice)).toMatchObject([{ status: "expired" }]);
  });
});

it("records connector tool calls in the audit log (migration 0017)", async () => {
  await new PostgresAuditLog(db.app).record(TENANT_A as TenantId, {
    type: "connector.tool_called",
    actorId: USER_A as UserId,
    subjectId: USER_A as UserId,
    payload: {
      connectorId: "amplitude",
      tool: "query_amplitude_data",
      class: "read",
      outcome: "ok",
    },
  });
  const rows = await db.admin.selectFrom("audit_events").select("type").execute();
  expect(rows.map((r) => r.type)).toContain("connector.tool_called");
});

describe("PostgresConnectorClients", () => {
  it("keeps the first registration when two race", async () => {
    const clients = new PostgresConnectorClients(db.app);
    const base = {
      connectorId: "amplitude",
      serverId: "us",
      redirectUri: "https://aep.example.com/connections/oauth/callback",
      issuer: "https://mcp.amplitude.com",
      details: { tokenEndpoint: "https://mcp.amplitude.com/token" },
    };
    await clients.save({ ...base, clientId: "first" });
    expect((await clients.save({ ...base, clientId: "second" })).clientId).toBe("first");
    expect(await clients.find("amplitude", "eu", base.redirectUri)).toBeUndefined();
  });
});
