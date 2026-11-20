import { describe, expect, it } from "vitest";
import {
  clearedCookies,
  cookieNames,
  expiresSoon,
  oidcCookie,
  readOidcCookie,
  safeNext,
  sessionCookies,
} from "./session";

const jwt = (exp: unknown) =>
  `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
const tokens = {
  accessToken: "access",
  accessExpiresAt: "2026-11-14T00:10:00.000Z",
  refreshToken: "aer_refresh",
  refreshExpiresAt: "2026-11-14T12:00:00.000Z",
  mustChangePassword: false,
};

describe("cookies", () => {
  it("are HttpOnly, Lax and __Host- prefixed Secure cookies by default", () => {
    const [access, refresh, mustChange] = sessionCookies(tokens, {});
    expect(access).toEqual({
      name: "__Host-aep_at",
      value: "access",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      expires: new Date(tokens.accessExpiresAt),
    });
    expect(refresh).toMatchObject({
      name: "__Host-aep_rt",
      expires: new Date(tokens.refreshExpiresAt),
    });
    expect(mustChange).toMatchObject({ name: "__Host-aep_mcp", expires: new Date(0) });
  });

  it("drop the Secure flag and prefix only when AEP_SECURE_COOKIES=false", () => {
    const env = { AEP_SECURE_COOKIES: "false" };
    expect(cookieNames(env).access).toBe("aep_at");
    expect(sessionCookies(tokens, env).every((c) => !c.secure)).toBe(true);
  });

  it("keep the browser's refresh token when the API sent none", () => {
    const { refreshToken: _, ...withoutRefresh } = tokens;
    expect(sessionCookies(withoutRefresh, {}).map((c) => c.name)).toEqual([
      "__Host-aep_at",
      "__Host-aep_mcp",
    ]);
  });

  it("flag a required password change", () => {
    expect(sessionCookies({ ...tokens, mustChangePassword: true }, {})[2]).toMatchObject({
      value: "1",
    });
  });

  it("are all expired on logout", () => {
    expect(clearedCookies({}).every((c) => c.value === "" && c.expires.getTime() === 0)).toBe(true);
  });
});

describe("expiresSoon", () => {
  const now = Date.parse("2026-11-14T00:00:00Z");
  it.each([
    ["31 s left", jwt(now / 1000 + 31), false],
    ["30 s left", jwt(now / 1000 + 30), true],
    ["no exp", jwt(undefined), true],
    ["not a JWT", "garbage", true],
    ["a bad payload", "a.!!!.c", true],
  ])("%s → %s", (_, token, soon) => {
    expect(expiresSoon(token, now)).toBe(soon);
  });
});

describe("safeNext", () => {
  it.each([
    ["/missions/abc?x=1", "/missions/abc?x=1"],
    [undefined, "/missions"],
    ["https://evil.example", "/missions"],
    ["//evil.example", "/missions"],
    ["/\\evil.example", "/missions"],
    ["/ok\nSet-Cookie: x", "/missions"],
  ])("%j → %j", (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });
});

describe("OIDC cookie", () => {
  const pending = { state: "s", nonce: "n", codeVerifier: "v", next: "/missions/x" };

  it("round-trips the pending login for 10 minutes, HttpOnly", () => {
    const cookie = oidcCookie(pending, 0, {});
    expect(cookie).toMatchObject({
      name: "__Host-aep_oidc",
      httpOnly: true,
      expires: new Date(600_000),
    });
    expect(readOidcCookie(cookie.value)).toEqual(pending);
  });

  it.each([undefined, "", "not json", JSON.stringify({ state: "s" })])("rejects %j", (value) => {
    expect(readOidcCookie(value)).toBeUndefined();
  });

  it("does not follow a next path to another site", () => {
    expect(readOidcCookie(JSON.stringify({ ...pending, next: "//evil.example" }))?.next).toBe(
      "/missions",
    );
  });
});
