import type {
  ActiveSession,
  NewSession,
  PasswordAccount,
  PasswordAccounts,
  Rotation,
  Sessions,
} from "@aep/application";
import type { TenantId, UserId } from "@aep/domain";
import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";

// Password credentials and refresh sessions (migration 0008). Both tables are read before the
// tenant is known, so these queries run outside withTenant and never touch RLS tables.

export class PostgresPasswordAccounts implements PasswordAccounts {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  #select() {
    return this.#db
      .selectFrom("password_credentials as c")
      .innerJoin("users as u", "u.id", "c.user_id")
      .select([
        "c.user_id",
        "c.tenant_id",
        "c.password_hash",
        "c.must_change_password",
        "c.locked_until",
        "u.disabled_at",
      ]);
  }

  static #account(
    row:
      | {
          user_id: string;
          tenant_id: string;
          password_hash: string;
          must_change_password: boolean;
          locked_until: Date | null;
          disabled_at: Date | null;
        }
      | undefined,
  ): PasswordAccount | undefined {
    return (
      row && {
        userId: row.user_id as UserId,
        tenantId: row.tenant_id as TenantId,
        passwordHash: row.password_hash,
        mustChangePassword: row.must_change_password,
        lockedUntil: row.locked_until,
        disabled: row.disabled_at !== null,
      }
    );
  }

  async findByEmail(email: string): Promise<PasswordAccount | undefined> {
    return PostgresPasswordAccounts.#account(
      await this.#select().where("u.email", "=", email).executeTakeFirst(),
    );
  }

  async findByUserId(userId: UserId): Promise<PasswordAccount | undefined> {
    return PostgresPasswordAccounts.#account(
      await this.#select().where("c.user_id", "=", userId).executeTakeFirst(),
    );
  }

  async addFailure(userId: UserId): Promise<number> {
    const row = await this.#db
      .updateTable("password_credentials")
      .set({ failed_attempts: sql`failed_attempts + 1`, updated_at: sql`now()` })
      .where("user_id", "=", userId)
      .returning("failed_attempts")
      .executeTakeFirst();
    return row?.failed_attempts ?? 0;
  }

  async lock(userId: UserId, until: Date): Promise<void> {
    await this.#db
      .updateTable("password_credentials")
      .set({ locked_until: until, failed_attempts: 0, updated_at: sql`now()` })
      .where("user_id", "=", userId)
      .execute();
  }

  async clearFailures(userId: UserId): Promise<void> {
    await this.#db
      .updateTable("password_credentials")
      .set({ locked_until: null, failed_attempts: 0, updated_at: sql`now()` })
      .where("user_id", "=", userId)
      .where((eb) => eb.or([eb("failed_attempts", ">", 0), eb("locked_until", "is not", null)]))
      .execute();
  }

  async setPassword(userId: UserId, hash: string, mustChangePassword: boolean): Promise<void> {
    await this.#db
      .updateTable("password_credentials")
      .set({
        password_hash: hash,
        must_change_password: mustChangePassword,
        failed_attempts: 0,
        locked_until: null,
        updated_at: sql`now()`,
      })
      .where("user_id", "=", userId)
      .execute();
  }
}

function toSession(row: {
  id: string;
  tenant_id: string;
  user_id: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
}): ActiveSession {
  return {
    id: row.id,
    tenantId: row.tenant_id as TenantId,
    userId: row.user_id as UserId,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
  };
}

export class PostgresSessions implements Sessions {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async create(session: NewSession): Promise<void> {
    await this.#db
      .insertInto("sessions")
      .values({
        id: session.id,
        tenant_id: session.tenantId,
        user_id: session.userId,
        refresh_hash: session.refreshHash,
        previous_refresh_hash: null,
        idle_expires_at: session.idleExpiresAt,
        absolute_expires_at: session.absoluteExpiresAt,
        revoked_at: null,
      })
      .execute();
  }

  async rotate(
    refreshHash: string,
    next: { readonly refreshHash: string; readonly idleExpiresAt: Date },
    now: Date,
    graceSince: Date,
  ): Promise<Rotation | undefined> {
    // One statement, so two refreshes with the same token cannot both rotate.
    const rotated = await this.#db
      .updateTable("sessions")
      .set({
        previous_refresh_hash: sql`refresh_hash`,
        refresh_hash: next.refreshHash,
        idle_expires_at: sql`least(${next.idleExpiresAt}::timestamptz, absolute_expires_at)`,
        last_used_at: now,
        rotated_at: now,
      })
      .where("refresh_hash", "=", refreshHash)
      .where("revoked_at", "is", null)
      .where("idle_expires_at", ">", now)
      .where("absolute_expires_at", ">", now)
      .returning(["id", "tenant_id", "user_id", "idle_expires_at", "absolute_expires_at"])
      .executeTakeFirst();
    if (rotated) return { kind: "rotated", session: toSession(rotated) };

    const replaced = await this.#db
      .selectFrom("sessions")
      .select([
        "id",
        "tenant_id",
        "user_id",
        "idle_expires_at",
        "absolute_expires_at",
        "rotated_at",
      ])
      .where("previous_refresh_hash", "=", refreshHash)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!replaced) return undefined;
    const live = replaced.idle_expires_at > now && replaced.absolute_expires_at > now;
    if (live && replaced.rotated_at !== null && replaced.rotated_at > graceSince) {
      return { kind: "superseded", session: toSession(replaced) };
    }
    await this.#db
      .updateTable("sessions")
      .set({ revoked_at: now })
      .where("id", "=", replaced.id)
      .where("revoked_at", "is", null)
      .execute();
    return { kind: "reused" };
  }

  async revokeByRefreshHash(refreshHash: string, now: Date): Promise<void> {
    await this.#db
      .updateTable("sessions")
      .set({ revoked_at: now })
      .where("refresh_hash", "=", refreshHash)
      .where("revoked_at", "is", null)
      .execute();
  }

  async revokeAllOf(userId: UserId, now: Date): Promise<void> {
    await this.#db
      .updateTable("sessions")
      .set({ revoked_at: now })
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .execute();
  }
}
