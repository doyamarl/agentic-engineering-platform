import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectDatabase } from "./connect.ts";
import { startDatabase, type TestDatabase } from "./test-support.ts";

let db: TestDatabase;

beforeAll(async () => {
  db = await startDatabase();
}, 180_000);

afterAll(async () => {
  await db.stop();
});

describe("connectDatabase", () => {
  it("survives an idle connection ended by the server and serves the next query", async () => {
    const errors: string[] = [];
    const app = connectDatabase(db.appUri, {
      max: 1,
      onError: (error) => errors.push(error.message),
    });
    try {
      const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(app);
      const pid = rows[0]?.pid;
      // What a database restart does to every connection: end it from the server side.
      await sql`select pg_terminate_backend(${pid})`.execute(db.admin);
      await expect.poll(() => errors.length, { timeout: 10_000 }).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/terminating connection/);

      const again = await sql<{ one: number }>`select 1 as one`.execute(app);
      expect(again.rows).toEqual([{ one: 1 }]);
    } finally {
      await app.destroy();
    }
  });
});
