import {
  isChatModel,
  type AuditEventInput,
  type ChatModel,
  type ChatSettings,
  type TenantSettings,
} from "@aep/application";
import type { TenantId, UserId } from "@aep/domain";
import type { Kysely } from "kysely";
import { appendAudit } from "./member-repository.ts";
import type { Database } from "./schema.ts";
import { withTenant } from "./tenant-session.ts";

export class PostgresTenantSettings implements TenantSettings {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async chat(tenantId: TenantId): Promise<ChatSettings> {
    const row = await withTenant(this.#db, tenantId, (trx) =>
      trx
        .selectFrom("tenant_settings")
        .select(["chat_model", "updated_by", "updated_at"])
        .where("tenant_id", "=", tenantId)
        .executeTakeFirst(),
    );
    if (row === undefined) return {};
    // A model taken off the list since it was chosen reads as the default.
    const model =
      row.chat_model !== null && isChatModel(row.chat_model) ? row.chat_model : undefined;
    return {
      ...(model === undefined ? {} : { model }),
      updatedBy: row.updated_by as UserId,
      updatedAt: row.updated_at,
    };
  }

  async setChat(
    tenantId: TenantId,
    change: { readonly model?: ChatModel; readonly by: UserId; readonly at: Date },
    audit: AuditEventInput,
  ): Promise<void> {
    await withTenant(this.#db, tenantId, async (trx) => {
      const values = {
        chat_model: change.model ?? null,
        updated_by: change.by,
        updated_at: change.at,
      };
      await trx
        .insertInto("tenant_settings")
        .values({ tenant_id: tenantId, ...values })
        .onConflict((oc) => oc.column("tenant_id").doUpdateSet(values))
        .execute();
      await appendAudit(trx, tenantId, [audit]);
    });
  }
}
