import { AuditEventListDto, ChatSettingsDto, ErrorDto } from "@aep/contracts";
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

// The chat model a tenant admin chooses (#43). Alice is tenant A's admin; Bob plans in tenant B.

let db: TestDatabase;
let app: FastifyInstance;
let adminA: string;
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
});

const call = (method: "GET" | "PUT", url: string, token: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });

describe("/v1/settings/chat", () => {
  it("starts on the instance default and lists the models an admin may choose", async () => {
    const response = await call("GET", "/v1/settings/chat", adminA);
    expect(response.statusCode).toBe(200);
    expect(ChatSettingsDto.parse(response.json())).toEqual({
      model: null,
      choices: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
    });
  });

  it("stores the admin's choice, audits it, and leaves other tenants on the default", async () => {
    const changed = await call("PUT", "/v1/settings/chat", adminA, { model: "claude-opus-5-5" });
    expect(changed.statusCode).toBe(200);
    expect(ChatSettingsDto.parse(changed.json())).toMatchObject({
      model: "claude-opus-5-5",
      updatedBy: USER_A,
    });
    expect(
      ChatSettingsDto.parse((await call("GET", "/v1/settings/chat", adminA)).json()).model,
    ).toBe("claude-opus-5-5");

    const audit = AuditEventListDto.parse((await call("GET", "/v1/audit-events", adminA)).json());
    expect(audit.items.at(-1)).toMatchObject({
      type: "settings.chat_model_changed",
      actorId: USER_A,
      payload: { from: null, to: "claude-opus-5-5" },
    });

    const back = await call("PUT", "/v1/settings/chat", adminA, { model: null });
    expect(ChatSettingsDto.parse(back.json()).model).toBeNull();
  });

  it("rejects a model off the list", async () => {
    const refused = await call("PUT", "/v1/settings/chat", adminA, { model: "gpt-5" });
    expect(refused.statusCode).toBe(400);
  });

  it("is for admins only", async () => {
    for (const [method, payload] of [["GET"], ["PUT", { model: null }]] as const) {
      const refused = await call(method, "/v1/settings/chat", plannerB, payload);
      expect(refused.statusCode).toBe(403);
      expect(ErrorDto.parse(refused.json()).error.code).toBe("forbidden");
    }
  });
});
