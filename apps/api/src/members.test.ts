import { randomBytes } from "node:crypto";
import {
  AuditEventListDto,
  ErrorDto,
  MemberDto,
  MemberListDto,
  MemberWithPasswordDto,
  TokensDto,
} from "@aep/contracts";
import { issueApiToken } from "@aep/postgres";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "@aep/postgres/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { postgresDependencies } from "./dependencies.ts";

// Tenant administration end to end: an admin of tenant A manages A's members over HTTP.

let db: TestDatabase;
let app: FastifyInstance;
let adminA: string;
let plannerB: string;

beforeAll(async () => {
  db = await startDatabase();
  app = buildApp(postgresDependencies(db.app, { accessTokenSecret: randomBytes(32) }), {
    logger: false,
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
  await db.admin
    .updateTable("memberships")
    .set({ role: "admin" })
    .where("user_id", "=", USER_A)
    .execute();
  await db.admin
    .updateTable("users")
    .set({ email: "alice@example.com" })
    .where("id", "=", USER_A)
    .execute();
  adminA = await issueApiToken(db.admin, { tenantId: TENANT_A, userId: USER_A, name: "a" });
  plannerB = await issueApiToken(db.admin, { tenantId: TENANT_B, userId: USER_B, name: "b" });
});

const call = (method: "GET" | "POST" | "PATCH", url: string, token: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });

async function createCarol(role = "engineer") {
  const response = await call("POST", "/v1/members", adminA, {
    displayName: "Carol",
    email: "carol@example.com",
    role,
  });
  expect(response.statusCode).toBe(201);
  expect(response.headers["cache-control"]).toBe("no-store");
  return MemberWithPasswordDto.parse(response.json());
}

const login = (email: string, password: string) =>
  app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });

describe("creating a member", () => {
  it("hands out an initial password that logs in and must be changed", async () => {
    const { member, initialPassword } = await createCarol();
    expect(member).toMatchObject({
      email: "carol@example.com",
      role: "engineer",
      passwordLogin: true,
    });
    expect(initialPassword.length).toBeGreaterThanOrEqual(12);

    const loggedIn = await login("carol@example.com", initialPassword);
    expect(loggedIn.statusCode).toBe(200);
    const tokens = TokensDto.parse(loggedIn.json());
    expect(tokens.mustChangePassword).toBe(true);
    const blocked = await call("GET", "/v1/missions", tokens.accessToken);
    expect(ErrorDto.parse(blocked.json()).error.code).toBe("password_change_required");
  });

  it("refuses an email that is already in use", async () => {
    const response = await call("POST", "/v1/members", adminA, {
      displayName: "Alice again",
      email: "ALICE@example.com",
      role: "viewer",
    });
    expect(response.statusCode).toBe(409);
  });

  it("refuses a tenant id in the body instead of ignoring it", async () => {
    const response = await call("POST", "/v1/members", adminA, {
      displayName: "Carol",
      email: "carol@example.com",
      role: "viewer",
      tenantId: TENANT_B,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("permissions", () => {
  it.each(["planner", "engineer", "viewer"] as const)("refuses a %s with 403", async (role) => {
    await db.admin.updateTable("memberships").set({ role }).where("user_id", "=", USER_A).execute();
    for (const [method, url] of [
      ["GET", "/v1/members"],
      ["POST", "/v1/members"],
      ["PATCH", `/v1/members/${USER_A}`],
      ["POST", `/v1/members/${USER_A}/password-reset`],
      ["GET", "/v1/audit-events"],
    ] as const) {
      const payload =
        method === "POST" && url === "/v1/members"
          ? { displayName: "x", email: "x@example.com", role: "viewer" }
          : method === "PATCH"
            ? { role: "admin" }
            : undefined;
      const response = await call(method, url, adminA, payload);
      expect([method, url, response.statusCode]).toEqual([method, url, 403]);
    }
  });

  it("answers 404 for a member of another tenant", async () => {
    const patched = await call("PATCH", `/v1/members/${USER_B}`, adminA, { disabled: true });
    expect(patched.statusCode).toBe(404);
    const reset = await call("POST", `/v1/members/${USER_B}/password-reset`, adminA);
    expect(reset.statusCode).toBe(404);
    expect((await call("GET", "/v1/missions", plannerB)).statusCode).toBe(200);
  });

  it("lists only the admin's own tenant", async () => {
    const listed = MemberListDto.parse((await call("GET", "/v1/members", adminA)).json());
    expect(listed.items.map((m) => m.userId)).toEqual([USER_A]);
  });
});

describe("changing a member", () => {
  it("applies a role change and disabling on the member's next request", async () => {
    const { member, initialPassword } = await createCarol();
    const tokens = TokensDto.parse((await login("carol@example.com", initialPassword)).json());

    const viewer = await call("PATCH", `/v1/members/${member.userId}`, adminA, { role: "viewer" });
    expect(MemberDto.parse(viewer.json()).role).toBe("viewer");
    const disabled = await call("PATCH", `/v1/members/${member.userId}`, adminA, {
      disabled: true,
    });
    expect(MemberDto.parse(disabled.json()).disabled).toBe(true);

    expect((await call("GET", "/v1/me", tokens.accessToken)).statusCode).toBe(401);
    const refresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
    expect((await login("carol@example.com", initialPassword)).statusCode).toBe(401);
  });

  it("refuses to demote the last admin with 409", async () => {
    const response = await call("PATCH", `/v1/members/${USER_A}`, adminA, { role: "planner" });
    expect(response.statusCode).toBe(409);
    expect(ErrorDto.parse(response.json()).error.message).toMatch(/at least one active admin/);
  });

  it("resets a password: the old one stops working and the new one must be changed", async () => {
    const { member, initialPassword } = await createCarol();
    const reset = await call("POST", `/v1/members/${member.userId}/password-reset`, adminA);
    expect(reset.statusCode).toBe(200);
    expect(reset.headers["cache-control"]).toBe("no-store");
    const { initialPassword: next } = MemberWithPasswordDto.parse(reset.json());
    expect(next).not.toBe(initialPassword);
    expect((await login("carol@example.com", initialPassword)).statusCode).toBe(401);
    expect(
      TokensDto.parse((await login("carol@example.com", next)).json()).mustChangePassword,
    ).toBe(true);
  });
});

describe("GET /v1/audit-events", () => {
  it("shows member changes and logins, without passwords", async () => {
    const { member, initialPassword } = await createCarol();
    await login("carol@example.com", "wrong password!");
    await login("carol@example.com", initialPassword);
    await call("PATCH", `/v1/members/${member.userId}`, adminA, { role: "viewer" });

    const response = await call("GET", "/v1/audit-events", adminA);
    const { items } = AuditEventListDto.parse(response.json());
    expect(items.map((e) => [e.type, e.actorId, e.subjectId, e.payload])).toEqual([
      ["member.created", USER_A, member.userId, { role: "engineer" }],
      ["login.failed", null, member.userId, { reason: "wrong_password", locked: false }],
      ["login.succeeded", member.userId, member.userId, {}],
      ["member.role_changed", USER_A, member.userId, { from: "engineer", to: "viewer" }],
    ]);
    expect(response.body).not.toContain(initialPassword);

    const after = await call(
      "GET",
      `/v1/audit-events?after=${String(items[1]?.id)}&limit=1`,
      adminA,
    );
    expect(AuditEventListDto.parse(after.json()).items.map((e) => e.type)).toEqual([
      "login.succeeded",
    ]);
  });

  it("does not show another tenant's events", async () => {
    await createCarol();
    await db.admin
      .updateTable("memberships")
      .set({ role: "admin" })
      .where("user_id", "=", USER_B)
      .execute();
    const response = await call("GET", "/v1/audit-events", plannerB);
    expect(AuditEventListDto.parse(response.json()).items).toEqual([]);
  });
});
