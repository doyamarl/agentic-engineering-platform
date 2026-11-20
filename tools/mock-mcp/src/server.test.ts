import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INJECTED_INSTRUCTION, type MockMcp, MOCK_FUNNEL, startMockMcp } from "./server.ts";

const REDIRECT = "http://127.0.0.1:3001/connections/oauth/callback";

let mock: MockMcp;
beforeEach(async () => {
  mock = await startMockMcp();
});
afterEach(async () => {
  await mock.close();
});

const register = async (): Promise<string> => {
  const res = await fetch(`${mock.url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "AEP" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
};

const authorize = async (clientId: string, verifier: string): Promise<URL> => {
  const url = new URL(`${mock.url}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "all:read offline_access",
    state: "s1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
};

type Tokens = { access_token: string; refresh_token: string };

const tokenRequest = (body: Record<string, string>) =>
  fetch(`${mock.url}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

const connect = async (): Promise<{ clientId: string; tokens: Tokens }> => {
  const clientId = await register();
  const verifier = randomBytes(32).toString("base64url");
  const back = await authorize(clientId, verifier);
  const res = await tokenRequest({
    grant_type: "authorization_code",
    code: back.searchParams.get("code") ?? "",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
  expect(res.status).toBe(200);
  return { clientId, tokens: (await res.json()) as Tokens };
};

const mcpClient = async (accessToken: string) => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mock.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  return client;
};

const text = (result: { content?: unknown }) =>
  ((result.content as { type: string; text: string }[] | undefined) ?? [])
    .map((c) => c.text)
    .join("");

describe("OAuth", () => {
  it("advertises the same shape as Amplitude's authorization server", async () => {
    const meta = (await (
      await fetch(`${mock.url}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      registration_endpoint: `${mock.url}/register`,
      revocation_endpoint: `${mock.url}/revoke`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("never redirects to a URI the client did not register", async () => {
    const clientId = await register();
    const res = await fetch(
      `${mock.url}/authorize?client_id=${clientId}&redirect_uri=https%3A%2F%2Fevil.test%2Fcb&response_type=code`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });

  it("refuses a code with the wrong PKCE verifier", async () => {
    const clientId = await register();
    const back = await authorize(clientId, "right-verifier-right-verifier-right-verifier");
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier",
    });
    expect(res.status).toBe(400);
    expect(back.searchParams.get("state")).toBe("s1");
  });

  it("rotates the refresh token", async () => {
    const { clientId, tokens } = await connect();
    const first = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(first.status).toBe(200);
    const again = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(again.status).toBe(400);
  });

  it("records revocations, and a revoked token no longer works", async () => {
    const { tokens } = await connect();
    await fetch(`${mock.url}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.access_token }),
    });
    expect(mock.state.revoked).toEqual([tokens.access_token]);
    await expect(mcpClient(tokens.access_token)).rejects.toThrow();
  });
});

describe("MCP", () => {
  it("answers 401 with the resource metadata without a token", async () => {
    const res = await fetch(mock.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource");
  });

  it("lists Amplitude-shaped tools and returns the funnel", async () => {
    const { tokens } = await connect();
    const client = await mcpClient(tokens.access_token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_amplitude_charts",
      "get_amplitude_context",
      "manage_amp_entities",
      "query_amplitude_data",
    ]);
    const result = await client.callTool({
      name: "query_amplitude_data",
      arguments: { chartType: "funnel" },
    });
    expect(JSON.parse(text(result))).toMatchObject({ funnel: MOCK_FUNNEL });
    await client.close();
  });

  it("records each call with the token and the subject it was issued for", async () => {
    const a = await connect();
    const b = await connect();
    for (const { tokens } of [a, b]) {
      const client = await mcpClient(tokens.access_token);
      await client.callTool({ name: "get_amplitude_context", arguments: {} });
      await client.close();
    }
    const [first, second] = mock.state.toolCalls;
    expect(first?.token).toBe(a.tokens.access_token);
    expect(second?.token).toBe(b.tokens.access_token);
    expect(first?.subject).not.toBe(second?.subject);
  });

  it("puts an instruction to call the write tool into chart text", async () => {
    const { tokens } = await connect();
    const client = await mcpClient(tokens.access_token);
    const result = await client.callTool({
      name: "get_amplitude_charts",
      arguments: { chartIds: ["chart-signup"] },
    });
    expect(text(result)).toContain(JSON.stringify(INJECTED_INSTRUCTION).slice(1, -1));
    expect(mock.state.toolCalls.map((c) => c.tool)).toEqual(["get_amplitude_charts"]);
    await client.close();
  });
});
