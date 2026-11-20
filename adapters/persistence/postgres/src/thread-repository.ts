import type {
  NewJob,
  ThreadEvent,
  ThreadEventInput,
  ThreadRepository,
  ThreadScope,
} from "@aep/application";
import {
  err,
  ok,
  type MessageId,
  type Result,
  type TenantId,
  type Thread,
  type ThreadId,
  type ThreadMessage,
  type ThreadVisibility,
  type UserId,
  type WorkspaceId,
} from "@aep/domain";
import {
  sql,
  type ExpressionBuilder,
  type Kysely,
  type Selectable,
  type Transaction,
} from "kysely";
import type { Database, ThreadMessagesTable, ThreadsTable } from "./schema.ts";
import { enqueueJob } from "./job-queue.ts";
import { withTenantUser } from "./tenant-session.ts";

const WORKSPACE_FK = "threads_tenant_id_workspace_id_fkey";
const MEMBER_FK = "thread_members_tenant_id_user_id_fkey";

/** Thrown inside a transaction to roll it back and report MemberNotFound. */
class MemberMissing extends Error {}

const isForeignKeyViolation = (error: unknown, constraint: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23503" &&
  "constraint" in error &&
  error.constraint === constraint;

/**
 * The read rule of ADR-014, written out in the query as well as in the RLS policy thread_read,
 * so the adapter does not depend on the policy alone.
 */
const readableBy = (scope: ThreadScope) => (eb: ExpressionBuilder<Database, "threads">) =>
  eb.and([
    eb("threads.tenant_id", "=", scope.tenantId),
    eb.or([
      eb("threads.owner_id", "=", scope.userId),
      eb("threads.visibility", "=", "workspace"),
      eb.and([
        eb("threads.visibility", "=", "members"),
        eb.exists(
          eb
            .selectFrom("thread_members as m")
            .select(sql.lit(1).as("one"))
            .whereRef("m.tenant_id", "=", "threads.tenant_id")
            .whereRef("m.thread_id", "=", "threads.id")
            .where("m.user_id", "=", scope.userId),
        ),
      ]),
    ]),
  ]);

function toThread(row: Selectable<ThreadsTable>, memberIds: readonly UserId[]): Thread {
  const visibility: ThreadVisibility =
    row.visibility === "members" ? { kind: "members", memberIds } : { kind: row.visibility };
  return {
    tenantId: row.tenant_id as TenantId,
    workspaceId: row.workspace_id as WorkspaceId,
    id: row.id as ThreadId,
    ownerId: row.owner_id as UserId,
    title: row.title,
    visibility,
    createdAt: row.created_at,
  };
}

function toMessage(row: Selectable<ThreadMessagesTable>): ThreadMessage {
  return {
    tenantId: row.tenant_id as TenantId,
    threadId: row.thread_id as ThreadId,
    id: row.id as MessageId,
    role: row.role,
    ...(row.author_id === null ? {} : { authorId: row.author_id as UserId }),
    ...(row.in_reply_to === null ? {} : { inReplyTo: row.in_reply_to as MessageId }),
    ...(row.effort === null ? {} : { effort: row.effort }),
    ...(row.model === null ? {} : { model: row.model }),
    content: row.content,
    createdAt: row.created_at,
  };
}

/** The chosen members the scope's user may see: all of them for the owner, else only itself. */
async function membersOf(
  trx: Transaction<Database>,
  scope: ThreadScope,
  threadIds: readonly string[],
): Promise<Map<string, UserId[]>> {
  const members = new Map<string, UserId[]>();
  if (threadIds.length === 0) return members;
  const rows = await trx
    .selectFrom("thread_members")
    .select(["thread_id", "user_id"])
    .where("tenant_id", "=", scope.tenantId)
    .where("thread_id", "in", threadIds)
    .where((eb) => eb.or([eb("owner_id", "=", scope.userId), eb("user_id", "=", scope.userId)]))
    .orderBy("added_at")
    .orderBy("user_id")
    .execute();
  for (const row of rows) {
    const list = members.get(row.thread_id) ?? [];
    list.push(row.user_id as UserId);
    members.set(row.thread_id, list);
  }
  return members;
}

async function findReadable(
  trx: Transaction<Database>,
  scope: ThreadScope,
  id: ThreadId,
): Promise<Thread | undefined> {
  const row = await trx
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", id)
    .where(readableBy(scope))
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const members = await membersOf(trx, scope, [row.id]);
  return toThread(row, members.get(row.id) ?? []);
}

/**
 * Serialises appends to one thread, so the event sequence has no gaps or races, and reports
 * whether the scope's user may read it. Members who are not the owner cannot lock the thread row
 * (no UPDATE policy for them), so this takes an advisory lock instead.
 */
export async function lockReadable(
  trx: Transaction<Database>,
  scope: ThreadScope,
  threadId: ThreadId,
): Promise<boolean> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${threadId}, 0))`.execute(trx);
  return (await findReadable(trx, scope, threadId)) !== undefined;
}

async function insertMessage(trx: Transaction<Database>, message: ThreadMessage): Promise<void> {
  await trx
    .insertInto("thread_messages")
    .values({
      tenant_id: message.tenantId,
      thread_id: message.threadId,
      id: message.id,
      role: message.role,
      author_id: message.authorId ?? null,
      content: message.content,
      in_reply_to: message.inReplyTo ?? null,
      effort: message.effort ?? null,
      model: message.model ?? null,
      created_at: message.createdAt,
    })
    .execute();
}

export async function insertEvent(
  trx: Transaction<Database>,
  tenantId: string,
  threadId: string,
  event: ThreadEventInput,
  at: Date,
): Promise<void> {
  await trx
    .insertInto("thread_events")
    .values({
      tenant_id: tenantId,
      thread_id: threadId,
      seq: sql<string>`(select coalesce(max(seq), 0) + 1 from thread_events
        where tenant_id = ${tenantId} and thread_id = ${threadId})`,
      type: event.type,
      payload: JSON.stringify(event.payload),
      actor_kind: event.actor.kind,
      actor_id: event.actor.id ?? null,
      occurred_at: at,
    })
    .execute();
}

async function findReplyIn(
  trx: Transaction<Database>,
  scope: ThreadScope,
  threadId: string,
  messageId: string,
): Promise<ThreadMessage | undefined> {
  const row = await trx
    .selectFrom("thread_messages")
    .selectAll()
    .where("tenant_id", "=", scope.tenantId)
    .where("thread_id", "=", threadId)
    .where("in_reply_to", "=", messageId)
    .executeTakeFirst();
  return row === undefined ? undefined : toMessage(row);
}

export class PostgresThreadRepository implements ThreadRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async insert(thread: Thread): Promise<Result<void, { readonly kind: "WorkspaceNotFound" }>> {
    try {
      await withTenantUser(this.#db, { tenantId: thread.tenantId, userId: thread.ownerId }, (trx) =>
        trx
          .insertInto("threads")
          .values({
            tenant_id: thread.tenantId,
            workspace_id: thread.workspaceId,
            id: thread.id,
            owner_id: thread.ownerId,
            title: thread.title,
            visibility: "personal",
            created_at: thread.createdAt,
            updated_at: thread.createdAt,
          })
          .execute(),
      );
      return ok(undefined);
    } catch (error) {
      if (isForeignKeyViolation(error, WORKSPACE_FK)) {
        return err({ kind: "WorkspaceNotFound" } as const);
      }
      throw error;
    }
  }

  findById(scope: ThreadScope, id: ThreadId): Promise<Thread | undefined> {
    return withTenantUser(this.#db, scope, (trx) => findReadable(trx, scope, id));
  }

  list(
    scope: ThreadScope,
    filter: { readonly workspaceId?: WorkspaceId; readonly limit: number },
  ): Promise<readonly Thread[]> {
    return withTenantUser(this.#db, scope, async (trx) => {
      let query = trx.selectFrom("threads").selectAll().where(readableBy(scope));
      if (filter.workspaceId !== undefined) {
        query = query.where("workspace_id", "=", filter.workspaceId);
      }
      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(filter.limit)
        .execute();
      const members = await membersOf(
        trx,
        scope,
        rows.filter((row) => row.visibility === "members").map((row) => row.id),
      );
      return rows.map((row) => toThread(row, members.get(row.id) ?? []));
    });
  }

  async setVisibility(
    scope: ThreadScope,
    id: ThreadId,
    visibility: ThreadVisibility,
    at: Date,
  ): Promise<Result<Thread, { readonly kind: "NotFound" } | { readonly kind: "MemberNotFound" }>> {
    try {
      return await withTenantUser(this.#db, scope, async (trx) => {
        const row = await trx
          .updateTable("threads")
          .set({ visibility: visibility.kind, updated_at: at })
          .where("tenant_id", "=", scope.tenantId)
          .where("id", "=", id)
          .where("owner_id", "=", scope.userId)
          .returningAll()
          .executeTakeFirst();
        if (row === undefined) return err({ kind: "NotFound" } as const);
        await trx
          .deleteFrom("thread_members")
          .where("tenant_id", "=", scope.tenantId)
          .where("thread_id", "=", id)
          .execute();
        const memberIds = visibility.kind === "members" ? visibility.memberIds : [];
        if (memberIds.length > 0) {
          try {
            await trx
              .insertInto("thread_members")
              .values(
                memberIds.map((userId) => ({
                  tenant_id: scope.tenantId,
                  thread_id: id,
                  owner_id: scope.userId,
                  user_id: userId,
                  added_at: at,
                })),
              )
              .execute();
          } catch (error) {
            if (isForeignKeyViolation(error, MEMBER_FK)) throw new MemberMissing();
            throw error;
          }
        }
        return ok(toThread(row, memberIds));
      });
    } catch (error) {
      if (error instanceof MemberMissing) return err({ kind: "MemberNotFound" } as const);
      throw error;
    }
  }

  appendMessage(
    scope: ThreadScope,
    message: ThreadMessage,
    event: ThreadEventInput,
    enqueue?: NewJob,
  ): Promise<Result<void, { readonly kind: "NotFound" }>> {
    return withTenantUser(this.#db, scope, async (trx) => {
      if (!(await lockReadable(trx, scope, message.threadId))) {
        return err({ kind: "NotFound" } as const);
      }
      await insertMessage(trx, message);
      await insertEvent(trx, message.tenantId, message.threadId, event, message.createdAt);
      if (enqueue !== undefined) await enqueueJob(trx, enqueue);
      return ok(undefined);
    });
  }

  appendEvent(
    scope: ThreadScope,
    threadId: ThreadId,
    event: ThreadEventInput,
    at: Date,
  ): Promise<Result<void, { readonly kind: "NotFound" }>> {
    return withTenantUser(this.#db, scope, async (trx) => {
      if (!(await lockReadable(trx, scope, threadId))) return err({ kind: "NotFound" } as const);
      await insertEvent(trx, scope.tenantId, threadId, event, at);
      return ok(undefined);
    });
  }

  appendReply(
    scope: ThreadScope,
    reply: ThreadMessage,
    event: ThreadEventInput,
  ): Promise<Result<"stored" | "exists", { readonly kind: "NotFound" }>> {
    const inReplyTo = reply.inReplyTo;
    if (inReplyTo === undefined) throw new Error("a reply names the message it answers");
    return withTenantUser(this.#db, scope, async (trx) => {
      if (!(await lockReadable(trx, scope, reply.threadId))) {
        return err({ kind: "NotFound" } as const);
      }
      // The lock serialises appends to the thread, so this check cannot race another attempt.
      if ((await findReplyIn(trx, scope, reply.threadId, inReplyTo)) !== undefined) {
        return ok("exists" as const);
      }
      await insertMessage(trx, reply);
      await insertEvent(trx, reply.tenantId, reply.threadId, event, reply.createdAt);
      return ok("stored" as const);
    });
  }

  findReply(
    scope: ThreadScope,
    threadId: ThreadId,
    messageId: MessageId,
  ): Promise<ThreadMessage | undefined> {
    return withTenantUser(this.#db, scope, async (trx) =>
      (await findReadable(trx, scope, threadId)) === undefined
        ? undefined
        : findReplyIn(trx, scope, threadId, messageId),
    );
  }

  listMessages(
    scope: ThreadScope,
    id: ThreadId,
    page: { readonly limit: number; readonly upTo?: MessageId },
  ): Promise<readonly ThreadMessage[]> {
    return withTenantUser(this.#db, scope, async (trx) => {
      if ((await findReadable(trx, scope, id)) === undefined) return [];
      const base = trx
        .selectFrom("thread_messages")
        .selectAll()
        .where("tenant_id", "=", scope.tenantId)
        .where("thread_id", "=", id);
      if (page.upTo === undefined) {
        const rows = await base.orderBy("created_at").orderBy("id").limit(page.limit).execute();
        return rows.map(toMessage);
      }
      const end = await base.where("id", "=", page.upTo).executeTakeFirst();
      if (end === undefined) return [];
      // Messages are ordered by (created_at, id); take the last `limit` up to `end`.
      const rows = await base
        .where((eb) =>
          eb.or([
            eb("created_at", "<", end.created_at),
            eb.and([eb("created_at", "=", end.created_at), eb("id", "<=", end.id)]),
          ]),
        )
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(page.limit)
        .execute();
      return rows.reverse().map(toMessage);
    });
  }

  listEvents(
    scope: ThreadScope,
    id: ThreadId,
    page: { readonly afterSeq?: number; readonly limit: number },
  ): Promise<readonly ThreadEvent[]> {
    return withTenantUser(this.#db, scope, async (trx) => {
      if ((await findReadable(trx, scope, id)) === undefined) return [];
      const rows = await trx
        .selectFrom("thread_events")
        .select(["seq", "type", "payload", "actor_kind", "actor_id", "occurred_at"])
        .where("tenant_id", "=", scope.tenantId)
        .where("thread_id", "=", id)
        .where("seq", ">", String(page.afterSeq ?? 0))
        .orderBy("seq")
        .limit(page.limit)
        .execute();
      return rows.map((row) => ({
        seq: Number(row.seq),
        type: row.type,
        payload: row.payload as ThreadEvent["payload"],
        actor: { kind: row.actor_kind, ...(row.actor_id === null ? {} : { id: row.actor_id }) },
        occurredAt: row.occurred_at,
      }));
    });
  }
}
