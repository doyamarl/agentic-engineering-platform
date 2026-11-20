import { generateKeyPairSync } from "node:crypto";
import { CodeReadError } from "@aep/application";
import { describe, expect, it } from "vitest";
import { gitHubApp } from "./github-app.ts";
import { gitHubCodeReader } from "./github-code.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const API = "https://api.example.test";
const repo = { owner: "acme", name: "shop" };
const signal = new AbortController().signal;

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
type Call = { method: string; url: string; accept: string; auth: string; body?: unknown };

function setup(routes: Record<string, Reply>, now = () => new Date("2026-11-17T00:00:00Z")) {
  const calls: Call[] = [];
  const fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      url,
      accept: headers["accept"] ?? "",
      auth: headers["authorization"] ?? "",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    const reply = routes[`${method} ${url}`] ?? { status: 404, body: { message: "Not Found" } };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: reply.headers ?? {},
      }),
    );
  }) as typeof globalThis.fetch;
  const app = gitHubApp({ appId: "1", privateKey: pem, apiUrl: API, fetch });
  return { reader: gitHubCodeReader({ app, now }), calls };
}

const installed: Record<string, Reply> = {
  [`GET ${API}/repos/acme/shop/installation`]: { status: 200, body: { id: 7 } },
  [`POST ${API}/app/installations/7/access_tokens`]: {
    status: 201,
    body: { token: "ghs_read", expires_at: "2026-11-17T01:00:00Z" },
  },
};
const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");

describe("gitHubCodeReader", () => {
  it("reads a file with a token limited to the repository and contents: read, reused", async () => {
    const { reader, calls } = setup({
      ...installed,
      [`GET ${API}/repos/acme/shop/contents/src/sign%20up.ts?ref=release%2F1`]: {
        status: 200,
        body: {
          type: "file",
          path: "src/sign up.ts",
          size: 11,
          encoding: "base64",
          content: b64("const a = 1"),
        },
      },
    });
    const read = () => reader.readPath(repo, { path: "src/sign up.ts", ref: "release/1" }, signal);
    expect(await read()).toEqual({
      kind: "file",
      path: "src/sign up.ts",
      size: 11,
      text: "const a = 1",
    });
    await read();
    const tokenRequests = calls.filter((c) => c.url.endsWith("/access_tokens"));
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.body).toEqual({
      repositories: ["shop"],
      permissions: { contents: "read" },
    });
    expect(calls.filter((c) => c.url.includes("/contents/")).map((c) => c.auth)).toEqual([
      "Bearer ghs_read",
      "Bearer ghs_read",
    ]);
  });

  it("asks for a new token when the cached one is about to expire", async () => {
    let now = new Date("2026-11-17T00:00:00Z");
    const { reader, calls } = setup(
      {
        ...installed,
        [`GET ${API}/repos/acme/shop/contents`]: { status: 200, body: [] },
      },
      () => now,
    );
    await reader.readPath(repo, { path: "" }, signal);
    now = new Date("2026-11-17T00:56:00Z");
    await reader.readPath(repo, { path: "" }, signal);
    expect(calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(2);
  });

  it("lists a directory", async () => {
    const { reader } = setup({
      ...installed,
      [`GET ${API}/repos/acme/shop/contents/src`]: {
        status: 200,
        body: [
          { type: "file", path: "src/a.ts" },
          { type: "dir", path: "src/lib" },
          { type: "submodule", path: "src/vendor" },
        ],
      },
    });
    expect(await reader.readPath(repo, { path: "src" }, signal)).toEqual({
      kind: "directory",
      path: "src",
      entries: [
        { path: "src/a.ts", type: "file" },
        { path: "src/lib", type: "dir" },
        { path: "src/vendor", type: "submodule" },
      ],
    });
  });

  it("tells missing, binary and large files apart", async () => {
    const { reader } = setup({
      ...installed,
      [`GET ${API}/repos/acme/shop/contents/logo.png`]: {
        status: 200,
        body: {
          type: "file",
          path: "logo.png",
          size: 4,
          encoding: "base64",
          content: b64(Buffer.from([0x89, 0x50, 0x00, 0x47])),
        },
      },
      [`GET ${API}/repos/acme/shop/contents/latin1.txt`]: {
        status: 200,
        body: {
          type: "file",
          path: "latin1.txt",
          size: 2,
          encoding: "base64",
          content: b64(Buffer.from([0xe9, 0xe8])),
        },
      },
      [`GET ${API}/repos/acme/shop/contents/dump.sql`]: {
        status: 200,
        body: { type: "file", path: "dump.sql", size: 5_000_000, encoding: "none", content: "" },
      },
    });
    expect(await reader.readPath(repo, { path: "missing.ts" }, signal)).toEqual({
      kind: "not_found",
    });
    expect(await reader.readPath(repo, { path: "logo.png" }, signal)).toMatchObject({
      kind: "binary",
    });
    expect(await reader.readPath(repo, { path: "latin1.txt" }, signal)).toMatchObject({
      kind: "binary",
    });
    expect(await reader.readPath(repo, { path: "dump.sql" }, signal)).toEqual({
      kind: "too_large",
      path: "dump.sql",
      size: 5_000_000,
    });
  });

  it("searches the one repository with text matches", async () => {
    const q = encodeURIComponent("signup form repo:acme/shop");
    const { reader, calls } = setup({
      ...installed,
      [`GET ${API}/search/code?q=${q}&per_page=20`]: {
        status: 200,
        body: {
          total_count: 31,
          items: [{ path: "src/signup.ts", text_matches: [{ fragment: "signup form" }] }],
        },
      },
    });
    expect(await reader.search(repo, "signup form", signal)).toEqual({
      total: 31,
      items: [{ path: "src/signup.ts", fragments: ["signup form"] }],
    });
    expect(calls.at(-1)?.accept).toBe("application/vnd.github.text-match+json");
  });

  it("reports an App that is not installed and a rate limit", async () => {
    const { reader } = setup({});
    await expect(reader.readPath(repo, { path: "" }, signal)).rejects.toMatchObject({
      name: "CodeReadError",
      reason: "not_installed",
    });

    const limited = setup({
      ...installed,
      [`GET ${API}/search/code?q=${encodeURIComponent("x repo:acme/shop")}&per_page=20`]: {
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0" },
      },
    });
    const error = await limited.reader.search(repo, "x", signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodeReadError);
    expect((error as CodeReadError).reason).toBe("rate_limited");
  });
});
