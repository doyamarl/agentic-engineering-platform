import type { OidcStart } from "@aep/application";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenIdProvider, type OpenIdSettings } from "./openid-provider.ts";

// Against a real OIDC provider: navikt/mock-oauth2-server (MIT), the same image CI's browser
// tests use. Its interactive login takes a username (the subject) and the claims to issue.

const IMAGE =
  "ghcr.io/navikt/mock-oauth2-server:6.1.5@sha256:d88e445d55c4ff6eed59b02d86adfece47d985233b1616fb712669b98328c8a2";
const REDIRECT = new URL("http://127.0.0.1:3001/login/oidc/callback");

let idp: StartedTestContainer;
let settings: OpenIdSettings;

beforeAll(async () => {
  idp = await new GenericContainer(IMAGE)
    .withEnvironment({ JSON_CONFIG: JSON.stringify({ interactiveLogin: true }) })
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp("/default/.well-known/openid-configuration", 8080))
    .start();
  settings = {
    issuer: new URL(`http://${idp.getHost()}:${String(idp.getMappedPort(8080))}/default`),
    clientId: "aep",
    clientSecret: "aep-secret",
    redirectUri: REDIRECT,
    name: "Mock IdP",
    allowHttp: true,
  };
}, 180_000);

afterAll(async () => {
  await idp.stop();
});

/** Signs in at the provider as `username` with `claims` and returns the redirect back to us. */
async function signIn(start: OidcStart, username: string, claims: object): Promise<URL> {
  const response = await fetch(start.authorizationUrl, {
    method: "POST",
    body: new URLSearchParams({ username, claims: JSON.stringify(claims) }),
    redirect: "manual",
  });
  const location = response.headers.get("location");
  if (location === null) throw new Error(`no redirect (HTTP ${String(response.status)})`);
  return new URL(location);
}

describe("OpenIdProvider", () => {
  it("sends the browser to the provider with PKCE (S256), state, nonce and our redirect URI", async () => {
    const start = await new OpenIdProvider(settings).start();
    const url = new URL(start.authorizationUrl);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT.href);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).not.toBe(start.codeVerifier);
    expect(url.searchParams.get("state")).toBe(start.state);
    expect(url.searchParams.get("nonce")).toBe(start.nonce);
    expect(url.searchParams.get("scope")).toBe("openid email");
  });

  it("returns the verified claims of a successful login", async () => {
    const provider = new OpenIdProvider(settings);
    const start = await provider.start();
    const callback = await signIn(start, "idp-alice", {
      email: "alice@example.com",
      email_verified: true,
    });
    expect(callback.origin + callback.pathname).toBe(REDIRECT.href);
    expect(await provider.finish(callback, start)).toEqual({
      issuer: settings.issuer.href,
      subject: "idp-alice",
      email: "alice@example.com",
      emailVerified: true,
    });
  });

  it("treats a missing or non-boolean email_verified as unverified", async () => {
    const provider = new OpenIdProvider(settings);
    for (const claims of [
      { email: "a@example.com" },
      { email: "a@example.com", email_verified: "true" },
    ]) {
      const start = await provider.start();
      const callback = await signIn(start, "idp-a", claims);
      expect(await provider.finish(callback, start)).toMatchObject({ emailVerified: false });
    }
  });

  it.each([
    ["another state", { state: "forged" }],
    ["another nonce", { nonce: "forged" }],
    ["another code verifier", { codeVerifier: "x".repeat(43) }],
  ])("refuses a callback checked against %s", async (_, change) => {
    const provider = new OpenIdProvider(settings);
    const start = await provider.start();
    const callback = await signIn(start, "idp-alice", { email_verified: true });
    expect(await provider.finish(callback, { ...start, ...change })).toBeUndefined();
  });

  it("refuses the same code twice", async () => {
    const provider = new OpenIdProvider(settings);
    const start = await provider.start();
    const callback = await signIn(start, "idp-alice", { email_verified: true });
    expect(await provider.finish(callback, start)).toBeDefined();
    expect(await provider.finish(callback, start)).toBeUndefined();
  });

  it("refuses an http issuer unless allowed", () => {
    expect(() => new OpenIdProvider({ ...settings, allowHttp: false })).toThrow(/https/);
  });
});
