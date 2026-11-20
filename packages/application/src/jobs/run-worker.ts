import type { Job, JobQueue } from "./job-queue.ts";

/**
 * Does the work of one job. Must be idempotent: after a crash or a lost lease the same job runs
 * again. `signal` aborts when the lease is lost or the worker stops; the handler should then stop
 * without side effects it cannot repeat.
 */
export type JobHandler = (job: Job, signal: AbortSignal) => Promise<void>;

/**
 * Runs just before a job is dead-lettered, with the error that ended it, e.g. to fail the mission
 * the job was working for. Called at least once per dead job (again if its worker dies first), so
 * it must be idempotent. A throw is logged and the job is dead-lettered anyway.
 */
export type DeadJobHandler = (job: Job, error: string) => Promise<void>;

export type WorkerLog = (entry: {
  readonly msg: string;
  readonly jobId?: string;
  readonly kind?: string;
  readonly attempt?: number;
  readonly error?: string;
}) => void;

export type WorkerOptions = {
  readonly queue: JobQueue;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  /** Per kind; kinds without one are dead-lettered silently. */
  readonly onDead?: Readonly<Record<string, DeadJobHandler>>;
  /** Unique per process, so a restarted worker never inherits its predecessor's leases. */
  readonly workerId: string;
  readonly leaseMs: number;
  /** Wait between empty polls. */
  readonly pollMs: number;
  /** Delay before the next attempt after `attempt` failed. */
  readonly backoffMs?: (attempt: number) => number;
  /** Stops the loop; an in-flight job is aborted and queued again. */
  readonly signal: AbortSignal;
  readonly log?: WorkerLog;
};

/** 1 s, 2 s, 4 s ... capped at 5 minutes. */
export const exponentialBackoff = (attempt: number): number =>
  Math.min(1000 * 2 ** Math.max(0, attempt - 1), 300_000);

const MAX_ERROR_LENGTH = 2000;

function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Calls the kind's onDead hook, if any; a throw is logged, not propagated. */
async function notifyDead(job: Job, error: string, options: WorkerOptions): Promise<void> {
  const hook = options.onDead?.[job.kind];
  if (hook === undefined) return;
  try {
    await hook(job, error);
  } catch (hookError) {
    options.log?.({
      msg: "onDead failed",
      jobId: job.id,
      kind: job.kind,
      attempt: job.attempt,
      error: describe(hookError),
    });
  }
}

/** A job whose last attempt's lease expired: dead-letter it without running its handler. */
async function deadLetter(job: Job, options: WorkerOptions): Promise<void> {
  const reason = `lease expired on the last attempt; previous error: ${job.lastError ?? "none"}`;
  await notifyDead(job, reason, options);
  const outcome = await options.queue.fail(job.id, options.workerId, reason, 0);
  options.log?.({
    msg: `job dead-lettered (${outcome})`,
    jobId: job.id,
    kind: job.kind,
    attempt: job.attempt,
    error: reason,
  });
}

/** Runs one job under its lease: heartbeats, handler, then complete or fail. */
async function runJob(job: Job, handler: JobHandler, options: WorkerOptions): Promise<void> {
  const { queue, workerId, leaseMs, log } = options;
  const backoff = options.backoffMs ?? exponentialBackoff;
  const controller = new AbortController();
  // An object, not a let: the heartbeat callback sets it, which flow analysis cannot see.
  const lease = { lost: false };
  const stop = () => {
    controller.abort();
  };
  options.signal.addEventListener("abort", stop, { once: true });
  const heartbeat = setInterval(
    () => {
      queue.heartbeat(job.id, workerId, leaseMs).then(
        (held) => {
          if (!held) {
            lease.lost = true;
            controller.abort();
          }
        },
        // A failed heartbeat is retried on the next tick; the lease has slack for that.
        () => undefined,
      );
    },
    Math.max(10, Math.floor(leaseMs / 3)),
  );
  const fields = { jobId: job.id, kind: job.kind, attempt: job.attempt };
  try {
    await handler(job, controller.signal);
    if (lease.lost || !(await queue.complete(job.id, workerId))) {
      log?.({ msg: "job lease lost before completion", ...fields });
    }
  } catch (error) {
    if (lease.lost) {
      log?.({ msg: "job lease lost", ...fields });
      return;
    }
    const reason = options.signal.aborted ? "worker stopped" : describe(error);
    // Before fail(): if this worker dies in between, the job comes back as a dead-letter pass.
    if (job.attempt >= job.maxAttempts) await notifyDead(job, reason, options);
    const outcome = await queue.fail(
      job.id,
      workerId,
      reason,
      options.signal.aborted ? 0 : backoff(job.attempt),
    );
    log?.({ msg: `job failed (${outcome})`, ...fields, error: reason });
  } finally {
    clearInterval(heartbeat);
    options.signal.removeEventListener("abort", stop);
  }
}

/**
 * Claims and runs jobs one at a time until `signal` aborts. Run several loops for concurrency.
 * Errors talking to the queue are logged and retried after `pollMs`.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const { queue, handlers, workerId, leaseMs, pollMs, signal, log } = options;
  const kinds = Object.keys(handlers);
  if (kinds.length === 0) throw new Error("runWorker needs at least one handler");
  while (!signal.aborted) {
    let job: Job | undefined;
    try {
      job = await queue.claim(workerId, kinds, leaseMs);
    } catch (error) {
      log?.({ msg: "claim failed", error: describe(error) });
      await sleep(pollMs, signal);
      continue;
    }
    if (job === undefined) {
      await sleep(pollMs, signal);
      continue;
    }
    const handler = handlers[job.kind];
    if (handler === undefined) {
      // claim() filters by kind, so this means the queue returned something it should not have.
      await queue.fail(job.id, workerId, `no handler for ${job.kind}`, 0);
      continue;
    }
    try {
      await (job.attempt > job.maxAttempts
        ? deadLetter(job, options)
        : runJob(job, handler, options));
    } catch (error) {
      log?.({ msg: "job bookkeeping failed", jobId: job.id, error: describe(error) });
      await sleep(pollMs, signal);
    }
  }
}
