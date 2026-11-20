import type { ConnectorManifest, Role, TenantId, UserId } from "@aep/domain";
import { describe, expect, it } from "vitest";
import type { Principal } from "../principal.ts";
import type { SealedSecret, SecretOpener, SecretSealer } from "../secrets/secret-box.ts";
import { connectionHandlers } from "./connection-handlers.ts";
import { DISCONNECT_JOB, EXCHANGE_JOB, tokenContext } from "./connection-jobs.ts";
import { connectionService } from "./connection-service.ts";
import type { ConnectorOAuth, TokenSet } from "./connector-ports.ts";
import { InMemoryConnections, InMemoryConnectorClients } from "./in-memory-connections.ts";

const TENANT = "0a000000-0000-4000-8000-000000000001" as TenantId;
const ALICE = "0a000000-0000-4000-8000-0000000000aa" as UserId;
const BOB = "0a000000-0000-4000-8000-0000000000ab" as UserId;
const NOW = new Date("2026-11-15T00:00:00Z");
const REDIRECT = "http://127.0.0.1:3001/connections/oauth/callback";

const principal = (userId: UserId, role: Role = "engineer"): Principal => ({
  tenantId: TENANT,
  userId,
  role,
});

const manifest: ConnectorManifest = {
  id: "analytics",
  name: "Analytics",
  description: "Funnels",
  servers: [
    { id: "us", label: "US", url: "https://mcp.example.com/mcp" },
    { id: "eu", label: "EU", url: "https://mcp.eu.example.com/mcp" },
  ],
  auth: { type: "oauth2", registration: "dynamic", scopes: ["read", "offline_access"] },
  tools: [{ name: "query", class: "read" }],
  egressHosts: ["mcp.example.com", "mcp.eu.example.com"],
  sources: [{ claim: "x", url: "https://example.com", checkedOn: "2026-11-15" }],
};

/** Reversible stand-in for the AES-GCM box: enough to check what is sealed with which context. */
const box: SecretSealer & SecretOpener = {
  seal: (plaintext, context) => `sealed(${context})(${plaintext})` as SealedSecret,
  open: (sealed, context) => {
    const prefix = `sealed(${context})(`;
    if (!sealed.startsWith(prefix)) throw new Error("wrong context");
    return sealed.slice(prefix.length, -1);
  },
};

function fakeOAuth() {
  const calls = {
    register: [] as string[],
    exchange: [] as { code: string; codeVerifier: string }[],
    revoke: [] as { value: string; hint: string }[],
  };
  let failExchange = false;
  const oauth: ConnectorOAuth = {
    register: (m, server, redirectUri) => {
      calls.register.push(server.id);
      return Promise.resolve({
        connectorId: m.id,
        serverId: server.id,
        redirectUri,
        issuer: `https://auth.${server.id}.example.com`,
        clientId: `client-${server.id}`,
        details: {},
      });
    },
    authorizationUrl: (_m, registration, request) =>
      Promise.resolve({
        url: `${registration.issuer}/authorize?state=${request.state}&scope=${request.scopes.join("+")}`,
        codeVerifier: `verifier-${request.state}`,
      }),
    exchange: (_m, _r, grant) => {
      calls.exchange.push(grant);
      if (failExchange)
        return Promise.reject(Object.assign(new Error("x"), { code: "invalid_grant" }));
      const tokens: TokenSet = {
        accessToken: `at-${grant.code}`,
        refreshToken: `rt-${grant.code}`,
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      };
      return Promise.resolve(tokens);
    },
    refresh: () => Promise.reject(new Error("not used")),
    revoke: (_m, _r, token) => {
      calls.revoke.push(token);
      return Promise.resolve();
    },
  };
  return { oauth, calls, failNextExchanges: () => (failExchange = true) };
}

function setup() {
  const connections = new InMemoryConnections(() => NOW);
  const clients = new InMemoryConnectorClients();
  const { oauth, calls, failNextExchanges } = fakeOAuth();
  const catalog = { manifests: [manifest], redirectUri: REDIRECT };
  let n = 0;
  const service = connectionService({
    catalog,
    connections,
    clients,
    oauth,
    newState: () => `state-${String(++n)}`,
    now: () => NOW,
  });
  const worker = connectionHandlers({ catalog, connections, clients, oauth, box, now: () => NOW });
  const runJobs = async () => {
    while (connections.jobs.length > 0) {
      const job = connections.jobs.shift();
      if (job === undefined) break;
      const handler = worker.handlers[job.kind];
      await handler?.(
        { id: "j", ...job, attempt: 1, maxAttempts: job.maxAttempts ?? 5, lastError: null },
        new AbortController().signal,
      );
    }
  };
  return { service, worker, connections, clients, calls, runJobs, failNextExchanges };
}

const connect = async (s: ReturnType<typeof setup>, who: UserId, serverId?: string) => {
  const started = await s.service.authorize(principal(who), "analytics", serverId);
  if (!started.ok) throw new Error("authorize failed");
  const state = new URL(started.value.url).searchParams.get("state") ?? "";
  const answered = await s.service.callback(principal(who), { state, code: `code-${state}` });
  expect(answered).toEqual({ ok: true, value: { connectorId: "analytics" } });
  return state;
};

describe("connecting", () => {
  it("registers once, sends the person to the provider, and seals the tokens in the worker", async () => {
    const s = setup();
    const state = await connect(s, ALICE);
    expect(s.connections.jobs.map((j) => j.kind)).toEqual([EXCHANGE_JOB]);
    expect((await s.service.list(principal(ALICE))).ok).toBe(true);
    expect((await s.connections.list(principal(ALICE)))[0]?.status).toBe("connecting");

    await s.runJobs();
    expect(s.calls.exchange).toEqual([
      { code: `code-${state}`, codeVerifier: `verifier-${state}` },
    ]);
    const stored = await s.connections.tokens(principal(ALICE), "analytics");
    expect(stored?.accessToken).toBe(
      `sealed(${tokenContext(TENANT, ALICE, "analytics", "access")})(at-code-${state})`,
    );
    const listed = await s.service.list(principal(ALICE));
    expect(listed.ok && listed.value[0]?.connection?.status).toBe("connected");
    expect(s.connections.audit.map((a) => a.type)).toEqual(["connection.connected"]);

    await connect(s, BOB);
    expect(s.calls.register).toEqual(["us"]);
  });

  it("registers separately for another server of the connector", async () => {
    const s = setup();
    await connect(s, ALICE, "eu");
    expect(s.calls.register).toEqual(["eu"]);
    expect(await s.service.authorize(principal(ALICE), "analytics", "apac")).toMatchObject({
      ok: false,
      error: { kind: "Invalid", field: "serverId" },
    });
  });

  it("does not let another person answer an authorization", async () => {
    const s = setup();
    const started = await s.service.authorize(principal(ALICE), "analytics", undefined);
    const state = started.ok ? (new URL(started.value.url).searchParams.get("state") ?? "") : "";
    expect(await s.service.callback(principal(BOB), { state, code: "stolen" })).toMatchObject({
      ok: false,
      error: { kind: "Invalid", field: "state" },
    });
    expect(s.connections.jobs).toEqual([]);
  });

  it("records a refusal at the provider as failed, without a job", async () => {
    const s = setup();
    const started = await s.service.authorize(principal(ALICE), "analytics", undefined);
    const state = started.ok ? (new URL(started.value.url).searchParams.get("state") ?? "") : "";
    await s.service.callback(principal(ALICE), { state, error: "access_denied" });
    expect(s.connections.jobs).toEqual([]);
    expect(await s.connections.list(principal(ALICE))).toMatchObject([
      { status: "failed", error: "access_denied" },
    ]);
  });

  it("marks the attempt failed when the exchange is refused, with the provider's code only", async () => {
    const s = setup();
    s.failNextExchanges();
    await connect(s, ALICE);
    await s.runJobs();
    expect(await s.connections.list(principal(ALICE))).toMatchObject([
      { status: "failed", error: "invalid_grant" },
    ]);
    expect(await s.connections.tokens(principal(ALICE), "analytics")).toBeUndefined();
  });

  it("refuses viewers and unknown connectors", async () => {
    const s = setup();
    expect(await s.service.list(principal(ALICE, "viewer"))).toMatchObject({
      ok: false,
      error: { kind: "Forbidden", action: "connector:use" },
    });
    expect(await s.service.authorize(principal(ALICE), "nope", undefined)).toMatchObject({
      ok: false,
      error: { kind: "NotFound", resource: "connector" },
    });
  });
});

describe("disconnecting", () => {
  it("revokes both tokens at the provider, then deletes them", async () => {
    const s = setup();
    const state = await connect(s, ALICE);
    await s.runJobs();
    expect(await s.service.disconnect(principal(ALICE), "analytics")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(s.connections.jobs.map((j) => j.kind)).toEqual([DISCONNECT_JOB]);
    await s.runJobs();
    expect(s.calls.revoke).toEqual([
      { value: `rt-code-${state}`, hint: "refresh_token" },
      { value: `at-code-${state}`, hint: "access_token" },
    ]);
    expect(await s.connections.list(principal(ALICE))).toEqual([]);
    expect(s.connections.audit.at(-1)).toMatchObject({
      type: "connection.disconnected",
      payload: { reason: "user", revoked: true },
    });
  });

  it("lets an admin see and disconnect a member's connection, but not a member", async () => {
    const s = setup();
    await connect(s, ALICE);
    await s.runJobs();
    expect(await s.service.listAll(principal(BOB))).toMatchObject({ ok: false });
    expect(await s.service.disconnectMember(principal(BOB), ALICE, "analytics")).toMatchObject({
      ok: false,
      error: { kind: "Forbidden", action: "connector:manage" },
    });
    const all = await s.service.listAll(principal(BOB, "admin"));
    expect(all.ok && all.value.map((c) => c.userId)).toEqual([ALICE]);
    await s.service.disconnectMember(principal(BOB, "admin"), ALICE, "analytics");
    await s.runJobs();
    expect(s.connections.audit.at(-1)).toMatchObject({
      type: "connection.disconnected",
      actorId: BOB,
      subjectId: ALICE,
      payload: { reason: "admin" },
    });
  });

  it("deletes the tokens even when revocation keeps failing", async () => {
    const s = setup();
    await connect(s, ALICE);
    await s.runJobs();
    await s.service.disconnect(principal(ALICE), "analytics");
    const job = s.connections.jobs.shift();
    if (job === undefined) throw new Error("no job");
    await s.worker.onDead[DISCONNECT_JOB]?.(
      { id: "j", ...job, attempt: 6, maxAttempts: 5, lastError: "revoke failed" },
      "revoke failed",
    );
    expect(await s.connections.tokens(principal(ALICE), "analytics")).toBeUndefined();
    expect(s.connections.audit.at(-1)).toMatchObject({ payload: { revoked: false } });
  });

  it("answers not found when there is nothing to disconnect", async () => {
    const s = setup();
    expect(await s.service.disconnect(principal(ALICE), "analytics")).toMatchObject({
      ok: false,
      error: { kind: "NotFound" },
    });
  });
});
