import { ConnectorListDto, ErrorDto, MemberConnectionListDto } from "@aep/contracts";
import type { ConnectorManifest } from "@aep/domain";
import { mcpOAuth } from "@aep/connector-mcp";
import { startMockMcp, type MockMcp } from "@aep/mock-mcp";
import { issueApiToken, PostgresThreadRepository, PostgresToolApprovals } from "@aep/postgres";
import type { MessageId, TenantId, ThreadId, UserId, WorkspaceId } from "@aep/domain";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
  WORKSPACE_A,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "@aep/postgres/testing";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { postgresDependencies } from "./dependencies.ts";

// Personal connections (#52). Alice (admin) and Carol (engineer) are members of tenant A; Vic is
// a viewer there; Bob is in tenant B. The mock MCP server plays Amplitude.

const USER_C = "0a000000-0000-4000-8000-0000000000ac";
const USER_V = "0a000000-0000-4000-8000-0000000000ad";
const REDIRECT = "http://127.0.0.1:3001/connections/oauth/callback";

let db: TestDatabase;
let mock: MockMcp;
let app: FastifyInstance;
let alice: string;
let carol: string;
let vic: string;
let bob: string;

beforeAll(async () => {
  [db, mock] = await Promise.all([startDatabase(), startMockMcp()]);
  const manifest: ConnectorManifest = {
    id: "mock-amplitude",
    name: "Mock Amplitude",
    description: "Funnels",
    servers: [{ id: "local", label: "Local", url: mock.mcpUrl }],
    auth: { type: "oauth2", registration: "dynamic", scopes: ["all:read", "offline_access"] },
    tools: [
      { name: "query_amplitude_data", class: "read" },
      { name: "manage_amp_entities", class: "write" },
    ],
    egressHosts: ["127.0.0.1"],
    sources: [{ claim: "mock", url: "https://example.com", checkedOn: "2026-11-15" }],
  };
  app = buildApp(
    postgresDependencies(
      db.app,
      {},
      {
        catalog: { manifests: [manifest], redirectUri: REDIRECT },
        oauth: mcpOAuth({ allowHttp: true }),
      },
    ),
    { logger: false },
  );
}, 180_000);

afterAll(async () => {
  await app.close();
  await Promise.all([db.stop(), mock.close()]);
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
  await sql`truncate jobs, connector_clients`.execute(db.admin);
  await db.admin
    .insertInto("users")
    .values([
      { id: USER_C, display_name: "Carol" },
      { id: USER_V, display_name: "Vic" },
    ])
    .execute();
  await db.admin
    .insertInto("memberships")
    .values([
      { tenant_id: TENANT_A, user_id: USER_C, role: "engineer" },
      { tenant_id: TENANT_A, user_id: USER_V, role: "viewer" },
    ])
    .execute();
  await db.admin
    .updateTable("memberships")
    .set({ role: "admin" })
    .where("user_id", "=", USER_A)
    .execute();
  const token = (tenantId: string, userId: string) =>
    issueApiToken(db.admin, { tenantId, userId, name: userId });
  [alice, carol, vic, bob] = await Promise.all([
    token(TENANT_A, USER_A),
    token(TENANT_A, USER_C),
    token(TENANT_A, USER_V),
    token(TENANT_B, USER_B),
  ]);
});

const call = (method: "GET" | "POST" | "DELETE", url: string, token: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });

/** Starts an authorization and approves it at the mock provider, as the browser would. */
const authorize = async (token: string) => {
  const started = await call("POST", "/v1/connectors/mock-amplitude/authorize", token, {});
  expect(started.statusCode).toBe(200);
  expect(started.headers["cache-control"]).toBe("no-store");
  const res = await fetch(started.json<{ authorizationUrl: string }>().authorizationUrl, {
    redirect: "manual",
  });
  const back = new URL(res.headers.get("location") ?? "");
  return {
    state: back.searchParams.get("state") ?? "",
    code: back.searchParams.get("code") ?? "",
  };
};

describe("/v1/connectors", () => {
  it("lists the connectors with their tools and the caller's connection", async () => {
    const response = await call("GET", "/v1/connectors", carol);
    expect(response.statusCode).toBe(200);
    expect(ConnectorListDto.parse(response.json()).items).toEqual([
      {
        id: "mock-amplitude",
        name: "Mock Amplitude",
        description: "Funnels",
        servers: [{ id: "local", label: "Local" }],
        tools: [
          { name: "query_amplitude_data", class: "read" },
          { name: "manage_amp_entities", class: "write" },
        ],
      },
    ]);
  });

  it("refuses viewers", async () => {
    const response = await call("GET", "/v1/connectors", vic);
    expect(response.statusCode).toBe(403);
    expect(ErrorDto.parse(response.json()).error.code).toBe("forbidden");
  });

  it("answers 404 for a connector that is not configured", async () => {
    expect((await call("POST", "/v1/connectors/nope/authorize", carol, {})).statusCode).toBe(404);
  });
});

describe("connecting", () => {
  it("records the answer and enqueues the exchange; the code goes to the worker, not back", async () => {
    const { state, code } = await authorize(carol);
    const answered = await call("POST", "/v1/connections/oauth/callback", carol, { state, code });
    expect(answered.statusCode).toBe(202);
    expect(answered.json()).toEqual({ connectorId: "mock-amplitude" });
    expect(answered.body).not.toContain(code);

    const jobs = await db.admin.selectFrom("jobs").select(["kind", "payload"]).execute();
    expect(jobs).toEqual([
      { kind: "connection.exchange", payload: { userId: USER_C, connectorId: "mock-amplitude" } },
    ]);
    const listed = ConnectorListDto.parse((await call("GET", "/v1/connectors", carol)).json());
    expect(listed.items[0]?.connection).toMatchObject({ status: "connecting" });
    // Alice sees none of it.
    const forAlice = ConnectorListDto.parse((await call("GET", "/v1/connectors", alice)).json());
    expect(forAlice.items[0]?.connection).toBeUndefined();
  });

  it("does not accept another member's answer, nor the same answer twice", async () => {
    const { state, code } = await authorize(carol);
    const stolen = await call("POST", "/v1/connections/oauth/callback", alice, { state, code });
    expect(stolen.statusCode).toBe(400);
    const fromBob = await call("POST", "/v1/connections/oauth/callback", bob, { state, code });
    expect(fromBob.statusCode).toBe(400);
    expect(
      (await call("POST", "/v1/connections/oauth/callback", carol, { state, code })).statusCode,
    ).toBe(202);
    expect(
      (await call("POST", "/v1/connections/oauth/callback", carol, { state, code })).statusCode,
    ).toBe(400);
  });

  it("registers the platform once per server, with the web callback as redirect URI", async () => {
    await authorize(carol);
    await authorize(alice);
    const registrations = mock.state.registrations.filter((r) => r.redirectUris.includes(REDIRECT));
    expect(registrations.length).toBeGreaterThanOrEqual(1);
    expect(
      await db.admin.selectFrom("connector_clients").select("client_id").execute(),
    ).toHaveLength(1);
  });

  it("shows a refusal at the provider as failed", async () => {
    const { state } = await authorize(carol);
    await call("POST", "/v1/connections/oauth/callback", carol, { state, error: "access_denied" });
    const listed = ConnectorListDto.parse((await call("GET", "/v1/connectors", carol)).json());
    expect(listed.items[0]?.connection).toMatchObject({ status: "failed", error: "access_denied" });
  });
});

describe("admins", () => {
  const connectCarol = async () => {
    // Stand in for the worker: a connected row with sealed placeholders.
    await db.admin
      .insertInto("connections")
      .values({
        tenant_id: TENANT_A,
        user_id: USER_C,
        connector_id: "mock-amplitude",
        server_id: "local",
        status: "connected",
        connected_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  };

  it("see who is connected and can disconnect a member; members cannot", async () => {
    await connectCarol();
    const listed = await call("GET", "/v1/admin/connections", alice);
    expect(MemberConnectionListDto.parse(listed.json()).items).toMatchObject([
      { userId: USER_C, connectorId: "mock-amplitude", status: "connected" },
    ]);
    expect((await call("GET", "/v1/admin/connections", carol)).statusCode).toBe(403);
    expect(
      (await call("DELETE", `/v1/admin/connections/${USER_C}/mock-amplitude`, carol)).statusCode,
    ).toBe(403);
    expect(
      (await call("DELETE", `/v1/admin/connections/${USER_C}/mock-amplitude`, alice)).statusCode,
    ).toBe(202);
    const jobs = await db.admin.selectFrom("jobs").select(["kind", "payload"]).execute();
    expect(jobs).toMatchObject([
      {
        kind: "connection.disconnect",
        payload: { userId: USER_C, reason: "admin", actorId: USER_A },
      },
    ]);
  });

  it("members disconnect their own connection only", async () => {
    await connectCarol();
    expect((await call("DELETE", "/v1/connections/mock-amplitude", alice)).statusCode).toBe(404);
    expect((await call("DELETE", "/v1/connections/mock-amplitude", carol)).statusCode).toBe(202);
  });
});

describe("deciding a write call paused in a thread", () => {
  const THREAD = "0a000000-0000-4000-8000-00000000c001" as ThreadId;
  const MESSAGE = "0a000000-0000-4000-8000-00000000d001" as MessageId;
  const PAUSE = "0a000000-0000-4000-8000-00000000e001";
  const APPROVAL = "0a000000-0000-4000-8000-00000000f001";
  const carolScope = { tenantId: TENANT_A as TenantId, userId: USER_C as UserId };

  beforeEach(async () => {
    const threads = new PostgresThreadRepository(db.app);
    // Carol's thread, shared with the workspace: Alice and Vic can read it.
    await threads.insert({
      tenantId: TENANT_A as TenantId,
      workspaceId: WORKSPACE_A as WorkspaceId,
      id: THREAD,
      ownerId: USER_C as UserId,
      title: "Charts",
      visibility: { kind: "workspace" },
      createdAt: new Date(),
    });
    await threads.appendMessage(
      carolScope,
      {
        tenantId: TENANT_A as TenantId,
        threadId: THREAD,
        id: MESSAGE,
        role: "user",
        authorId: USER_C as UserId,
        content: "Delete the old chart",
        createdAt: new Date(),
      },
      { type: "message.created", payload: { messageId: MESSAGE }, actor: { kind: "human" } },
    );
    await new PostgresToolApprovals(db.app).pause(
      carolScope,
      {
        id: PAUSE,
        threadId: THREAD,
        messageId: MESSAGE,
        requestedBy: USER_C as UserId,
        snapshot: { turns: [], callOrder: ["c1"], answered: [], text: "", round: 0, sources: [] },
        approvals: [
          {
            id: APPROVAL,
            pauseId: PAUSE,
            callId: "c1",
            connectorId: "mock-amplitude",
            tool: "manage_amp_entities",
            input: { action: "delete" },
            status: "pending",
          },
        ],
      },
      [],
      new Date(),
    );
  });

  const decide = (token: string, approvalId = APPROVAL, decision = "approve") =>
    call("POST", `/v1/threads/${THREAD}/tool-approvals/${approvalId}`, token, { decision });

  it("lets the person whose connection it is approve, and continues the reply", async () => {
    const response = await decide(carol);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ complete: true });
    const jobs = await db.admin.selectFrom("jobs").select(["kind", "payload"]).execute();
    expect(jobs).toEqual([
      {
        kind: "thread.reply",
        payload: { threadId: THREAD, messageId: MESSAGE, requestedBy: USER_C, pauseId: PAUSE },
      },
    ]);
    expect((await decide(carol, APPROVAL, "reject")).statusCode).toBe(409);
  });

  it("refuses everyone else, including the members who can read the thread", async () => {
    expect((await decide(alice)).statusCode).toBe(404);
    expect((await decide(vic)).statusCode).toBe(403);
    expect((await decide(bob)).statusCode).toBe(404);
    expect((await decide(carol, "not-a-uuid")).statusCode).toBe(404);
    expect((await decide(carol, APPROVAL, "maybe")).statusCode).toBe(400);
    expect(await db.admin.selectFrom("jobs").select("kind").execute()).toEqual([]);
  });
});
