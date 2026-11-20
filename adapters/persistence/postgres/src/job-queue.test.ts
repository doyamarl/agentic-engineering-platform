import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { runWorker, type Job, type JobQueue, type NewJob } from "@aep/application";
import type { TenantId } from "@aep/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueJob, PostgresJobQueue } from "./job-queue.ts";
import { withTenant } from "./tenant-session.ts";
import {
  TENANT_A,
  TENANT_B,
  connect,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "./test-support.ts";

let db: TestDatabase;
let queue: JobQueue;

beforeAll(async () => {
  db = await startDatabase();
  queue = new PostgresJobQueue(db.app);
}, 180_000);

afterAll(async () => {
  await db.stop();
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
});

const job = (overrides: Partial<NewJob> = {}): NewJob => ({
  tenantId: TENANT_A as TenantId,
  kind: "test.work",
  idempotencyKey: "key-1",
  payload: { missionId: "m-1" },
  ...overrides,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function row(id: string) {
  return db.admin.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

describe("enqueue", () => {
  it("returns the existing job for a repeated idempotency key, per tenant and kind", async () => {
    const first = await queue.enqueue(job());
    expect(first.created).toBe(true);
    expect(await queue.enqueue(job({ payload: { missionId: "other" } }))).toEqual({
      id: first.id,
      created: false,
    });
    const otherTenant = await queue.enqueue(job({ tenantId: TENANT_B as TenantId }));
    const otherKind = await queue.enqueue(job({ kind: "test.other" }));
    expect(new Set([first.id, otherTenant.id, otherKind.id]).size).toBe(3);
    expect((await row(first.id)).payload).toEqual({ missionId: "m-1" });
  });

  it("is part of the caller's transaction (outbox): a rollback leaves no job", async () => {
    await expect(
      withTenant(db.app, TENANT_A, async (trx) => {
        await enqueueJob(trx, job());
        throw new Error("state change failed");
      }),
    ).rejects.toThrow("state change failed");
    expect(await db.admin.selectFrom("jobs").select("id").execute()).toEqual([]);
  });

  it("rejects malformed kinds and keys at the database", async () => {
    await expect(queue.enqueue(job({ kind: "Bad Kind" }))).rejects.toThrow();
    await expect(queue.enqueue(job({ idempotencyKey: "" }))).rejects.toThrow();
  });
});

describe("claim", () => {
  it("takes only due jobs of the requested kinds, oldest first, and counts the attempt", async () => {
    await queue.enqueue(job({ idempotencyKey: "later", runAfter: new Date(Date.now() + 60_000) }));
    await queue.enqueue(job({ idempotencyKey: "other", kind: "test.other" }));
    const first = await queue.enqueue(job({ idempotencyKey: "a" }));
    const second = await queue.enqueue(job({ idempotencyKey: "b" }));

    const claimed = await queue.claim("w1", ["test.work"], 10_000);
    expect(claimed).toMatchObject({ id: first.id, attempt: 1, maxAttempts: 5 });
    expect((await queue.claim("w1", ["test.work"], 10_000))?.id).toBe(second.id);
    expect(await queue.claim("w1", ["test.work"], 10_000)).toBeUndefined();
    expect(await queue.claim("w1", [], 10_000)).toBeUndefined();
  });

  it("gives each job to exactly one of many concurrent workers", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++)
      ids.add((await queue.enqueue(job({ idempotencyKey: `k${String(i)}` }))).id);
    const conns = Array.from({ length: 6 }, () => connect(db.appUri, 1));
    try {
      const claimed: string[] = [];
      await Promise.all(
        conns.map(async (conn, w) => {
          const q = new PostgresJobQueue(conn);
          for (;;) {
            const j = await q.claim(`w${String(w)}`, ["test.work"], 10_000);
            if (j === undefined) return;
            claimed.push(j.id);
          }
        }),
      );
      expect(claimed).toHaveLength(30);
      expect(new Set(claimed)).toEqual(ids);
    } finally {
      await Promise.all(conns.map((c) => c.destroy()));
    }
  });
});

describe("leases", () => {
  it("lets another worker take over an expired lease, and fences the old worker out", async () => {
    const { id } = await queue.enqueue(job());
    expect((await queue.claim("old", ["test.work"], 1000))?.attempt).toBe(1);
    expect(await queue.claim("new", ["test.work"], 10_000)).toBeUndefined();
    await sleep(1100);
    expect(await queue.claim("new", ["test.work"], 10_000)).toMatchObject({ id, attempt: 2 });

    expect(await queue.heartbeat(id, "old", 10_000)).toBe(false);
    expect(await queue.complete(id, "old")).toBe(false);
    expect(await queue.fail(id, "old", "late", 0)).toBe("lost");
    expect(await queue.complete(id, "new")).toBe(true);
    expect(await row(id)).toMatchObject({ status: "succeeded", attempts: 2, locked_by: null });
  });

  it("keeps a lease alive while the worker heartbeats", async () => {
    const { id } = await queue.enqueue(job());
    await queue.claim("w1", ["test.work"], 1000);
    for (let i = 0; i < 4; i++) {
      await sleep(300);
      expect(await queue.heartbeat(id, "w1", 1000)).toBe(true);
    }
    expect(await queue.claim("w2", ["test.work"], 1000)).toBeUndefined();
  });
});

describe("failures", () => {
  it("retries after the backoff and dead-letters after the last attempt", async () => {
    const { id } = await queue.enqueue(job({ maxAttempts: 2 }));
    await queue.claim("w1", ["test.work"], 10_000);
    expect(await queue.fail(id, "w1", "boom 1", 1000)).toBe("retrying");
    expect(await queue.claim("w1", ["test.work"], 10_000)).toBeUndefined();
    await sleep(1100);
    expect((await queue.claim("w1", ["test.work"], 10_000))?.attempt).toBe(2);
    expect(await queue.fail(id, "w1", "boom 2", 0)).toBe("dead");
    expect(await queue.claim("w1", ["test.work"], 10_000)).toBeUndefined();
    const dead = await row(id);
    expect(dead).toMatchObject({ status: "dead", attempts: 2, last_error: "boom 2" });
    expect(dead.finished_at).not.toBeNull();
  });

  it("hands a job whose last attempt's lease expired to a worker once more, to dead-letter it", async () => {
    const { id } = await queue.enqueue(job({ maxAttempts: 1 }));
    await queue.claim("w1", ["test.work"], 100);
    await db.admin.updateTable("jobs").set({ last_error: "boom" }).where("id", "=", id).execute();
    await sleep(200);
    const pass = await queue.claim("w2", ["test.work"], 10_000);
    expect(pass).toMatchObject({ id, attempt: 2, maxAttempts: 1, lastError: "boom" });
    expect(await queue.fail(id, "w2", "lease expired", 0)).toBe("dead");
    expect(await row(id)).toMatchObject({ status: "dead", attempts: 2 });
  });

  it("dead-letters directly when that dead-letter pass's lease expires too", async () => {
    const { id } = await queue.enqueue(job({ maxAttempts: 1 }));
    await queue.claim("w1", ["test.work"], 100);
    await sleep(200);
    expect((await queue.claim("w2", ["test.work"], 100))?.attempt).toBe(2);
    await sleep(200);
    expect(await queue.claim("w3", ["test.work"], 10_000)).toBeUndefined();
    expect(await row(id)).toMatchObject({ status: "dead", attempts: 2, locked_by: null });
  });
});

describe("runWorker", () => {
  const fast = { leaseMs: 2000, pollMs: 20, backoffMs: () => 0 };

  /** Runs a worker until `done` resolves, then stops it. */
  async function runUntil(
    handlers: Record<string, (j: Job, s: AbortSignal) => Promise<void>>,
    done: Promise<unknown>,
    workerId = "w1",
    onDead?: Record<string, (j: Job, error: string) => Promise<void>>,
  ) {
    const stop = new AbortController();
    const loop = runWorker({
      queue,
      handlers,
      workerId,
      signal: stop.signal,
      ...fast,
      ...(onDead === undefined ? {} : { onDead }),
    });
    await done;
    stop.abort();
    await loop;
  }

  it("retries a failing handler and completes the job", async () => {
    const { id } = await queue.enqueue(job());
    let calls = 0;
    let finish: () => void = () => undefined;
    const done = new Promise<void>((r) => (finish = r));
    await runUntil(
      {
        "test.work": () => {
          calls++;
          if (calls < 3) return Promise.reject(new Error(`attempt ${String(calls)} failed`));
          finish();
          return Promise.resolve();
        },
      },
      done,
    );
    await sleep(50);
    expect(await row(id)).toMatchObject({ status: "succeeded", attempts: 3 });
    expect((await row(id)).last_error).toBe("Error: attempt 2 failed");
  });

  it("calls onDead before dead-lettering a job whose last attempt failed", async () => {
    const { id } = await queue.enqueue(job({ maxAttempts: 2 }));
    let finish: () => void = () => undefined;
    const done = new Promise<void>((r) => (finish = r));
    const dead: [string, number, string, string][] = [];
    await runUntil(
      { "test.work": (j) => Promise.reject(new Error(`attempt ${String(j.attempt)} failed`)) },
      done,
      "w1",
      {
        "test.work": async (j, error) => {
          dead.push([j.id, j.attempt, error, (await row(j.id)).status]);
          finish();
        },
      },
    );
    await sleep(50);
    expect(dead).toEqual([[id, 2, "Error: attempt 2 failed", "running"]]);
    expect(await row(id)).toMatchObject({ status: "dead", last_error: "Error: attempt 2 failed" });
  });

  it("dead-letters without running the handler when the last attempt's lease expired", async () => {
    const { id } = await queue.enqueue(job({ maxAttempts: 1 }));
    await queue.claim("crashed", ["test.work"], 100);
    await db.admin.updateTable("jobs").set({ last_error: "boom" }).where("id", "=", id).execute();
    await sleep(200);
    let finish: () => void = () => undefined;
    const done = new Promise<void>((r) => (finish = r));
    const dead: string[] = [];
    let ran = false;
    await runUntil(
      {
        "test.work": () => {
          ran = true;
          return Promise.resolve();
        },
      },
      done,
      "w1",
      {
        "test.work": (_j, error) => {
          dead.push(error);
          finish();
          return Promise.resolve();
        },
      },
    );
    await sleep(50);
    expect(ran).toBe(false);
    const reason = "lease expired on the last attempt; previous error: boom";
    expect(dead).toEqual([reason]);
    expect(await row(id)).toMatchObject({ status: "dead", attempts: 2, last_error: reason });
  });

  it("still dead-letters the job when onDead throws", async () => {
    const { id } = await queue.enqueue(job({ maxAttempts: 1 }));
    let finish: () => void = () => undefined;
    const done = new Promise<void>((r) => (finish = r));
    await runUntil({ "test.work": () => Promise.reject(new Error("boom")) }, done, "w1", {
      "test.work": () => {
        finish();
        return Promise.reject(new Error("onDead broke"));
      },
    });
    await sleep(50);
    expect(await row(id)).toMatchObject({ status: "dead", last_error: "Error: boom" });
  });

  it("aborts an in-flight job on shutdown and queues it again", async () => {
    const { id } = await queue.enqueue(job());
    let started: () => void = () => undefined;
    const running = new Promise<void>((r) => (started = r));
    await runUntil(
      {
        "test.work": (_j, signal) =>
          new Promise((_, reject) => {
            started();
            signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      },
      running,
    );
    expect(await row(id)).toMatchObject({
      status: "queued",
      attempts: 1,
      last_error: "worker stopped",
      locked_by: null,
    });
  });

  it("finishes a job after its worker process is killed mid-job (restart)", async () => {
    const { id } = await queue.enqueue(job());
    const leaseMs = 1000;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./crash-worker.fixture.ts", import.meta.url))],
      {
        env: {
          ...process.env,
          AEP_TEST_DATABASE_URL: db.appUri,
          AEP_TEST_LEASE_MS: String(leaseMs),
        },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let out = "";
    child.stdout.setEncoding("utf8");
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (c: string) => {
        out += c;
        if (out.includes(`started ${id}`)) resolve();
      });
      child.once("exit", () => {
        reject(new Error(`crash worker exited early: ${out}`));
      });
    });
    // The child heartbeats, so its lease outlives several lease periods while it is alive.
    await sleep(leaseMs * 2);
    expect(await row(id)).toMatchObject({ status: "running", locked_by: "crashing-worker" });
    expect(await queue.claim("intruder", ["test.work"], leaseMs)).toBeUndefined();
    child.kill("SIGKILL");
    await once(child, "exit");

    let finish: () => void = () => undefined;
    const done = new Promise<void>((r) => (finish = r));
    const seen: Job[] = [];
    await runUntil(
      {
        "test.work": (j) => {
          seen.push(j);
          finish();
          return Promise.resolve();
        },
      },
      done,
      "restarted-worker",
    );
    await sleep(50);
    expect(seen.map((j) => [j.id, j.attempt])).toEqual([[id, 2]]);
    expect(await row(id)).toMatchObject({ status: "succeeded", attempts: 2 });
  }, 30_000);
});
