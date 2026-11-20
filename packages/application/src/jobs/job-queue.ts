import type { TenantId } from "@aep/domain";

// Durable background jobs (ADR-003: PostgreSQL queue/outbox). Delivery is at least once: a job
// whose worker dies is picked up again when its lease expires, so handlers must be idempotent.
// Payloads carry identifiers only; a handler loads tenant data itself, under the job's tenant,
// and re-checks that the work is still allowed (ADR §2).

/** Flat, JSON-safe values: identifiers and small flags, never tenant content or secrets. */
export type JobPayload = Readonly<Record<string, string | number | boolean | null>>;

export type NewJob = {
  readonly tenantId: TenantId;
  /** Handler name, e.g. `mission.execute`. */
  readonly kind: string;
  /**
   * Enqueueing the same (tenant, kind, key) again returns the existing job instead of adding
   * one, so retried requests and replayed events do not run work twice.
   */
  readonly idempotencyKey: string;
  readonly payload: JobPayload;
  /** Attempts before the job is dead-lettered. Defaults to 5. */
  readonly maxAttempts?: number;
  /** Earliest start. Defaults to now. */
  readonly runAfter?: Date;
};

export type Job = {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: JobPayload;
  /**
   * Including the current one. Greater than maxAttempts when the last attempt's lease expired
   * (its worker died): the job is then handed out once more only to be dead-lettered, and its
   * handler must not run (runWorker calls onDead instead).
   */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The error recorded by the previous attempt, if any. */
  readonly lastError: string | null;
};

export type FailOutcome =
  /** Queued again after the backoff. */
  | "retrying"
  /** No attempts left; kept for inspection. */
  | "dead"
  /** The worker no longer held the lease (it expired and another worker may own the job). */
  | "lost";

/**
 * Lease-based queue. Every call after claim names the worker, and succeeds only while that
 * worker still holds the lease, so a worker that stalled past its lease cannot overwrite the
 * result of the worker that took over.
 */
export interface JobQueue {
  enqueue(job: NewJob): Promise<{ readonly id: string; readonly created: boolean }>;
  /**
   * Takes the next due job of one of `kinds`, or an expired lease, for `leaseMs`. An expired last
   * attempt comes back with attempt > maxAttempts, once; fail() then dead-letters it.
   */
  claim(workerId: string, kinds: readonly string[], leaseMs: number): Promise<Job | undefined>;
  /** Extends the lease; false if it was lost. */
  heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<boolean>;
  /** Marks the job done; false if the lease was lost. */
  complete(jobId: string, workerId: string): Promise<boolean>;
  fail(jobId: string, workerId: string, error: string, retryAfterMs: number): Promise<FailOutcome>;
}
