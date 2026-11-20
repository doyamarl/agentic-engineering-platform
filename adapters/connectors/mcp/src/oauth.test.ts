import { randomBytes } from "node:crypto";
import { connectionHandlers, connectionService, type Principal } from "@aep/application";
import { InMemoryConnections, InMemoryConnectorClients } from "@aep/application/testing";
import type { ConnectorManifest, TenantId, UserId } from "@aep/domain";
import { startMockMcp, type MockMcp } from "@aep/mock-mcp";
import { aesGcmSecretBox } from "@aep/secrets-local";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpOAuth } from "./oauth.ts";

const REDIRECT = "http://127.0.0.1:3001/connections/oauth/callback";
const ALICE: Principal = {
  tenantId: "0a000000-0000-4000-8000-000000000001" as TenantId,
  userId: "0a000000-0000-4000-8000-0000000000aa" as UserId,
  role: "engineer",
};

let mock: MockMcp;
let manifest: ConnectorManifest;
const oauth = mcpOAuth({ allowHttp: true });

beforeEach(async () => {
  mock = await startMockMcp();
  manifest = {
    id: "mock-amplitude",
    name: "Mock Amplitude",
    description: "Funnels",
    servers: [{ id: "local", label: "Local", url: mock.mcpUrl }],
    auth: { type: "oauth2", registration: "dynamic", scopes: ["all:read", "offline_access"] },
    tools: [{ name: "query_amplitude_data", class: "read" }],
    egressHosts: ["127.0.0.1"],
    sources: [{ claim: "mock", url: "https://example.com", checkedOn: "2026-11-15" }],
  };
});
afterEach(async () => {
  await mock.close();
});

/** What the browser does: follow the authorization URL to the provider and back. */
const approveInBrowser = async (url: string) => {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
};

describe("mcpOAuth against the mock server", () => {
  it("registers, authorizes with PKCE, exchanges, refreshes and revokes", async () => {
    const server = manifest.servers[0];
    if (server === undefined) throw new Error("no server");
    const registration = await oauth.register(manifest, server, REDIRECT);
    expect(mock.state.registrations).toMatchObject([
      { clientId: registration.clientId, redirectUris: [REDIRECT] },
    ]);

    const { url, codeVerifier } = await oauth.authorizationUrl(manifest, registration, {
      state: "state-1",
      scopes: ["all:read", "offline_access"],
    });
    expect(new URL(url).searchParams.get("code_challenge_method")).toBe("S256");
    const back = await approveInBrowser(url);
    expect(back.searchParams.get("state")).toBe("state-1");

    const tokens = await oauth.exchange(manifest, registration, {
      code: back.searchParams.get("code") ?? "",
      codeVerifier,
    });
    expect(tokens.accessToken).toMatch(/^mock_at_/);
    expect(tokens.expiresAt?.getTime()).toBeGreaterThan(Date.now());

    const refreshed = await oauth.refresh(manifest, registration, tokens.refreshToken ?? "");
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);

    await oauth.revoke(manifest, registration, {
      value: refreshed.accessToken,
      hint: "access_token",
    });
    expect(mock.state.revoked).toEqual([refreshed.accessToken]);
  });

  it("refuses a server whose host is not in egressHosts, before sending anything", async () => {
    const server = manifest.servers[0];
    if (server === undefined) throw new Error("no server");
    await expect(
      oauth.register({ ...manifest, egressHosts: ["mcp.example.com"] }, server, REDIRECT),
    ).rejects.toThrow("egress refused");
    expect(mock.state.registrations).toEqual([]);
  });

  it("connects and disconnects end to end, with the tokens sealed at rest", async () => {
    const now = () => new Date();
    const connections = new InMemoryConnections(now);
    const clients = new InMemoryConnectorClients();
    const catalog = { manifests: [manifest], redirectUri: REDIRECT };
    const box = aesGcmSecretBox(randomBytes(32));
    const service = connectionService({
      catalog,
      connections,
      clients,
      oauth,
      newState: () => randomBytes(16).toString("base64url"),
      now,
    });
    const worker = connectionHandlers({ catalog, connections, clients, oauth, box, now });
    const run = async () => {
      for (let job = connections.jobs.shift(); job; job = connections.jobs.shift()) {
        await worker.handlers[job.kind]?.(
          { id: "j", ...job, attempt: 1, maxAttempts: 5, lastError: null },
          new AbortController().signal,
        );
      }
    };

    const started = await service.authorize(ALICE, "mock-amplitude", undefined);
    if (!started.ok) throw new Error("authorize failed");
    const back = await approveInBrowser(started.value.url);
    await service.callback(ALICE, {
      state: back.searchParams.get("state") ?? "",
      code: back.searchParams.get("code") ?? "",
    });
    await run();

    const stored = await connections.tokens(ALICE, "mock-amplitude");
    expect(stored?.accessToken).toMatch(/^v1\./);
    expect(stored?.accessToken).not.toContain("mock_at_");

    await service.disconnect(ALICE, "mock-amplitude");
    await run();
    expect(mock.state.revoked).toHaveLength(2);
    expect(mock.state.revoked.every((t) => t.startsWith("mock_"))).toBe(true);
    expect(await connections.list(ALICE)).toEqual([]);
  });
});
