import type { LoginMember, OidcIdentities } from "@aep/application";
import type { TenantId, UserId } from "@aep/domain";
import type { Kysely } from "kysely";
import type { Database } from "./schema.ts";

// OIDC subjects (migration 0011). Runs before the tenant is known, so it reads only tables
// without row-level security. A member registered by an admin always has password_credentials,
// which carries the tenant; that is what a first login by email resolves to.

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23505";

const toMember = (row: {
  user_id: string;
  tenant_id: string;
  disabled_at: Date | null;
}): LoginMember => ({
  userId: row.user_id as UserId,
  tenantId: row.tenant_id as TenantId,
  disabled: row.disabled_at !== null,
});

export class PostgresOidcIdentities implements OidcIdentities {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async findBySubject(issuer: string, subject: string): Promise<LoginMember | undefined> {
    const row = await this.#db
      .selectFrom("oidc_identities as o")
      .innerJoin("users as u", "u.id", "o.user_id")
      .select(["o.user_id", "o.tenant_id", "u.disabled_at"])
      .where("o.issuer", "=", issuer)
      .where("o.subject", "=", subject)
      .executeTakeFirst();
    return row && toMember(row);
  }

  async findByEmail(email: string): Promise<LoginMember | undefined> {
    const row = await this.#db
      .selectFrom("users as u")
      .innerJoin("password_credentials as c", "c.user_id", "u.id")
      .select(["u.id as user_id", "c.tenant_id", "u.disabled_at"])
      .where("u.email", "=", email)
      .executeTakeFirst();
    return row && toMember(row);
  }

  async bind(issuer: string, subject: string, member: LoginMember): Promise<boolean> {
    try {
      await this.#db
        .insertInto("oidc_identities")
        .values({ issuer, subject, tenant_id: member.tenantId, user_id: member.userId })
        .execute();
      return true;
    } catch (error) {
      // (issuer, user_id) taken: the member already has another subject at this issuer.
      // (issuer, subject) taken by a concurrent first login of the same person: same answer,
      // and the next login finds the binding.
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
}
