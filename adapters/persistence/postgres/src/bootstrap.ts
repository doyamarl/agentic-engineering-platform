import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { issueApiToken } from "./identity.ts";
import type { Database } from "./schema.ts";
import { withTenant } from "./tenant-session.ts";

export type BootstrappedTenant = {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
  /** Plaintext admin token. Shown once; only its digest is stored. */
  readonly token: string;
};

/**
 * Creates a tenant with one workspace and one admin member, and issues that admin a token.
 * With `adminEmail` and `adminPasswordHash` the admin can also log in with a password, which
 * must be changed at first login.
 * Runs as the table owner; row-level security is forced on owners too, so tenant-scoped inserts
 * happen inside the new tenant's scope.
 */
export function bootstrapTenant(
  db: Kysely<Database>,
  input: {
    tenantName: string;
    workspaceName: string;
    adminName: string;
    /** Normalized (lower-case, trimmed). */
    adminEmail?: string;
    adminPasswordHash?: string;
  },
): Promise<BootstrappedTenant> {
  const tenantId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  return withTenant(db, tenantId, async (trx) => {
    await trx.insertInto("tenants").values({ id: tenantId, name: input.tenantName }).execute();
    await trx
      .insertInto("users")
      .values({ id: userId, display_name: input.adminName, email: input.adminEmail ?? null })
      .execute();
    await trx
      .insertInto("workspaces")
      .values({ tenant_id: tenantId, id: workspaceId, name: input.workspaceName })
      .execute();
    await trx
      .insertInto("memberships")
      .values({ tenant_id: tenantId, user_id: userId, role: "admin" })
      .execute();
    if (input.adminPasswordHash !== undefined) {
      await trx
        .insertInto("password_credentials")
        .values({
          user_id: userId,
          tenant_id: tenantId,
          password_hash: input.adminPasswordHash,
          must_change_password: true,
        })
        .execute();
    }
    const token = await issueApiToken(trx, { tenantId, userId, name: "bootstrap" });
    return { tenantId, workspaceId, userId, token };
  });
}
