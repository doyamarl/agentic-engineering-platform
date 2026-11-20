import { createHash, randomBytes } from "node:crypto";
import type { IdentityPort, Members, Principal } from "@aep/application";
import { isRole, type TenantId, type UserId } from "@aep/domain";
import type { Kysely } from "kysely";
import type { Database } from "./schema.ts";
import { withTenant } from "./tenant-session.ts";

const PREFIX = "aep_";
/** 32 random bytes in base64url is 43 characters. */
const TOKEN_PATTERN = /^aep_[A-Za-z0-9_-]{43}$/;

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Creates a token for an existing membership and returns the plaintext. The plaintext is not
 * stored and cannot be recovered; show it to the operator once.
 */
export async function issueApiToken(
  db: Kysely<Database>,
  input: { tenantId: string; userId: string; name: string; expiresAt?: Date },
): Promise<string> {
  const token = PREFIX + randomBytes(32).toString("base64url");
  await db
    .insertInto("api_tokens")
    .values({
      tenant_id: input.tenantId,
      user_id: input.userId,
      name: input.name,
      token_hash: digest(token),
      expires_at: input.expiresAt ?? null,
      revoked_at: null,
    })
    .execute();
  return token;
}

export class PostgresIdentity implements IdentityPort, Members {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async authenticate(credential: string): Promise<Principal | undefined> {
    if (!TOKEN_PATTERN.test(credential)) return undefined;

    const token = await this.#db
      .selectFrom("api_tokens")
      .select(["tenant_id", "user_id"])
      .where("token_hash", "=", digest(credential))
      .where("revoked_at", "is", null)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", new Date())]))
      .executeTakeFirst();
    if (!token) return undefined;

    const principal = await this.principalFor(token.tenant_id as TenantId, token.user_id as UserId);
    if (!principal) return undefined;
    // A required password change gates password sessions only: an API token is a separate
    // credential, issued to the member directly, and scripts must keep working with it.
    const { mustChangePassword: _, ...withoutPasswordGate } = principal;
    return withoutPasswordGate;
  }

  /** The member's current role, or undefined if the user is disabled or not a member. */
  async principalFor(tenantId: TenantId, userId: UserId): Promise<Principal | undefined> {
    const row = await withTenant(this.#db, tenantId, (trx) =>
      trx
        .selectFrom("memberships")
        .innerJoin("users", "users.id", "memberships.user_id")
        .leftJoin("password_credentials", "password_credentials.user_id", "memberships.user_id")
        .select([
          "memberships.role",
          "users.disabled_at",
          "password_credentials.must_change_password",
        ])
        .where("memberships.tenant_id", "=", tenantId)
        .where("memberships.user_id", "=", userId)
        .executeTakeFirst(),
    );
    if (!row || row.disabled_at !== null || !isRole(row.role)) return undefined;
    return {
      tenantId,
      userId,
      role: row.role,
      ...(row.must_change_password === true ? { mustChangePassword: true } : {}),
    };
  }
}
