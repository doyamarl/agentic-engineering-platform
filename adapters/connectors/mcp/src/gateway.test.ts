import { randomBytes } from "node:crypto";
import {
  connectionHandlers,
  connectionService,
  connectorGateway,
  fakeModel,
  replyToMessage,
  threadService,
  type AuditEventInput,
  type ModelRequest,
  type ModelStreamEvent,
  type Principal,
} from "@aep/application";
import {
  InMemoryConnections,
  InMemoryConnectorClients,
  InMemoryThreads,
} from "@aep/application/testing";
import type {
  ConnectorManifest,
  MessageId,
  TenantId,
  ThreadId,
  UserId,
  WorkspaceId,
} from "@aep/domain";
import { INJECTED_INSTRUCTION, startMockMcp, type MockMcp } from "@aep/mock-mcp";
import { aesGcmSecretBox } from "@aep/secrets-local";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpOAuth } from "./oauth.ts";
import { mcpTools } from "./tools.ts";

// The gateway against the mock MCP server: a reply reads a funnel through a person's connection,
// the token never reaches the model (PRD scenario H) and text read through the connector cannot
// cause a write (scenario I).

const REDIRECT = "http://127.0.0.1:3001/connections/oauth/callback";
const TENANT = "0a000000-0000-4000-8000-000000000001" as TenantId;
const WORKSPACE = "0a000000-0000-4000-8000-0000000000a1" as WorkspaceId;
const ALICE: Principal = {
  tenantId: TENANT,
  userId: "0a000000-0000-4000-8000-0000000000aa" as UserId,
  role: "engineer",
};

let mock: MockMcp;
let connections: InMemoryConnections;
let audit: AuditEventInput[];
let manifest: ConnectorManifest;
let nextId = 1;
const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
const now = () => new Date();
const options = { allowHttp: true };

async function setUp(accessTokenSeconds?: number) {
  mock = await startMockMcp(accessTokenSeconds === undefined ? {} : { accessTokenSeconds });
  manifest = {
    id: "mock-amplitude",
    name: "Mock Amplitude",
    description: "Funnels",
    servers: [{ id: "local", label: "Local", url: mock.mcpUrl }],
    auth: { type: "oauth2", registration: "dynamic", scopes: ["all:read", "offline_access"] },
    tools: [
      { name: "get_amplitude_context", class: "read" },
      { name: "query_amplitude_data", class: "read" },
      { name: "get_amplitude_charts", class: "read" },
      { name: "manage_amp_entities", class: "write" },
    ],
    egressHosts: ["127.0.0.1"],
    sources: [{ claim: "mock", url: "https://example.com", checkedOn: "2026-11-16" }],
  };
  connections = new InMemoryConnections(now);
  const clients = new InMemoryConnectorClients();
  const catalog = { manifests: [manifest], redirectUri: REDIRECT };
  const box = aesGcmSecretBox(randomBytes(32));
  const oauth = mcpOAuth(options);
  audit = [];

  // Connect Alice as the browser and the worker would.
  const service = connectionService({
    catalog,
    connections,
    clients,
    oauth,
    newState: () => randomBytes(16).toString("base64url"),
    now,
  });
  const worker = connectionHandlers({ catalog, connections, clients, oauth, box, now });
  const started = await service.authorize(ALICE, manifest.id, undefined);
  if (!started.ok) throw new Error("authorize failed");
  const back = new URL(
    (await fetch(started.value.url, { redirect: "manual" })).headers.get("location") ?? "",
  );
  await service.callback(ALICE, {
    state: back.searchParams.get("state") ?? "",
    code: back.searchParams.get("code") ?? "",
  });
  for (let job = connections.jobs.shift(); job; job = connections.jobs.shift()) {
    await worker.handlers[job.kind]?.(
      { id: "j", ...job, attempt: 1, maxAttempts: 5, lastError: null },
      new AbortController().signal,
    );
  }

  return connectorGateway({
    catalog,
    connections,
    clients,
    oauth,
    mcp: mcpTools(options),
    box,
    audit: {
      record: (_tenant, event) => {
        audit.push(event);
        return Promise.resolve();
      },
    },
    now,
  });
}

afterEach(async () => {
  await mock.close();
});

const signal = () => new AbortController().signal;
const issuedTokens = () =>
  // Everything the mock issued that is still recorded: the tokens tool calls carried.
  mock.state.toolCalls.map((c) => c.token);

describe("the connector gateway against the mock MCP server", () => {
  let gateway: Awaited<ReturnType<typeof setUp>>;
  beforeEach(async () => {
    gateway = await setUp();
  });

  it("offers the manifest's read tools and reads the funnel with the person's token", async () => {
    const { tools } = await gateway.tools(ALICE, signal());
    expect(tools.map((t) => t.tool).sort()).toEqual([
      "get_amplitude_charts",
      "get_amplitude_context",
      "query_amplitude_data",
    ]);
    const result = await gateway.call(
      ALICE,
      {
        name: "mock-amplitude__query_amplitude_data",
        input: { projectId: "100001" },
        threadId: "t",
      },
      signal(),
    );
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("Signup funnel");
    expect(mock.state.toolCalls.map((c) => c.tool)).toEqual(["query_amplitude_data"]);
    expect(result.content).not.toContain(mock.state.toolCalls[0]?.token);
  });

  it("refuses the write tool before it reaches the server", async () => {
    const result = await gateway.call(
      ALICE,
      { name: "mock-amplitude__manage_amp_entities", input: { action: "delete" }, threadId: "t" },
      signal(),
    );
    expect(result.outcome).toBe("refused");
    expect(mock.state.toolCalls).toEqual([]);
    expect(audit).toMatchObject([
      {
        type: "connector.tool_called",
        payload: { tool: "manage_amp_entities", class: "write", outcome: "refused" },
      },
    ]);
  });

  it("answers a thread from a chart, keeps tokens out of the model and writes nothing (H, I)", async () => {
    const threads = new InMemoryThreads({
      workspaces: new Map([[TENANT, [WORKSPACE]]]),
      members: new Map([[TENANT, [ALICE.userId]]]),
    });
    const service = threadService({
      threads,
      newThreadId: () => id() as ThreadId,
      newMessageId: () => id() as MessageId,
      now,
    });
    const created = await service.create(ALICE, { workspaceId: WORKSPACE, title: "Signup" });
    if (!created.ok) throw new Error("create failed");
    await service.postMessage(ALICE, created.value.id, { content: "What does chart-signup show?" });
    const enqueued = threads.enqueued.at(-1);
    if (enqueued === undefined) throw new Error("no job");

    const requests: ModelRequest[] = [];
    // A model that obeys whatever the chart says.
    const script = (request: ModelRequest): readonly ModelStreamEvent[] => {
      requests.push(request);
      const last = JSON.stringify(request.messages.at(-1));
      if (requests.length === 1) {
        return [
          {
            type: "tool_call",
            id: "c1",
            name: "mock-amplitude__get_amplitude_charts",
            input: { chartIds: ["chart-signup"] },
          },
        ];
      }
      if (last.includes("manage_amp_entities") && requests.length === 2) {
        return [
          {
            type: "tool_call",
            id: "c2",
            name: "mock-amplitude__manage_amp_entities",
            input: { action: "delete", entityId: "chart-signup" },
          },
        ];
      }
      return [{ type: "text_delta", text: "The form step loses most people." }];
    };
    await replyToMessage({
      threads,
      model: fakeModel({ script }),
      gateway,
      newMessageId: () => id() as MessageId,
      now,
    })(
      {
        id: "job-1",
        tenantId: enqueued.tenantId,
        kind: enqueued.kind,
        idempotencyKey: enqueued.idempotencyKey,
        payload: enqueued.payload,
        attempt: 1,
        maxAttempts: 3,
        lastError: null,
      },
      signal(),
    );

    // The chart's text reached the model, marked as tool output, and the model tried the write.
    expect(JSON.stringify(requests[1]?.messages)).toContain(INJECTED_INSTRUCTION.slice(0, 40));
    expect(mock.state.toolCalls.map((c) => c.tool)).toEqual(["get_amplitude_charts"]);
    expect(audit.map((a) => [a.payload["tool"], a.payload["outcome"]])).toEqual([
      ["get_amplitude_charts", "ok"],
      ["manage_amp_entities", "refused"],
    ]);
    // Scenario H: no request to the model carries a token the provider issued.
    const sent = JSON.stringify(requests);
    for (const token of issuedTokens()) expect(sent).not.toContain(token);
    expect(sent).not.toMatch(/mock_(at|rt)_/);
    const stored = threads.events.filter((e) => e.type === "message.created").at(-1);
    expect(stored?.payload).toMatchObject({ sources: "mock-amplitude" });
  });
});

describe("refreshing", () => {
  it("refreshes an expired access token with the rotating refresh token", async () => {
    const gateway = await setUp(1);
    const before = await connections.tokens(ALICE, "mock-amplitude");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const result = await gateway.call(
      ALICE,
      { name: "mock-amplitude__get_amplitude_context", input: {}, threadId: "t" },
      signal(),
    );
    expect(result.outcome).toBe("ok");
    // Refreshed before the call: the server never saw the expired token.
    expect(mock.state.rejectedTokens).toBe(0);
    const after = await connections.tokens(ALICE, "mock-amplitude");
    expect(after?.accessToken).toMatch(/^v1\./);
    expect(after?.accessToken).not.toBe(before?.accessToken);
    expect(after?.refreshToken).not.toBe(before?.refreshToken);
  });
});
