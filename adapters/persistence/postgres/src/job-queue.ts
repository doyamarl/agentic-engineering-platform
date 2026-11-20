import type { FailOutcome, Job, JobPayload, JobQueue, NewJob } from "@aep/application";
import type { TenantId } from "@aep/domain";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { Database, JobsTable } from "./schema.ts";

// JobQueue on the jobs table (migrations/0003_jobs.ts). Lease times come from the database clock
// (now()), so workers on hosts with skewed clocks agree on when a lease has expired.

const DEFAULT_MAX_ATTEMPTS = 5;

function toJob(row: Selectable<JobsTable>): Job {
  return {
    id: row.id,
    tenantId: row.tenant_id as TenantId,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    payload: row.payload as JobPayload,
    attempt: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
  };
}

/**
 * Enqueues on `db`, which may be a transaction: enqueue inside the transaction that changes the
 * state calling for the job (outbox), so the job exists if and only if that change committed.
 */
export async function enqueueJob(
  db: Kysely<Database> | Transaction<Database>,
  job: NewJob,
): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insertInto("jobs")
    .values({
      tenant_id: job.tenantId,
      kind: job.kind,
      idempotency_key: job.idempotencyKey,
      payload: JSON.stringify(job.payload),
      max_attempts: job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      ...(job.runAfter === undefined ? {} : { run_after: job.runAfter }),
      locked_by: null,
      locked_until: null,
      last_error: null,
      finished_at: null,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "kind", "idempotency_key"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted !== undefined) return { id: inserted.id, created: true };
  const existing = await db
    .selectFrom("jobs")
    .select("id")
    .where("tenant_id", "=", job.tenantId)
    .where("kind", "=", job.kind)
    .where("idempotency_key", "=", job.idempotencyKey)
    .executeTakeFirstOrThrow();
  return { id: existing.id, created: false };
}

const leaseUntil = (leaseMs: number) =>
  sql<Date>`now() + ${String(Math.max(1, Math.round(leaseMs)))} * interval '1 millisecond'`;

export class PostgresJobQueue implements JobQueue {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  enqueue(job: NewJob) {
    return enqueueJob(this.#db, job);
  }

  async claim(workerId: string, kinds: readonly string[], leaseMs: number) {
    if (kinds.length === 0) return undefined;
    const kindList = sql`array[${sql.join(kinds.map((k) => sql`${k}`))}]::text[]`;
    // One statement: dead-letter expired leases of dead-letter passes (attempts beyond the last),
    // then take the next due job (queued and due, or running with an expired lease) that no other
    // worker is taking. An expired last attempt is taken once more, as a dead-letter pass, so the
    // worker can run its onDead hook before the job is dead (see Job.attempt).
    const result = await sql<Selectable<JobsTable>>`
      with exhausted as (
        update jobs
        set status = 'dead', locked_by = null, locked_until = null, finished_at = now(),
            updated_at = now(),
            last_error = left('lease expired while dead-lettering; previous error: '
              || coalesce(last_error, 'none'), 2000)
        where kind = any(${kindList}) and status = 'running' and locked_until < now()
          and attempts > max_attempts
      ),
      next as (
        select id from jobs
        where kind = any(${kindList})
          and ((status = 'queued' and run_after <= now())
            or (status = 'running' and locked_until < now() and attempts <= max_attempts))
        order by run_after, created_at
        limit 1
        for update skip locked
      )
      update jobs
      set status = 'running', attempts = jobs.attempts + 1, locked_by = ${workerId},
          locked_until = ${leaseUntil(leaseMs)}, updated_at = now()
      from next
      where jobs.id = next.id
      returning jobs.*
    `.execute(this.#db);
    const row = result.rows[0];
    return row && toJob(row);
  }

  async heartbeat(jobId: string, workerId: string, leaseMs: number) {
    const row = await this.#db
      .updateTable("jobs")
      .set({ locked_until: leaseUntil(leaseMs), updated_at: sql`now()` })
      .where("id", "=", jobId)
      .where("status", "=", "running")
      .where("locked_by", "=", workerId)
      .returning("id")
      .executeTakeFirst();
    return row !== undefined;
  }

  async complete(jobId: string, workerId: string) {
    const row = await this.#db
      .updateTable("jobs")
      .set({
        status: "succeeded",
        locked_by: null,
        locked_until: null,
        finished_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where("id", "=", jobId)
      .where("status", "=", "running")
      .where("locked_by", "=", workerId)
      .returning("id")
      .executeTakeFirst();
    return row !== undefined;
  }

  async fail(jobId: string, workerId: string, error: string, retryAfterMs: number) {
    const exhausted = sql<boolean>`attempts >= max_attempts`;
    const row = await this.#db
      .updateTable("jobs")
      .set({
        status: sql`case when ${exhausted} then 'dead' else 'queued' end`,
        run_after: sql`now() + ${String(Math.max(0, Math.round(retryAfterMs)))} * interval '1 millisecond'`,
        finished_at: sql`case when ${exhausted} then now() end`,
        locked_by: null,
        locked_until: null,
        last_error: error.slice(0, 2000),
        updated_at: sql`now()`,
      })
      .where("id", "=", jobId)
      .where("status", "=", "running")
      .where("locked_by", "=", workerId)
      .returning("status")
      .executeTakeFirst();
    if (row === undefined) return "lost" satisfies FailOutcome;
    return (row.status === "dead" ? "dead" : "retrying") satisfies FailOutcome;
  }
}
