import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubApiError, gitHubApp } from "./github-app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function fakeFetch(responses: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const f = (input: string, init?: RequestInit) => {
    const url = input;
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    const r = responses[`${method} ${url}`] ?? { status: 404, body: { message: "Not Found" } };
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
  };
  return { calls, fetch: f as typeof fetch };
}

const API = "https://api.example.test";
const repo = { owner: "acme", name: "shop" };

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
}

describe("gitHubApp", () => {
  it("authenticates as the App with a signed, short-lived JWT", async () => {
    const { calls, fetch } = fakeFetch({
      [`GET ${API}/repos/acme/shop/installation`]: { status: 200, body: { id: 42 } },
      [`POST ${API}/app/installations/42/access_tokens`]: {
        status: 201,
        body: { token: "ghs_x", expires_at: "2030-01-01T00:00:00Z" },
      },
    });
    await gitHubApp({ appId: "123", privateKey: pem, apiUrl: API, fetch }).installationToken(repo);
    const jwt = (calls[0]?.headers["authorization"] ?? "").replace(/^Bearer /, "");
    const [header = "", payload = "", signature = ""] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload) as { iss: string; iat: number; exp: number };
    expect(claims.iss).toBe("123");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.iat).toBeLessThan(Date.now() / 1000);
    const valid = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));
    expect(valid).toBe(true);
  });

  it("scopes each installation token to the one repository and minimal permissions", async () => {
    const { calls, fetch } = fakeFetch({
      [`GET ${API}/repos/acme/shop/installation`]: { status: 200, body: { id: 42 } },
      [`POST ${API}/app/installations/42/access_tokens`]: {
        status: 201,
        body: { token: "ghs_x", expires_at: "2030-01-01T00:00:00Z" },
      },
    });
    const token = await gitHubApp({
      appId: "123",
      privateKey: pem,
      apiUrl: API,
      fetch,
    }).installationToken(repo);
    expect(token).toEqual({ token: "ghs_x", expiresAt: new Date("2030-01-01T00:00:00Z") });
    expect(calls[1]?.body).toEqual({
      repositories: ["shop"],
      permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "read",
        checks: "read",
        statuses: "read",
      },
    });
  });

  it("reports API errors with status and message", async () => {
    const { fetch } = fakeFetch({});
    const app = gitHubApp({ appId: "123", privateKey: pem, apiUrl: API, fetch });
    const error = await app.installationToken(repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(404);
    expect(String(error)).toContain("Not Found");
  });
});
