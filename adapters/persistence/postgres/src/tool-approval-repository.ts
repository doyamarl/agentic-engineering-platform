import type {
  DecideError,
  NewJob,
  ReplyPause,
  ReplySnapshot,
  ThreadEventInput,
  ThreadScope,
  ToolApproval,
  ToolApprovalRepository,
} from "@aep/application";
import { err, ok, type MessageId, type Result, type ThreadId, type UserId } from "@aep/domain";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { enqueueJob } from "./job-queue.ts";
import { appendAudit } from "./member-repository.ts";
import type { Database, ReplyPausesTable, ToolApprovalsTable } from "./schema.ts";
import { withTenantUser } from "./tenant-session.ts";
import { insertEvent, lockReadable } from "./thread-repository.ts";

// Paused replies and their write-tool approvals (ADR-013, migration 0018). Every method runs as the
// person in the scope, and row-level security shows a row only to the person who asked, which is
// also the only person who may decide. Writes that touch the thread take the thread's lock, so
// events and decisions are ordered with the reply's other events.

type Trx = Transaction<Database>;

const toApproval = (row: Selectable<ToolApprovalsTable>): ToolApproval => ({
  id: row.id,
  pauseId: row.pause_id,
  callId: row.call_id,
  connectorId: row.connector_id,
  tool: row.tool,
  input: row.input,
  status: row.status,
});

const EMPTY: ReplySnapshot = {
  turns: [],
  callOrder: [],
  answered: [],
  text: "",
  round: 0,
  sources: [],
};

const toPause = (
  row: Selectable<ReplyPausesTable>,
  approvals: readonly ToolApproval[],
): ReplyPause => ({
  id: row.id,
  threadId: row.thread_id as ThreadId,
  messageId: row.message_id as MessageId,
  requestedBy: row.requested_by as UserId,
  snapshot: (row.snapshot as ReplySnapshot | null) ?? EMPTY,
  approvals,
  closed: row.closed_at !== null,
});

export class PostgresToolApprovals implements ToolApprovalRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  pause(
    scope: ThreadScope,
    pause: Omit<ReplyPause, "closed">,
    events: readonly ThreadEventInput[],
    at: Date,
    expiry?: NewJob,
  ): Promise<Result<void, { readonly kind: "NotFound" }>> {
    return withTenantUser(this.#db, scope, async (trx) => {
      if (!(await lockReadable(trx, scope, pause.threadId))) {
        return err({ kind: "NotFound" } as const);
      }
      await trx
        .insertInto("reply_pauses")
        .values({
          tenant_id: scope.tenantId,
          id: pause.id,
          thread_id: pause.threadId,
          message_id: pause.messageId,
          requested_by: scope.userId,
          snapshot: JSON.stringify(pause.snapshot),
          created_at: at,
        })
        .execute();
      if (pause.approvals.length > 0) {
        await trx
          .insertInto("tool_approvals")
          .values(
            pause.approvals.map((a) => ({
              tenant_id: scope.tenantId,
              id: a.id,
              pause_id: pause.id,
              requested_by: scope.userId,
              call_id: a.callId,
              connector_id: a.connectorId,
              tool: a.tool,
              input: JSON.stringify(a.input),
              status: "pending" as const,
            })),
          )
          .execute();
      }
      for (const event of events) await insertEvent(trx, scope.tenantId, pause.threadId, event, at);
      if (expiry !== undefined) await enqueueJob(trx, expiry);
      return ok(undefined);
    });
  }

  decide(
    scope: ThreadScope,
    threadId: ThreadId,
    approvalId: string,
    decision: "approve" | "reject",
    at: Date,
    effects: Parameters<ToolApprovalRepository["decide"]>[5],
  ): Promise<Result<{ readonly complete: boolean }, DecideError>> {
    return withTenantUser(this.#db, scope, async (trx) => {
      if (!(await lockReadable(trx, scope, threadId))) return err({ kind: "NotFound" } as const);
      // RLS limits both rows to the person who asked; the explicit filters say so too.
      const found = await trx
        .selectFrom("tool_approvals as a")
        .innerJoin("reply_pauses as p", (join) =>
          join.onRef("p.tenant_id", "=", "a.tenant_id").onRef("p.id", "=", "a.pause_id"),
        )
        .selectAll("a")
        .select(["p.closed_at as pause_closed_at", "p.message_id", "p.thread_id"])
        .where("a.id", "=", approvalId)
        .where("a.requested_by", "=", scope.userId)
        .where("p.thread_id", "=", threadId)
        .forUpdate()
        .executeTakeFirst();
      if (found === undefined) return err({ kind: "NotFound" } as const);
      if (found.status !== "pending" || found.pause_closed_at !== null) {
        return err({ kind: "Conflict" } as const);
      }
      const status = decision === "approve" ? "approved" : "rejected";
      await trx
        .updateTable("tool_approvals")
        .set({ status, decided_at: at })
        .where("id", "=", approvalId)
        .execute();
      const decided = { ...toApproval(found), status } satisfies ToolApproval;
      await insertEvent(trx, scope.tenantId, threadId, effects.event(decided), at);
      await appendAudit(trx, scope.tenantId, [effects.audit(decided)]);
      const left = await trx
        .selectFrom("tool_approvals")
        .select(sql<string>`count(*)`.as("n"))
        .where("pause_id", "=", found.pause_id)
        .where("status", "=", "pending")
        .executeTakeFirstOrThrow();
      const complete = Number(left.n) === 0;
      if (complete) {
        await enqueueJob(
          trx,
          effects.continuation({
            id: found.pause_id,
            threadId,
            messageId: found.message_id as MessageId,
            requestedBy: scope.userId,
            closed: false,
          }),
        );
      }
      return ok({ complete });
    });
  }

  async expire(
    scope: ThreadScope,
    pauseId: string,
    at: Date,
    effects: Parameters<ToolApprovalRepository["decide"]>[5],
  ): Promise<{ readonly expired: number }> {
    const pause = await withTenantUser(this.#db, scope, (trx) =>
      trx
        .selectFrom("reply_pauses")
        .select(["thread_id", "message_id"])
        .where("id", "=", pauseId)
        .where("requested_by", "=", scope.userId)
        .executeTakeFirst(),
    );
    if (pause === undefined) return { expired: 0 };
    const threadId = pause.thread_id as ThreadId;
    return withTenantUser(this.#db, scope, async (trx) => {
      // The thread's lock orders this with a decision arriving at the same moment.
      if (!(await lockReadable(trx, scope, threadId))) return { expired: 0 };
      const expired = await trx
        .updateTable("tool_approvals")
        .set({ status: "expired", decided_at: at })
        .where("pause_id", "=", pauseId)
        .where("requested_by", "=", scope.userId)
        .where("status", "=", "pending")
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("reply_pauses as p")
              .select(sql.lit(1).as("one"))
              .whereRef("p.tenant_id", "=", "tool_approvals.tenant_id")
              .whereRef("p.id", "=", "tool_approvals.pause_id")
              .where("p.closed_at", "is", null),
          ),
        )
        .returningAll()
        .execute();
      for (const row of expired) {
        const approval = toApproval(row);
        await insertEvent(trx, scope.tenantId, threadId, effects.event(approval), at);
        await appendAudit(trx, scope.tenantId, [effects.audit(approval)]);
      }
      if (expired.length > 0) {
        await enqueueJob(
          trx,
          effects.continuation({
            id: pauseId,
            threadId,
            messageId: pause.message_id as MessageId,
            requestedBy: scope.userId,
            closed: false,
          }),
        );
      }
      return { expired: expired.length };
    });
  }

  findPause(scope: ThreadScope, pauseId: string): Promise<ReplyPause | undefined> {
    return withTenantUser(this.#db, scope, async (trx) => {
      const row = await trx
        .selectFrom("reply_pauses")
        .selectAll()
        .where("id", "=", pauseId)
        .where("requested_by", "=", scope.userId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const approvals = await trx
        .selectFrom("tool_approvals")
        .selectAll()
        .where("pause_id", "=", pauseId)
        .execute();
      return toPause(row, approvals.map(toApproval));
    });
  }

  hasOpenPause(scope: ThreadScope, threadId: ThreadId, messageId: MessageId): Promise<boolean> {
    return withTenantUser(this.#db, scope, async (trx) => {
      const row = await trx
        .selectFrom("reply_pauses")
        .select("id")
        .where("requested_by", "=", scope.userId)
        .where("thread_id", "=", threadId)
        .where("message_id", "=", messageId)
        .where("closed_at", "is", null)
        .executeTakeFirst();
      return row !== undefined;
    });
  }

  claim(
    scope: ThreadScope,
    approvalId: string,
    call: { readonly connectorId: string; readonly tool: string; readonly input: unknown },
  ): Promise<boolean> {
    return withTenantUser(this.#db, scope, async (trx: Trx) => {
      // jsonb equality: the arguments must be the ones the person approved, key order aside.
      const claimed = await trx
        .updateTable("tool_approvals")
        .set({ status: "executing" })
        .where("id", "=", approvalId)
        .where("requested_by", "=", scope.userId)
        .where("status", "=", "approved")
        .where("connector_id", "=", call.connectorId)
        .where("tool", "=", call.tool)
        .where(sql<boolean>`input = ${JSON.stringify(call.input ?? null)}::jsonb`)
        .executeTakeFirst();
      return claimed.numUpdatedRows === 1n;
    });
  }

  async finish(scope: ThreadScope, approvalId: string, _at: Date): Promise<void> {
    await withTenantUser(this.#db, scope, (trx) =>
      trx
        .updateTable("tool_approvals")
        .set({ status: "done" })
        .where("id", "=", approvalId)
        .where("requested_by", "=", scope.userId)
        .where("status", "=", "executing")
        .execute(),
    );
  }

  async close(scope: ThreadScope, pauseId: string, at: Date): Promise<void> {
    await withTenantUser(this.#db, scope, (trx) =>
      trx
        .updateTable("reply_pauses")
        .set({ closed_at: at, snapshot: null })
        .where("id", "=", pauseId)
        .where("requested_by", "=", scope.userId)
        .where("closed_at", "is", null)
        .execute(),
    );
  }
}
