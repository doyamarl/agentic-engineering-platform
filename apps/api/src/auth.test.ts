import { randomBytes } from "node:crypto";
import { ErrorDto, MeDto, MissionListDto, TokensDto } from "@aep/contracts";
import { Argon2PasswordHasher } from "@aep/identity-local";
import { issueApiToken } from "@aep/postgres";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
  WORKSPACE_B,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "@aep/postgres/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { postgresDependencies } from "./dependencies.ts";

// Password login end to end: HTTP, Argon2id, HS256 and Postgres as the runtime role.

const PASSWORD = "correct horse battery";
let db: TestDatabase;
let app: FastifyInstance;
let hash: string;

beforeAll(async () => {
  db = await startDatabase();
  app = buildApp(postgresDependencies(db.app, { accessTokenSecret: randomBytes(32) }), {
    logger: false,
  });
  hash = await new Argon2PasswordHasher().hash(PASSWORD);
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
  for (const [userId, tenantId, email] of [
    [USER_A, TENANT_A, "alice@example.com"],
    [USER_B, TENANT_B, "bob@example.com"],
  ] as const) {
    await db.admin.updateTable("users").set({ email }).where("id", "=", userId).execute();
    await db.admin
      .insertInto("password_credentials")
      .values({
        user_id: userId,
        tenant_id: tenantId,
        password_hash: hash,
        must_change_password: false,
      })
      .execute();
  }
});

const post = (url: string, payload: object, token?: string) =>
  app.inject({
    method: "POST",
    url,
    payload,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
const get = (url: string, token: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

async function login(email = "alice@example.com", password = PASSWORD) {
  const response = await post("/v1/auth/login", { email, password });
  expect(response.statusCode).toBe(200);
  return TokensDto.parse(response.json());
}

describe("POST /v1/auth/login", () => {
  it("returns tokens that are not cached, and the access token works on /v1", async () => {
    const response = await post("/v1/auth/login", {
      email: "Alice@Example.com",
      password: PASSWORD,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const tokens = TokensDto.parse(response.json());
    expect(tokens.mustChangePassword).toBe(false);
    expect(MeDto.parse((await get("/v1/me", tokens.accessToken)).json())).toEqual({
      userId: USER_A,
      tenantId: TENANT_A,
      role: "planner",
      mustChangePassword: false,
      permissions: [
        "mission:create",
        "mission:read",
        "mission:plan",
        "mission:cancel",
        "mission:retry",
        "plan:approve",
        "release:approve",
        "thread:read",
        "thread:write",
        "connector:use",
      ],
    });
  });

  it("answers a wrong password and an unknown email alike, without echoing the password", async () => {
    const wrong = await post("/v1/auth/login", {
      email: "alice@example.com",
      password: "wrong password!",
    });
    const unknown = await post("/v1/auth/login", {
      email: "nobody@example.com",
      password: PASSWORD,
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.body).not.toContain("wrong password!");
  });

  it("does not echo the request when the body is invalid", async () => {
    const response = await post("/v1/auth/login", {
      email: "alice@example.com",
      password: PASSWORD,
      extra: 1,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(PASSWORD);
  });

  it("locks the account after 5 wrong passwords", async () => {
    for (let i = 0; i < 5; i++) {
      await post("/v1/auth/login", { email: "alice@example.com", password: "wrong password!" });
    }
    expect(
      (await post("/v1/auth/login", { email: "alice@example.com", password: PASSWORD })).statusCode,
    ).toBe(401);
    expect(
      (await post("/v1/auth/login", { email: "bob@example.com", password: PASSWORD })).statusCode,
    ).toBe(200);
  });

  it("refuses a disabled user", async () => {
    await db.admin
      .updateTable("users")
      .set({ disabled_at: new Date() })
      .where("id", "=", USER_A)
      .execute();
    expect(
      (await post("/v1/auth/login", { email: "alice@example.com", password: PASSWORD })).statusCode,
    ).toBe(401);
  });
});

describe("access tokens", () => {
  it("scope the user to their own tenant", async () => {
    const tokens = await login();
    const created = await post(
      "/v1/missions",
      { workspaceId: WORKSPACE_B, title: "x" },
      tokens.accessToken,
    );
    expect(created.statusCode).toBe(404);
  });

  it("follow role changes and disabling on the next request", async () => {
    const tokens = await login();
    await db.admin
      .updateTable("memberships")
      .set({ role: "viewer" })
      .where("user_id", "=", USER_A)
      .execute();
    expect(MeDto.parse((await get("/v1/me", tokens.accessToken)).json()).role).toBe("viewer");
    await db.admin
      .updateTable("users")
      .set({ disabled_at: new Date() })
      .where("id", "=", USER_A)
      .execute();
    expect((await get("/v1/me", tokens.accessToken)).statusCode).toBe(401);
  });

  it("are refused when tampered with", async () => {
    const tokens = await login();
    const [header = "", payload = "", signature = ""] = tokens.accessToken.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(JSON.stringify({ ...claims, tid: TENANT_B, sub: USER_B })).toString(
      "base64url",
    );
    expect((await get("/v1/me", `${header}.${forged}.${signature}`)).statusCode).toBe(401);
  });

  it("leave API tokens working", async () => {
    const token = await issueApiToken(db.admin, {
      tenantId: TENANT_A,
      userId: USER_A,
      name: "cli",
    });
    expect((await get("/v1/missions", token)).statusCode).toBe(200);
  });
});

describe("POST /v1/auth/refresh and /logout", () => {
  it("rotates the refresh token, and a replayed one ends the session", async () => {
    const first = await login();
    const refreshed = await post("/v1/auth/refresh", { refreshToken: first.refreshToken });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.headers["cache-control"]).toBe("no-store");
    const second = TokensDto.parse(refreshed.json());
    expect((await get("/v1/me", second.accessToken)).statusCode).toBe(200);

    // Right after: a concurrent request from the same browser. It gets an access token only.
    const concurrent = await post("/v1/auth/refresh", { refreshToken: first.refreshToken });
    expect(concurrent.statusCode).toBe(200);
    const overlap = TokensDto.parse(concurrent.json());
    expect(overlap.refreshToken).toBeUndefined();
    expect((await get("/v1/me", overlap.accessToken)).statusCode).toBe(200);

    // After the 10-second grace period the same replay means a copy was stolen.
    await db.admin
      .updateTable("sessions")
      .set({ rotated_at: new Date(Date.now() - 11_000) })
      .execute();
    expect((await post("/v1/auth/refresh", { refreshToken: first.refreshToken })).statusCode).toBe(
      401,
    );
    expect((await post("/v1/auth/refresh", { refreshToken: second.refreshToken })).statusCode).toBe(
      401,
    );
  });

  it("logs out by revoking the refresh token", async () => {
    const tokens = await login();
    expect((await post("/v1/auth/logout", { refreshToken: tokens.refreshToken })).statusCode).toBe(
      204,
    );
    expect((await post("/v1/auth/refresh", { refreshToken: tokens.refreshToken })).statusCode).toBe(
      401,
    );
  });
});

describe("a password set by an admin", () => {
  beforeEach(async () => {
    await db.admin
      .updateTable("password_credentials")
      .set({ must_change_password: true })
      .execute();
  });

  it("allows only /v1/me and the password change until it is changed", async () => {
    const tokens = await login();
    expect(tokens.mustChangePassword).toBe(true);
    expect(MeDto.parse((await get("/v1/me", tokens.accessToken)).json()).mustChangePassword).toBe(
      true,
    );
    const blocked = await get("/v1/missions", tokens.accessToken);
    expect(blocked.statusCode).toBe(403);
    expect(ErrorDto.parse(blocked.json()).error.code).toBe("password_change_required");

    const changed = await post(
      "/v1/auth/password",
      { currentPassword: PASSWORD, newPassword: "a brand new passphrase" },
      tokens.accessToken,
    );
    expect(changed.statusCode).toBe(200);
    const fresh = TokensDto.parse(changed.json());
    expect(fresh.mustChangePassword).toBe(false);
    expect(
      MissionListDto.parse((await get("/v1/missions", fresh.accessToken)).json()).items,
    ).toEqual([]);
    expect((await post("/v1/auth/refresh", { refreshToken: tokens.refreshToken })).statusCode).toBe(
      401,
    );
    expect(
      (await post("/v1/auth/login", { email: "alice@example.com", password: PASSWORD })).statusCode,
    ).toBe(401);
  });

  it("refuses a new password that is too short", async () => {
    const tokens = await login();
    const response = await post(
      "/v1/auth/password",
      { currentPassword: PASSWORD, newPassword: "short" },
      tokens.accessToken,
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(PASSWORD);
  });
});

describe("without password login configured", () => {
  it("answers 404 on the login routes", async () => {
    const plain = buildApp(postgresDependencies(db.app), { logger: false });
    try {
      const response = await plain.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "alice@example.com", password: PASSWORD },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
