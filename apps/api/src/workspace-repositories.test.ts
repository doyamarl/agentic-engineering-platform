import {
  AuditEventListDto,
  ErrorDto,
  WorkspaceRepositoryDto,
  WorkspaceRepositoryListDto,
} from "@aep/contracts";
import { issueApiToken } from "@aep/postgres";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
  WORKSPACE_A,
  WORKSPACE_B,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "@aep/postgres/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { postgresDependencies } from "./dependencies.ts";

// The GitHub repositories a workspace's chat may read (#52). Alice is tenant A's admin, Carol
// plans in tenant A and Bob plans in tenant B.

const USER_C = "0a000000-0000-4000-8000-0000000000cc";

let db: TestDatabase;
let app: FastifyInstance;
let adminA: string;
let plannerA: string;
let plannerB: string;

beforeAll(async () => {
  db = await startDatabase();
  app = buildApp(postgresDependencies(db.app), { logger: false });
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
  adminA = await issueApiToken(db.admin, { tenantId: TENANT_A, userId: USER_A, name: "a" });
  plannerB = await issueApiToken(db.admin, { tenantId: TENANT_B, userId: USER_B, name: "b" });
  // Carol plans in tenant A.
  await db.admin.insertInto("users").values({ id: USER_C, display_name: "Carol" }).execute();
  await db.admin
    .insertInto("memberships")
    .values({ tenant_id: TENANT_A, user_id: USER_C, role: "planner" })
    .execute();
  plannerA = await issueApiToken(db.admin, { tenantId: TENANT_A, userId: USER_C, name: "p" });
});

const call = (method: "GET" | "PUT" | "DELETE", url: string, token: string) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
const base = `/v1/workspaces/${WORKSPACE_A}/repositories`;

describe("/v1/workspaces/:id/repositories", () => {
  it("lets an admin add, list and remove a repository, audited", async () => {
    const added = await call("PUT", `${base}/acme/shop`, adminA);
    expect(added.statusCode).toBe(201);
    expect(WorkspaceRepositoryDto.parse(added.json())).toMatchObject({
      owner: "acme",
      name: "shop",
      addedBy: USER_A,
    });
    expect((await call("PUT", `${base}/Acme/Shop`, adminA)).statusCode).toBe(200);

    const listed = await call("GET", base, plannerA);
    expect(listed.statusCode).toBe(200);
    expect(WorkspaceRepositoryListDto.parse(listed.json()).items).toEqual([
      expect.objectContaining({ owner: "acme", name: "shop" }),
    ]);

    expect((await call("DELETE", `${base}/acme/shop`, adminA)).statusCode).toBe(204);
    expect((await call("DELETE", `${base}/acme/shop`, adminA)).statusCode).toBe(404);

    const audit = AuditEventListDto.parse((await call("GET", "/v1/audit-events", adminA)).json());
    expect(
      audit.items.filter((e) => e.type.startsWith("workspace.")).map((e) => [e.type, e.payload]),
    ).toEqual([
      ["workspace.repository_added", { workspaceId: WORKSPACE_A, repository: "acme/shop" }],
      ["workspace.repository_removed", { workspaceId: WORKSPACE_A, repository: "acme/shop" }],
    ]);
  });

  it("lets only admins change them", async () => {
    for (const method of ["PUT", "DELETE"] as const) {
      const refused = await call(method, `${base}/acme/shop`, plannerA);
      expect(refused.statusCode).toBe(403);
      expect(ErrorDto.parse(refused.json()).error.code).toBe("forbidden");
    }
  });

  it("answers 404 for another tenant's workspace and 400 for a bad name", async () => {
    expect((await call("GET", base, plannerB)).statusCode).toBe(404);
    expect(
      (await call("PUT", `/v1/workspaces/${WORKSPACE_B}/repositories/acme/shop`, adminA))
        .statusCode,
    ).toBe(404);
    expect((await call("PUT", `${base}/acme/sh%20op`, adminA)).statusCode).toBe(400);
    expect((await call("GET", "/v1/workspaces/not-a-uuid/repositories", adminA)).statusCode).toBe(
      404,
    );
  });
});
