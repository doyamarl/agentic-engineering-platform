import type { TenantId, UserId } from "@aep/domain";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresTenantSettings } from "./tenant-settings.ts";
import { withTenant } from "./tenant-session.ts";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "./test-support.ts";

let db: TestDatabase;
let settings: PostgresTenantSettings;
const NOW = new Date("2026-11-15T00:00:00Z");
const audit = (to: string | null) => ({
  type: "settings.chat_model_changed" as const,
  actorId: USER_A as UserId,
  subjectId: null,
  payload: { from: null, to },
});

beforeAll(async () => {
  db = await startDatabase();
  settings = new PostgresTenantSettings(db.app);
}, 180_000);

afterAll(async () => {
  await db.stop();
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
});

describe("PostgresTenantSettings", () => {
  it("reads the default until a model is chosen, then the choice, for that tenant only", async () => {
    expect(await settings.chat(TENANT_A as TenantId)).toEqual({});
    await settings.setChat(
      TENANT_A as TenantId,
      { model: "claude-opus-5-5", by: USER_A as UserId, at: NOW },
      audit("claude-opus-5-5"),
    );
    expect(await settings.chat(TENANT_A as TenantId)).toEqual({
      model: "claude-opus-5-5",
      updatedBy: USER_A,
      updatedAt: NOW,
    });
    expect(await settings.chat(TENANT_B as TenantId)).toEqual({});
  });

  it("replaces the choice and writes one audit event per change", async () => {
    await settings.setChat(
      TENANT_A as TenantId,
      { model: "claude-opus-5-5", by: USER_A as UserId, at: NOW },
      audit("claude-opus-5-5"),
    );
    await settings.setChat(TENANT_A as TenantId, { by: USER_A as UserId, at: NOW }, audit(null));
    expect(await settings.chat(TENANT_A as TenantId)).toEqual({
      updatedBy: USER_A,
      updatedAt: NOW,
    });
    const events = await withTenant(db.app, TENANT_A, (trx) =>
      trx.selectFrom("audit_events").select(["type", "payload"]).orderBy("id").execute(),
    );
    expect(events).toEqual([
      { type: "settings.chat_model_changed", payload: { from: null, to: "claude-opus-5-5" } },
      { type: "settings.chat_model_changed", payload: { from: null, to: null } },
    ]);
  });

  it("reads a stored model that is no longer offered as the default", async () => {
    await db.admin
      .insertInto("tenant_settings")
      .values({ tenant_id: TENANT_A, chat_model: "claude-retired-1", updated_by: USER_A })
      .execute();
    expect((await settings.chat(TENANT_A as TenantId)).model).toBeUndefined();
  });

  it("keeps another tenant's settings out of reach of the runtime role", async () => {
    await db.admin
      .insertInto("tenant_settings")
      .values({
        tenant_id: TENANT_B,
        chat_model: "claude-opus-5-5",
        updated_by: "0b000000-0000-4000-8000-0000000000bb",
      })
      .execute();
    const seen = await withTenant(db.app, TENANT_A, (trx) =>
      trx.selectFrom("tenant_settings").select("tenant_id").execute(),
    );
    expect(seen).toEqual([]);
    await expect(
      withTenant(db.app, TENANT_A, (trx) =>
        sql`update tenant_settings set chat_model = null where tenant_id = ${TENANT_B}`.execute(
          trx,
        ),
      ),
    ).resolves.toMatchObject({ numAffectedRows: 0n });
  });
});
