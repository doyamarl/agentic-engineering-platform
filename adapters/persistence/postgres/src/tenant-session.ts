import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "./schema.ts";

/**
 * Runs fn in a transaction whose row-level security scope is tenantId.
 * The setting is transaction-local (set_config(..., true)), so it cannot leak to the next
 * transaction that reuses the pooled connection.
 */
export function withTenant<T>(
  db: Kysely<Database>,
  tenantId: string,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}

/**
 * Like withTenant, and also scopes row-level security to userId (app.user_id). Tables filtered by
 * user, such as threads (ADR-014), show nothing to a transaction opened with withTenant alone.
 */
export function withTenantUser<T>(
  db: Kysely<Database>,
  scope: { readonly tenantId: string; readonly userId: string },
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.tenant_id', ${scope.tenantId}, true),
      set_config('app.user_id', ${scope.userId}, true)`.execute(trx);
    return fn(trx);
  });
}
