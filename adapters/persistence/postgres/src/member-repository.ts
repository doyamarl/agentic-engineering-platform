import {
  disconnectJob,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventType,
  type AuditLog,
  type Member,
  type MemberChange,
  type MemberRepository,
  type MemberWriteError,
  type NewMember,
} from "@aep/application";
import { err, isRole, ok, type Result, type TenantId, type UserId } from "@aep/domain";
import { sql, type Kysely, type Transaction } from "kysely";
import { enqueueJob } from "./job-queue.ts";
import type { Database } from "./schema.ts";
import { withTenant } from "./tenant-session.ts";

// Members and the audit log (migration 0009). Everything runs inside withTenant, so memberships
// and audit_events are filtered by RLS and users can only be updated for this tenant's members.

/** Thrown inside a transaction to roll it back and report the error. */
class Abort extends Error {
  readonly error: MemberWriteError;
  constructor(error: MemberWriteError) {
    super(error.kind);
    this.error = error;
  }
}

const isUniqueViolation = (error: unknown, constraint: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23505" &&
  "constraint" in error &&
  error.constraint === constraint;

type Trx = Transaction<Database>;

function selectMembers(trx: Trx, tenantId: TenantId) {
  return trx
    .selectFrom("memberships as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .leftJoin("password_credentials as c", "c.user_id", "m.user_id")
    .select([
      "m.user_id",
      "m.role",
      "u.display_name",
      "u.email",
      "u.disabled_at",
      "u.created_at",
      "c.user_id as credential_user_id",
    ])
    .where("m.tenant_id", "=", tenantId);
}

type MemberRow = Awaited<ReturnType<ReturnType<typeof selectMembers>["executeTakeFirstOrThrow"]>>;

function toMember(row: MemberRow): Member {
  if (!isRole(row.role)) throw new Error(`unknown role in memberships: ${String(row.role)}`);
  return {
    userId: row.user_id as UserId,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    disabled: row.disabled_at !== null,
    passwordLogin: row.credential_user_id !== null,
    createdAt: row.created_at,
  };
}

async function readMember(trx: Trx, tenantId: TenantId, userId: UserId): Promise<Member> {
  return toMember(
    await selectMembers(trx, tenantId).where("m.user_id", "=", userId).executeTakeFirstOrThrow(),
  );
}

export async function appendAudit(
  trx: Trx,
  tenantId: TenantId,
  events: readonly AuditEventInput[],
): Promise<void> {
  if (events.length === 0) return;
  await trx
    .insertInto("audit_events")
    .values(
      events.map((event) => ({
        tenant_id: tenantId,
        type: event.type,
        actor_user_id: event.actorId,
        subject_user_id: event.subjectId,
        payload: JSON.stringify(event.payload),
      })),
    )
    .execute();
}

/**
 * ADR-013: disabling a member deletes their connector tokens and asks each provider to revoke
 * them. The worker does both, as the member, from the jobs enqueued here with the change.
 */
async function disconnectAll(
  trx: Trx,
  tenantId: TenantId,
  userId: UserId,
  actorId: UserId | null,
): Promise<void> {
  // Admins see every member's connections (migration 0016); tokens stay out of reach.
  await sql`select set_config('app.connection_admin', 'on', true)`.execute(trx);
  const at = new Date();
  const rows = await trx
    .updateTable("connections")
    .set({ status: "disconnecting", updated_at: at })
    .where("user_id", "=", userId)
    .returning("connector_id")
    .execute();
  for (const row of rows) {
    await enqueueJob(
      trx,
      disconnectJob(tenantId, userId, row.connector_id, "member_disabled", actorId, at),
    );
  }
}

async function revokeSessions(trx: Trx, userId: UserId): Promise<void> {
  await trx
    .updateTable("sessions")
    .set({ revoked_at: sql`now()` })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .execute();
}

/** Runs fn in the tenant's transaction, turning an Abort into an error result. */
async function attempt<T>(
  db: Kysely<Database>,
  tenantId: TenantId,
  fn: (trx: Trx) => Promise<T>,
): Promise<Result<T, MemberWriteError>> {
  try {
    return ok(await withTenant(db, tenantId, fn));
  } catch (error) {
    if (error instanceof Abort) return err(error.error);
    throw error;
  }
}

export class PostgresMemberRepository implements MemberRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async list(tenantId: TenantId): Promise<readonly Member[]> {
    const rows = await withTenant(this.#db, tenantId, (trx) =>
      selectMembers(trx, tenantId).orderBy("u.created_at").orderBy("m.user_id").execute(),
    );
    return rows.map(toMember);
  }

  async find(tenantId: TenantId, userId: UserId): Promise<Member | undefined> {
    const row = await withTenant(this.#db, tenantId, (trx) =>
      selectMembers(trx, tenantId).where("m.user_id", "=", userId).executeTakeFirst(),
    );
    return row && toMember(row);
  }

  create(
    tenantId: TenantId,
    member: NewMember,
    audit: AuditEventInput,
  ): Promise<Result<Member, MemberWriteError>> {
    return attempt(this.#db, tenantId, async (trx) => {
      try {
        await trx
          .insertInto("users")
          .values({ id: member.userId, display_name: member.displayName, email: member.email })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error, "users_email_key")) throw new Abort({ kind: "EmailTaken" });
        throw error;
      }
      await trx
        .insertInto("memberships")
        .values({ tenant_id: tenantId, user_id: member.userId, role: member.role })
        .execute();
      await trx
        .insertInto("password_credentials")
        .values({
          user_id: member.userId,
          tenant_id: tenantId,
          password_hash: member.passwordHash,
          must_change_password: true,
        })
        .execute();
      await appendAudit(trx, tenantId, [audit]);
      return readMember(trx, tenantId, member.userId);
    });
  }

  update(
    tenantId: TenantId,
    expected: Member,
    change: MemberChange,
    audit: readonly AuditEventInput[],
  ): Promise<Result<Member, MemberWriteError>> {
    const userId = expected.userId;
    return attempt(this.#db, tenantId, async (trx) => {
      // Lock the tenant's active admins first, always in the same order, so two admins demoting
      // each other at once queue up instead of deadlocking, and the count below stays true.
      const activeAdmins = await trx
        .selectFrom("memberships as m")
        .innerJoin("users as u", "u.id", "m.user_id")
        .select("m.user_id")
        .where("m.tenant_id", "=", tenantId)
        .where("m.role", "=", "admin")
        .where("u.disabled_at", "is", null)
        .orderBy("m.user_id")
        .forUpdate("m")
        .execute();
      const current = await trx
        .selectFrom("memberships as m")
        .innerJoin("users as u", "u.id", "m.user_id")
        .select(["m.role", "u.disabled_at"])
        .where("m.tenant_id", "=", tenantId)
        .where("m.user_id", "=", userId)
        .forUpdate("m")
        .executeTakeFirst();
      if (!current) throw new Abort({ kind: "NotFound" });
      if (current.role !== expected.role || (current.disabled_at !== null) !== expected.disabled) {
        throw new Abort({ kind: "Stale" });
      }

      const role = change.role ?? expected.role;
      const disabled = change.disabled ?? expected.disabled;
      const remaining = activeAdmins.filter((a) => a.user_id !== userId).length;
      if (remaining === 0 && !(role === "admin" && !disabled))
        throw new Abort({ kind: "LastAdmin" });

      if (change.role !== undefined) {
        await trx
          .updateTable("memberships")
          .set({ role: change.role })
          .where("tenant_id", "=", tenantId)
          .where("user_id", "=", userId)
          .execute();
      }
      if (change.disabled !== undefined) {
        await trx
          .updateTable("users")
          .set({ disabled_at: change.disabled ? sql`now()` : null })
          .where("id", "=", userId)
          .execute();
        if (change.disabled) {
          await revokeSessions(trx, userId);
          await disconnectAll(trx, tenantId, userId, audit[0]?.actorId ?? null);
        }
      }
      await appendAudit(trx, tenantId, audit);
      return readMember(trx, tenantId, userId);
    });
  }

  resetPassword(
    tenantId: TenantId,
    userId: UserId,
    passwordHash: string,
    audit: AuditEventInput,
  ): Promise<Result<Member, MemberWriteError>> {
    return attempt(this.#db, tenantId, async (trx) => {
      const membership = await trx
        .selectFrom("memberships")
        .select("user_id")
        .where("tenant_id", "=", tenantId)
        .where("user_id", "=", userId)
        .forUpdate()
        .executeTakeFirst();
      if (!membership) throw new Abort({ kind: "NotFound" });
      await trx
        .insertInto("password_credentials")
        .values({
          user_id: userId,
          tenant_id: tenantId,
          password_hash: passwordHash,
          must_change_password: true,
        })
        .onConflict((oc) =>
          oc.column("user_id").doUpdateSet({
            password_hash: passwordHash,
            must_change_password: true,
            failed_attempts: 0,
            locked_until: null,
            updated_at: sql`now()`,
          }),
        )
        .execute();
      await revokeSessions(trx, userId);
      await appendAudit(trx, tenantId, [audit]);
      return readMember(trx, tenantId, userId);
    });
  }
}

export class PostgresAuditLog implements AuditLog {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async record(tenantId: TenantId, event: AuditEventInput): Promise<void> {
    await withTenant(this.#db, tenantId, (trx) => appendAudit(trx, tenantId, [event]));
  }

  async list(
    tenantId: TenantId,
    options: { readonly afterId?: number; readonly limit: number },
  ): Promise<readonly AuditEvent[]> {
    const rows = await withTenant(this.#db, tenantId, (trx) => {
      let query = trx
        .selectFrom("audit_events")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .orderBy("id")
        .limit(options.limit);
      if (options.afterId !== undefined) query = query.where("id", ">", String(options.afterId));
      return query.execute();
    });
    return rows.map((row) => ({
      id: Number(row.id),
      type: row.type as AuditEventType,
      actorId: row.actor_user_id as UserId | null,
      subjectId: row.subject_user_id as UserId | null,
      payload: row.payload as AuditEvent["payload"],
      occurredAt: row.occurred_at,
    }));
  }
}
