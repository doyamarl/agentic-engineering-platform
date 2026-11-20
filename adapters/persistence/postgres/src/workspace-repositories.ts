import {
  type AuditEventInput,
  type RepositoryRef,
  type WorkspaceRepositories,
  type WorkspaceRepository,
} from "@aep/application";
import { err, ok, type Result, type TenantId, type UserId, type WorkspaceId } from "@aep/domain";
import { sql, type Kysely } from "kysely";
import { appendAudit } from "./member-repository.ts";
import type { Database } from "./schema.ts";
import { withTenant } from "./tenant-session.ts";

// The GitHub repositories of a workspace (migration 0020). Row-level security keeps each tenant
// to its own rows; changes and their audit events commit together.

export class PostgresWorkspaceRepositories implements WorkspaceRepositories {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async list(
    tenantId: TenantId,
    workspaceId: WorkspaceId,
  ): Promise<readonly WorkspaceRepository[] | undefined> {
    return withTenant(this.#db, tenantId, async (trx) => {
      const workspace = await trx
        .selectFrom("workspaces")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .where("id", "=", workspaceId)
        .executeTakeFirst();
      if (workspace === undefined) return undefined;
      const rows = await trx
        .selectFrom("workspace_repositories")
        .select(["owner", "name", "added_by", "added_at"])
        .where("tenant_id", "=", tenantId)
        .where("workspace_id", "=", workspaceId)
        .orderBy(sql`lower(owner)`)
        .orderBy(sql`lower(name)`)
        .execute();
      return rows.map((row) => ({
        owner: row.owner,
        name: row.name,
        addedBy: row.added_by as UserId,
        addedAt: row.added_at,
      }));
    });
  }

  async add(
    tenantId: TenantId,
    workspaceId: WorkspaceId,
    repository: WorkspaceRepository,
    audit: AuditEventInput,
  ): Promise<Result<"added" | "exists", { readonly kind: "WorkspaceNotFound" }>> {
    return withTenant(this.#db, tenantId, async (trx) => {
      const workspace = await trx
        .selectFrom("workspaces")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .where("id", "=", workspaceId)
        .executeTakeFirst();
      if (workspace === undefined) return err({ kind: "WorkspaceNotFound" } as const);
      const inserted = await trx
        .insertInto("workspace_repositories")
        .values({
          tenant_id: tenantId,
          workspace_id: workspaceId,
          owner: repository.owner,
          name: repository.name,
          added_by: repository.addedBy,
          added_at: repository.addedAt,
        })
        // The unique index workspace_repositories_unique.
        .onConflict((oc) =>
          oc.expression(sql`tenant_id, workspace_id, lower(owner), lower(name)`).doNothing(),
        )
        .executeTakeFirst();
      if (inserted.numInsertedOrUpdatedRows === 0n) return ok("exists" as const);
      await appendAudit(trx, tenantId, [audit]);
      return ok("added" as const);
    });
  }

  async remove(
    tenantId: TenantId,
    workspaceId: WorkspaceId,
    repository: RepositoryRef,
    audit: AuditEventInput,
  ): Promise<boolean> {
    return withTenant(this.#db, tenantId, async (trx) => {
      const removed = await trx
        .deleteFrom("workspace_repositories")
        .where("tenant_id", "=", tenantId)
        .where("workspace_id", "=", workspaceId)
        .where(sql`lower(owner)`, "=", repository.owner.toLowerCase())
        .where(sql`lower(name)`, "=", repository.name.toLowerCase())
        .executeTakeFirst();
      if (removed.numDeletedRows === 0n) return false;
      await appendAudit(trx, tenantId, [audit]);
      return true;
    });
  }
}
