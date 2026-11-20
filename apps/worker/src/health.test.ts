import { startDatabase, type TestDatabase } from "@aep/postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHealthServer } from "./health.ts";

let db: TestDatabase;

beforeAll(async () => {
  db = await startDatabase();
}, 180_000);

afterAll(async () => {
  await db.stop();
});

describe("worker health endpoint", () => {
  it("reports ok while the database answers", async () => {
    const server = await startHealthServer(db.app, { port: 0 });
    try {
      const response = await fetch(`${server.url}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
    } finally {
      await server.close();
    }
  });

  it("reports 503 when the database is unreachable", async () => {
    const { connect } = await import("@aep/postgres/testing");
    const unreachable = connect("postgres://nobody:none@127.0.0.1:1/none");
    const server = await startHealthServer(unreachable, { port: 0 });
    try {
      const response = await fetch(`${server.url}/healthz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
    } finally {
      await server.close();
      await unreachable.destroy();
    }
  });

  it("answers 404 for other paths", async () => {
    const server = await startHealthServer(db.app, { port: 0 });
    try {
      expect((await fetch(`${server.url}/other`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
