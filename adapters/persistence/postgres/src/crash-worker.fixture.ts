// Child process for the worker restart test (job-queue.test.ts): claims a job, reports it, and
// hangs inside the handler, heartbeating, until the test kills it with SIGKILL.
import { runWorker } from "@aep/application";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { PostgresJobQueue } from "./job-queue.ts";
import type { Database } from "./schema.ts";

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: process.env["AEP_TEST_DATABASE_URL"], max: 2 }),
  }),
});

await runWorker({
  queue: new PostgresJobQueue(db),
  handlers: {
    "test.work": async (job) => {
      process.stdout.write(`started ${job.id}\n`);
      await new Promise(() => undefined);
    },
  },
  workerId: "crashing-worker",
  leaseMs: Number(process.env["AEP_TEST_LEASE_MS"]),
  pollMs: 50,
  signal: new AbortController().signal,
});
