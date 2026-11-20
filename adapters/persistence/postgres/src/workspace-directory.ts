import type { Workspace, WorkspaceDirectory } from "@aep/application";
import type { TenantId, WorkspaceId } from "@aep/domain";
import type { Kysely } from "kysely";
import type { Database } from "./schema.ts";
import { withTenant } from "./tenant-session.ts";

export class PostgresWorkspaceDirectory implements WorkspaceDirectory {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async list(tenantId: TenantId): Promise<readonly Workspace[]> {
    const rows = await withTenant(this.#db, tenantId, (trx) =>
      trx
        .selectFrom("workspaces")
        .select(["id", "name"])
        .where("tenant_id", "=", tenantId)
        .orderBy("name")
        .orderBy("id")
        .execute(),
    );
    return rows.map((row) => ({ id: row.id as WorkspaceId, name: row.name }));
  }
}
