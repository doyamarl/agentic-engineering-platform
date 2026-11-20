import { MissionDto } from "@aep/contracts";
import { describe, expect, it } from "vitest";
import { callApi, httpsUrl, isUuid } from "./api";

const env = { API_BASE_URL: "http://api.test" };
const deps = { env, token: "aep_secret" };
const mission = {
  id: "0a000000-0000-4000-8000-00000000a001",
  workspaceId: "0a000000-0000-4000-8000-0000000000a1",
  title: "Greeting",
  status: "DRAFT",
  version: 1,
  createdBy: "0a000000-0000-4000-8000-0000000000aa",
  createdAt: "2026-11-14T00:00:00.000Z",
};

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetch, calls };
}

describe("callApi", () => {
  it("calls the API with the session's token and validates the body", async () => {
    const { fetch, calls } = fakeFetch(201, mission);
    const result = await callApi(
      "/v1/missions",
      { method: "POST", body: { title: "Greeting" } },
      MissionDto,
      { ...deps, fetch },
    );
    expect(result).toEqual({ ok: true, value: mission });
    expect(calls[0]?.url).toBe("http://api.test/v1/missions");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer aep_secret", "content-type": "application/json" },
      body: '{"title":"Greeting"}',
    });
  });

  it("sends no bearer token to the login routes", async () => {
    const { fetch, calls } = fakeFetch(401, { error: { code: "unauthorized", message: "no" } });
    await callApi("/v1/auth/login", { method: "POST", body: {}, auth: false }, MissionDto, {
      ...deps,
      fetch,
    });
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
  });

  it("returns the API's error message", async () => {
    const { fetch } = fakeFetch(409, {
      error: { code: "conflict", message: "not allowed while the mission is PLANNING" },
    });
    expect(
      await callApi("/v1/missions/x/plan", { method: "POST" }, MissionDto, { ...deps, fetch }),
    ).toEqual({
      ok: false,
      status: 409,
      code: "conflict",
      message: "not allowed while the mission is PLANNING",
    });
  });

  it("rejects a body that does not match the contract", async () => {
    const { fetch } = fakeFetch(200, { id: "x" });
    expect(await callApi("/v1/missions/x", {}, MissionDto, { ...deps, fetch })).toMatchObject({
      ok: false,
      message: "API の応答が契約と一致しません",
    });
  });

  it("reports a missing base URL without calling the API", async () => {
    const { fetch, calls } = fakeFetch(200, mission);
    expect(
      await callApi("/v1/missions", {}, MissionDto, { env: {}, token: "t", fetch }),
    ).toMatchObject({ ok: false, status: 0 });
    expect(calls).toEqual([]);
  });

  it("reports an unreachable API without the token in the message", async () => {
    const fetch = (() =>
      Promise.reject(new TypeError("connect ECONNREFUSED aep_secret"))) as typeof globalThis.fetch;
    const result = await callApi("/v1/missions", {}, MissionDto, { ...deps, fetch });
    expect(result).toEqual({ ok: false, status: 0, message: "API に接続できません (TypeError)" });
  });
});

describe("helpers", () => {
  it("accepts only UUIDs as path ids", () => {
    expect(isUuid(mission.id)).toBe(true);
    expect(isUuid("../workspaces")).toBe(false);
    expect(isUuid(`${mission.id}/x`)).toBe(false);
  });

  it("links only https URLs", () => {
    expect(httpsUrl("https://github.com/acme/shop/pull/5")).toBe(
      "https://github.com/acme/shop/pull/5",
    );
    expect(httpsUrl("javascript:alert(1)")).toBeUndefined();
    expect(httpsUrl("http://example.test")).toBeUndefined();
    expect(httpsUrl("not a url")).toBeUndefined();
    expect(httpsUrl(null)).toBeUndefined();
  });
});
