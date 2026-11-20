import type { ConnectorManifest, TenantId, UserId } from "@aep/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuditEventInput } from "../members/member-ports.ts";
import type { SealedSecret, SecretOpener, SecretSealer } from "../secrets/secret-box.ts";
import { tokenContext } from "./connection-jobs.ts";
import { connectorGateway, toolName } from "./connector-gateway.ts";
import {
  McpUnauthorizedError,
  RefreshRefusedError,
  type ConnectionScope,
  type ConnectorOAuth,
  type McpToolResult,
  type McpTools,
} from "./connector-ports.ts";
import { InMemoryConnections, InMemoryConnectorClients } from "./in-memory-connections.ts";

const TENANT = "0a000000-0000-4000-8000-000000000001" as TenantId;
const ALICE: ConnectionScope = {
  tenantId: TENANT,
  userId: "0a000000-0000-4000-8000-0000000000aa" as UserId,
};
const BOB: ConnectionScope = {
  tenantId: TENANT,
  userId: "0a000000-0000-4000-8000-0000000000ab" as UserId,
};
const NOW = new Date("2026-11-16T00:00:00Z");
const REDIRECT = "http://127.0.0.1:3001/connections/oauth/callback";
const THREAD = "0a000000-0000-4000-8000-0000000000f1";

const manifest: ConnectorManifest = {
  id: "analytics",
  name: "Analytics",
  description: "Funnels",
  servers: [{ id: "us", label: "US", url: "https://mcp.example.com/mcp" }],
  auth: { type: "oauth2", registration: "dynamic", scopes: ["read", "offline_access"] },
  tools: [
    { name: "query", class: "read" },
    { name: "manage", class: "write" },
  ],
  egressHosts: ["mcp.example.com"],
  sources: [{ claim: "x", url: "https://example.com", checkedOn: "2026-11-16" }],
};

const box: SecretSealer & SecretOpener = {
  seal: (plaintext, context) => `sealed(${context})(${plaintext})` as SealedSecret,
  open: (sealed, context) => {
    const prefix = `sealed(${context})(`;
    if (!sealed.startsWith(prefix)) throw new Error("wrong context");
    return sealed.slice(prefix.length, -1);
  },
};
const sealed = (scope: ConnectionScope, value: string, kind: "access" | "refresh") =>
  box.seal(value, tokenContext(scope.tenantId, scope.userId, manifest.id, kind));

type Setup = {
  /** Which access tokens the server accepts. */
  accepted: Set<string>;
  refreshes: string[];
  refuseRefresh: boolean;
  calls: { token: string; name: string; input: unknown }[];
  result: McpToolResult;
  hang: boolean;
};

let connections: InMemoryConnections;
let clients: InMemoryConnectorClients;
let audit: AuditEventInput[];
let setup: Setup;

const oauth: ConnectorOAuth = {
  register: () => Promise.reject(new Error("not used")),
  authorizationUrl: () => Promise.reject(new Error("not used")),
  exchange: () => Promise.reject(new Error("not used")),
  refresh: (_m, _r, refreshToken) => {
    setup.refreshes.push(refreshToken);
    if (setup.refuseRefresh) return Promise.reject(new RefreshRefusedError(manifest.id));
    const n = setup.refreshes.length;
    setup.accepted.add(`at-${String(n)}`);
    return Promise.resolve({
      accessToken: `at-${String(n)}`,
      refreshToken: `rt-${String(n)}`,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
  },
  revoke: () => Promise.resolve(),
};

const mcp: McpTools = {
  list: (_m, _s, token) =>
    setup.accepted.has(token)
      ? Promise.resolve([
          { name: "query", description: "Run a query.", inputSchema: { type: "object" } },
          { name: "manage", description: "Change charts.", inputSchema: { type: "object" } },
          {
            name: "export_all",
            description: "Not in the manifest.",
            inputSchema: { type: "object" },
          },
        ])
      : Promise.reject(new McpUnauthorizedError(manifest.id)),
  call: (_m, _s, token, call, signal) => {
    if (!setup.accepted.has(token)) return Promise.reject(new McpUnauthorizedError(manifest.id));
    setup.calls.push({ token, ...call });
    if (setup.hang) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    }
    return Promise.resolve(setup.result);
  },
};

const gateway = (limits: { callMs?: number; resultChars?: number } = {}) =>
  connectorGateway({
    catalog: { manifests: [manifest], redirectUri: REDIRECT },
    connections,
    clients,
    oauth,
    mcp,
    box,
    audit: {
      record: (_tenant, event) => {
        audit.push(event);
        return Promise.resolve();
      },
    },
    now: () => NOW,
    limits,
  });

async function connect(scope: ConnectionScope, expiresAt = new Date(NOW.getTime() + 3_600_000)) {
  await connections.saveTokens(
    scope,
    { connectorId: manifest.id, serverId: "us" },
    {
      accessToken: sealed(scope, "at-0", "access"),
      refreshToken: sealed(scope, "rt-0", "refresh"),
      expiresAt,
    },
    NOW,
    { type: "connection.connected", actorId: scope.userId, subjectId: scope.userId, payload: {} },
  );
}

const signal = () => new AbortController().signal;
const call = (name: string, scope = ALICE, g = gateway()) =>
  g.call(scope, { name, input: { q: "signups" }, threadId: THREAD }, signal());

beforeEach(async () => {
  connections = new InMemoryConnections(() => NOW);
  clients = new InMemoryConnectorClients();
  await clients.save({
    connectorId: manifest.id,
    serverId: "us",
    redirectUri: REDIRECT,
    issuer: "https://auth.example.com",
    clientId: "client-us",
    details: {},
  });
  audit = [];
  setup = {
    accepted: new Set(["at-0"]),
    refreshes: [],
    refuseRefresh: false,
    calls: [],
    result: { text: "funnel: 12400 -> 4960", isError: false },
    hang: false,
  };
});

describe("connectorGateway.tools", () => {
  it("offers only the read tools of the manifest that the server lists", async () => {
    await connect(ALICE);
    const { tools, unavailable } = await gateway().tools(ALICE, signal());
    expect(tools.map((t) => t.name)).toEqual([toolName("analytics", "query")]);
    expect(tools[0]?.description).toContain("Analytics, through the person's own connection.");
    expect(unavailable).toEqual([]);
  });

  it("offers nothing to a person who is not connected, whoever else is", async () => {
    await connect(ALICE);
    expect((await gateway().tools(BOB, signal())).tools).toEqual([]);
  });

  it("reports a connection whose refresh token was refused as expired", async () => {
    await connect(ALICE, new Date(NOW.getTime() - 1));
    setup.refuseRefresh = true;
    const { tools, unavailable } = await gateway().tools(ALICE, signal());
    expect(tools).toEqual([]);
    expect(unavailable).toEqual([{ connectorId: "analytics", reason: "expired" }]);
    expect((await connections.list(ALICE))[0]?.status).toBe("expired");
  });
});

describe("connectorGateway.call", () => {
  it("calls a read tool with the person's token and audits it, without the token", async () => {
    await connect(ALICE);
    const result = await call(toolName("analytics", "query"));
    expect(result).toEqual({
      connectorId: "analytics",
      tool: "query",
      outcome: "ok",
      content: "funnel: 12400 -> 4960",
      truncated: false,
    });
    expect(setup.calls).toEqual([{ token: "at-0", name: "query", input: { q: "signups" } }]);
    expect(audit).toMatchObject([
      {
        type: "connector.tool_called",
        actorId: ALICE.userId,
        payload: {
          connectorId: "analytics",
          tool: "query",
          class: "read",
          outcome: "ok",
          threadId: THREAD,
        },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain("at-0");
  });

  it("refuses a write tool and a tool outside the manifest, and audits the refusals", async () => {
    await connect(ALICE);
    const write = await call(toolName("analytics", "manage"));
    const unknown = await call(toolName("analytics", "export_all"));
    const foreign = await call("other__query");
    expect([write.outcome, unknown.outcome, foreign.outcome]).toEqual([
      "refused",
      "refused",
      "refused",
    ]);
    expect(setup.calls).toEqual([]);
    expect(audit.map((a) => [a.payload["tool"], a.payload["outcome"]])).toEqual([
      ["manage", "refused"],
      ["export_all", "refused"],
      ["query", "refused"],
    ]);
  });

  it("refreshes an access token about to expire, and stores the new tokens sealed", async () => {
    await connect(ALICE, new Date(NOW.getTime() + 10_000));
    expect((await call(toolName("analytics", "query"))).outcome).toBe("ok");
    expect(setup.refreshes).toEqual(["rt-0"]);
    expect(setup.calls[0]?.token).toBe("at-1");
    const stored = await connections.tokens(ALICE, manifest.id);
    expect(stored?.accessToken).toBe(sealed(ALICE, "at-1", "access"));
    expect(stored?.refreshToken).toBe(sealed(ALICE, "rt-1", "refresh"));
  });

  it("refreshes once when the server refuses the token", async () => {
    await connect(ALICE);
    setup.accepted.delete("at-0");
    expect((await call(toolName("analytics", "query"))).outcome).toBe("ok");
    expect(setup.refreshes).toEqual(["rt-0"]);
  });

  it("marks the connection expired when the refresh token is refused", async () => {
    await connect(ALICE);
    setup.accepted.delete("at-0");
    setup.refuseRefresh = true;
    const result = await call(toolName("analytics", "query"));
    expect(result.outcome).toBe("expired");
    expect((await connections.list(ALICE))[0]?.status).toBe("expired");
  });

  it("uses the tokens another reply refreshed first instead of overwriting them", async () => {
    await connect(ALICE, new Date(NOW.getTime() + 10_000));
    const original = connections.replaceTokens.bind(connections);
    connections.replaceTokens = async (scope, connectorId, _expected, tokens, at) => {
      // Someone else's refresh lands between our read and our write.
      await original(
        scope,
        connectorId,
        sealed(ALICE, "at-0", "access"),
        {
          accessToken: sealed(ALICE, "at-9", "access"),
        },
        at,
      );
      setup.accepted.add("at-9");
      return original(scope, connectorId, _expected, tokens, at);
    };
    expect((await call(toolName("analytics", "query"))).outcome).toBe("ok");
    expect(setup.calls[0]?.token).toBe("at-9");
  });

  it("cuts a long result and says so", async () => {
    await connect(ALICE);
    setup.result = { text: "x".repeat(120), isError: false };
    const result = await call(toolName("analytics", "query"), ALICE, gateway({ resultChars: 100 }));
    expect(result.content).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(audit[0]?.payload["resultChars"]).toBe(120);
  });

  it("gives up on a call that takes too long", async () => {
    await connect(ALICE);
    setup.hang = true;
    const result = await call(toolName("analytics", "query"), ALICE, gateway({ callMs: 20 }));
    expect(result.outcome).toBe("timeout");
  });

  it("reports a tool error from the server as such", async () => {
    await connect(ALICE);
    setup.result = { text: "unknown project", isError: true };
    expect((await call(toolName("analytics", "query"))).outcome).toBe("tool_error");
  });

  it("answers not connected for a person without a connection", async () => {
    await connect(ALICE);
    expect((await call(toolName("analytics", "query"), BOB)).outcome).toBe("not_connected");
    expect(setup.calls).toEqual([]);
  });
});

describe("connectorGateway with approvals", () => {
  const approved = { id: "ap-1", connectorId: "analytics", tool: "manage", input: { chart: "c1" } };
  let spent: string[];
  let claims: string[];
  const withApprovals = () =>
    connectorGateway({
      catalog: { manifests: [manifest], redirectUri: REDIRECT },
      connections,
      clients,
      oauth,
      mcp,
      box,
      audit: { record: (_t, e) => (audit.push(e), Promise.resolve()) },
      approvals: {
        claim: (_scope, approvalId, call) => {
          const ok =
            approvalId === approved.id &&
            !spent.includes(approvalId) &&
            call.connectorId === approved.connectorId &&
            call.tool === approved.tool &&
            JSON.stringify(call.input) === JSON.stringify(approved.input);
          if (ok) claims.push(approvalId);
          return Promise.resolve(ok);
        },
        finish: (_scope, approvalId) => {
          spent.push(approvalId);
          return Promise.resolve();
        },
      },
      now: () => NOW,
    });
  const write = (input: unknown, approvalId?: string) =>
    withApprovals().call(
      ALICE,
      {
        name: toolName("analytics", "manage"),
        input,
        threadId: THREAD,
        ...(approvalId === undefined ? {} : { approvalId }),
      },
      signal(),
    );

  beforeEach(() => {
    spent = [];
    claims = [];
  });

  it("offers the write tool, saying it needs approval", async () => {
    await connect(ALICE);
    const { tools } = await withApprovals().tools(ALICE, signal());
    const manage = tools.find((t) => t.tool === "manage");
    expect(manage?.toolClass).toBe("write");
    expect(manage?.description).toContain("must approve each call");
  });

  it("runs a write only under its approval, with the approved arguments, once", async () => {
    await connect(ALICE);
    expect((await write({ chart: "c1" })).outcome).toBe("refused");
    expect((await write({ chart: "c2" }, "ap-1")).outcome).toBe("refused");
    expect((await write({ chart: "c1" }, "ap-1")).outcome).toBe("ok");
    expect((await write({ chart: "c1" }, "ap-1")).outcome).toBe("refused");
    expect(setup.calls).toEqual([{ token: "at-0", name: "manage", input: { chart: "c1" } }]);
    expect(audit.map((a) => [a.payload["outcome"], a.payload["approvalId"]])).toEqual([
      ["refused", null],
      ["refused", "ap-1"],
      ["ok", "ap-1"],
      ["refused", "ap-1"],
    ]);
  });

  it("spends the approval even when the call fails", async () => {
    await connect(ALICE);
    setup.hang = true;
    const g = connectorGateway({
      catalog: { manifests: [manifest], redirectUri: REDIRECT },
      connections,
      clients,
      oauth,
      mcp,
      box,
      audit: { record: () => Promise.resolve() },
      approvals: {
        claim: () => Promise.resolve(true),
        finish: (_s, approvalId) => (spent.push(approvalId), Promise.resolve()),
      },
      now: () => NOW,
      limits: { callMs: 20 },
    });
    const result = await g.call(
      ALICE,
      { name: toolName("analytics", "manage"), input: {}, threadId: THREAD, approvalId: "ap-9" },
      signal(),
    );
    expect(result.outcome).toBe("timeout");
    expect(spent).toEqual(["ap-9"]);
  });
});
