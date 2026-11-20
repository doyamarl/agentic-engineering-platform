// The signed-in session as cookies (ADR-011). The API issues the tokens; this web server keeps
// them in HttpOnly cookies, so browser JavaScript never sees them, and sends the access token to
// the API as a bearer token. The browser never talks to the API directly.

import type { TokensDto } from "@aep/contracts";

type Env = Readonly<Record<string, string | undefined>>;

export type CookieNames = {
  readonly access: string;
  readonly refresh: string;
  /** Set while the password must be changed; only steers navigation, the API enforces it. */
  readonly mustChange: string;
  /** The OIDC login's one-time checks, between leaving for the provider and coming back. */
  readonly oidc: string;
};

/**
 * Secure cookies unless AEP_SECURE_COOKIES=false, which the local Compose stack sets because it
 * serves plain HTTP on 127.0.0.1. Secure cookies get the __Host- prefix: no Domain, Path=/.
 */
export const secureCookies = (env: Env = process.env): boolean =>
  env["AEP_SECURE_COOKIES"] !== "false";

export function cookieNames(env: Env = process.env): CookieNames {
  const prefix = secureCookies(env) ? "__Host-" : "";
  return {
    access: `${prefix}aep_at`,
    refresh: `${prefix}aep_rt`,
    mustChange: `${prefix}aep_mcp`,
    oidc: `${prefix}aep_oidc`,
  };
}

export type CookieSpec = {
  readonly name: string;
  readonly value: string;
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "lax";
  readonly path: "/";
  readonly expires: Date;
};

const spec = (name: string, value: string, expires: Date, env: Env): CookieSpec => ({
  name,
  value,
  httpOnly: true,
  secure: secureCookies(env),
  sameSite: "lax",
  path: "/",
  expires,
});

/** The cookies to set for `tokens`. Without a refresh token the browser keeps its newer one. */
export function sessionCookies(tokens: TokensDto, env: Env = process.env): CookieSpec[] {
  const names = cookieNames(env);
  const refreshExpires = new Date(tokens.refreshExpiresAt);
  return [
    spec(names.access, tokens.accessToken, new Date(tokens.accessExpiresAt), env),
    ...(tokens.refreshToken === undefined
      ? []
      : [spec(names.refresh, tokens.refreshToken, refreshExpires, env)]),
    tokens.mustChangePassword
      ? spec(names.mustChange, "1", refreshExpires, env)
      : spec(names.mustChange, "", new Date(0), env),
  ];
}

/** How long a login at the identity provider may take before the checks expire. */
export const OIDC_COOKIE_MS = 10 * 60_000;

export type OidcPending = {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly next: string;
};

/** The cookie that carries `pending` to the callback. HttpOnly; Lax lets the redirect back send it. */
export const oidcCookie = (pending: OidcPending, now: number, env: Env = process.env): CookieSpec =>
  spec(cookieNames(env).oidc, JSON.stringify(pending), new Date(now + OIDC_COOKIE_MS), env);

/** The pending OIDC login in `value`, or undefined if the cookie is missing or malformed. */
export function readOidcCookie(value: string | undefined): OidcPending | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const { state, nonce, codeVerifier, next } = parsed;
    if (
      typeof state !== "string" ||
      typeof nonce !== "string" ||
      typeof codeVerifier !== "string" ||
      typeof next !== "string"
    ) {
      return undefined;
    }
    return { state, nonce, codeVerifier, next: safeNext(next) };
  } catch {
    return undefined;
  }
}

/** Expired copies of every session cookie, which make the browser drop them. */
export function clearedCookies(env: Env = process.env): CookieSpec[] {
  const names = cookieNames(env);
  return [names.access, names.refresh, names.mustChange].map((name) =>
    spec(name, "", new Date(0), env),
  );
}

/**
 * Whether the access token expires within `marginMs`. Reads `exp` without checking the
 * signature: this only decides when to refresh. The API verifies every token it receives.
 */
export function expiresSoon(token: string, now: number, marginMs = 30_000): boolean {
  const payload = token.split(".")[1];
  if (payload === undefined) return true;
  try {
    const exp: unknown = (
      JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: unknown }
    ).exp;
    return typeof exp !== "number" || exp * 1000 - now <= marginMs;
  } catch {
    return true;
  }
}

/** A same-site path to return to after login; anything else goes to the mission list. */
export function safeNext(next: string | null | undefined): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//"))
    return "/missions";
  // A backslash or a control character could turn the path into another host or header.
  if (next.includes("\\") || Array.from(next).some((c) => c.charCodeAt(0) < 0x20))
    return "/missions";
  return next;
}
