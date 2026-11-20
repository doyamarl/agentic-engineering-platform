import type { PeopleDirectory, Person } from "@aep/application";
import type { TenantId, UserId } from "@aep/domain";
import type { Kysely } from "kysely";
import type { Database } from "./schema.ts";
import { withTenant } from "./tenant-session.ts";

export class PostgresPeopleDirectory implements PeopleDirectory {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async list(tenantId: TenantId): Promise<readonly Person[]> {
    const rows = await withTenant(this.#db, tenantId, (trx) =>
      trx
        .selectFrom("memberships as m")
        .innerJoin("users as u", "u.id", "m.user_id")
        .select(["u.id", "u.display_name"])
        .where("m.tenant_id", "=", tenantId)
        .where("u.disabled_at", "is", null)
        .orderBy("u.display_name")
        .orderBy("u.id")
        .execute(),
    );
    return rows.map((row) => ({ userId: row.id as UserId, displayName: row.display_name }));
  }
}
