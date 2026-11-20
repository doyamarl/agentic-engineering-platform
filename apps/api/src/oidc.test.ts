import { randomBytes } from "node:crypto";
import { AuthMethodsDto, MeDto, OidcStartDto, TokensDto } from "@aep/contracts";
import { OpenIdProvider } from "@aep/identity-oidc";
import {
  TENANT_A,
  USER_A,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "@aep/postgres/testing";
import type { FastifyInstance } from "fastify";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { postgresDependencies } from "./dependencies.ts";

// OIDC login end to end: HTTP, a real provider (navikt/mock-oauth2-server) and Postgres.

const IMAGE =
  "ghcr.io/navikt/mock-oauth2-server:6.1.5@sha256:d88e445d55c4ff6eed59b02d86adfece47d985233b1616fb712669b98328c8a2";
const REDIRECT = new URL("http://127.0.0.1:3001/login/oidc/callback");
const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";

let db: TestDatabase;
let idp: StartedTestContainer;
let app: FastifyInstance;

beforeAll(async () => {
  [db, idp] = await Promise.all([
    startDatabase(),
    new GenericContainer(IMAGE)
      .withEnvironment({ JSON_CONFIG: JSON.stringify({ interactiveLogin: true }) })
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/default/.well-known/openid-configuration", 8080))
      .start(),
  ]);
  const provider = new OpenIdProvider({
    issuer: new URL(`http://${idp.getHost()}:${String(idp.getMappedPort(8080))}/default`),
    clientId: "aep",
    clientSecret: "aep-secret",
    redirectUri: REDIRECT,
    name: "Example SSO",
    allowHttp: true,
  });
  app = buildApp(
    postgresDependencies(db.app, {
      accessTokenSecret: randomBytes(32),
      password: false,
      oidc: { provider, redirectUri: REDIRECT },
    }),
    { logger: false },
  );
}, 180_000);

afterAll(async () => {
  await app.close();
  await Promise.all([db.stop(), idp.stop()]);
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
  await db.admin
    .updateTable("users")
    .set({ email: "alice@example.com" })
    .where("id", "=", USER_A)
    .execute();
  await db.admin
    .insertInto("password_credentials")
    .values({
      user_id: USER_A,
      tenant_id: TENANT_A,
      password_hash: HASH,
      must_change_password: false,
    })
    .execute();
});

/** Runs the whole flow as `username` with `claims` and returns the callback's response. */
async function oidcLogin(username: string, claims: object) {
  const started = await app.inject({ method: "POST", url: "/v1/auth/oidc/start" });
  expect(started.statusCode).toBe(200);
  const start = OidcStartDto.parse(started.json());
  const signedIn = await fetch(start.authorizationUrl, {
    method: "POST",
    body: new URLSearchParams({ username, claims: JSON.stringify(claims) }),
    redirect: "manual",
  });
  const back = new URL(signedIn.headers.get("location") ?? "");
  const payload = {
    query: back.search,
    state: start.state,
    nonce: start.nonce,
    codeVerifier: start.codeVerifier,
  };
  const response = await app.inject({ method: "POST", url: "/v1/auth/oidc/callback", payload });
  return { response, payload };
}

describe("OIDC login over HTTP", () => {
  it("lists the methods: OIDC with its name, password off", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/auth/methods" });
    expect(AuthMethodsDto.parse(response.json())).toEqual({
      password: false,
      oidc: { name: "Example SSO" },
    });
    const password = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "alice@example.com", password: "whatever-password" },
    });
    expect(password.statusCode).toBe(404);
  });

  it("logs in a registered member with a verified email and binds the subject", async () => {
    const { response } = await oidcLogin("idp-alice", {
      email: "alice@example.com",
      email_verified: true,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const tokens = TokensDto.parse(response.json());
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(MeDto.parse(me.json())).toMatchObject({ userId: USER_A, tenantId: TENANT_A });
    const bound = await db.admin.selectFrom("oidc_identities").selectAll().execute();
    expect(bound).toMatchObject([{ subject: "idp-alice", user_id: USER_A, tenant_id: TENANT_A }]);
  });

  it.each([
    ["an unverified email", { email: "alice@example.com", email_verified: false }],
    ["an unregistered email", { email: "mallory@example.com", email_verified: true }],
  ])("refuses %s", async (_, claims) => {
    const { response } = await oidcLogin("idp-mallory", claims);
    expect(response.statusCode).toBe(401);
    expect(await db.admin.selectFrom("oidc_identities").selectAll().execute()).toEqual([]);
  });

  it("refuses a replayed callback", async () => {
    const { response, payload } = await oidcLogin("idp-alice", {
      email: "alice@example.com",
      email_verified: true,
    });
    expect(response.statusCode).toBe(200);
    const replay = await app.inject({ method: "POST", url: "/v1/auth/oidc/callback", payload });
    expect(replay.statusCode).toBe(401);
  });

  it("records the outcome in the tenant's audit log", async () => {
    await oidcLogin("idp-alice", { email: "alice@example.com", email_verified: false });
    await oidcLogin("idp-alice", { email: "alice@example.com", email_verified: true });
    const events = await db.admin
      .selectFrom("audit_events")
      .select(["type", "payload"])
      .orderBy("id")
      .execute();
    expect(events).toEqual([
      {
        type: "login.failed",
        payload: { method: "oidc", reason: "unverified_email", locked: false },
      },
      { type: "login.succeeded", payload: { method: "oidc" } },
    ]);
  });
});
