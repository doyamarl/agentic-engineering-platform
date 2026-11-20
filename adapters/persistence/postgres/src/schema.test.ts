import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDownToZero, migrateToLatest } from "./migrate.ts";
import type { Database } from "./schema.ts";
import { withTenant } from "./tenant-session.ts";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
  WORKSPACE_A,
  WORKSPACE_B,
  connect,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "./test-support.ts";

const MISSION_A = "0a000000-0000-4000-8000-00000000a001";
const MISSION_B = "0b000000-0000-4000-8000-00000000b001";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

let db: TestDatabase;
let admin: Kysely<Database>;
let app: Kysely<Database>;

const draftMission = (tenantId: string, workspaceId: string, id: string, createdBy: string) => ({
  tenant_id: tenantId,
  workspace_id: workspaceId,
  id,
  title: "Improve signup conversion",
  status: "DRAFT",
  state: JSON.stringify({ status: "DRAFT" }),
  created_by: createdBy,
});

beforeAll(async () => {
  db = await startDatabase();
  ({ admin, app } = db);
}, 180_000);

afterAll(async () => {
  await db.stop();
});

beforeEach(async () => {
  await seedTwoTenants(admin);
  await admin
    .insertInto("missions")
    .values([
      draftMission(TENANT_A, WORKSPACE_A, MISSION_A, USER_A),
      draftMission(TENANT_B, WORKSPACE_B, MISSION_B, USER_B),
    ])
    .execute();
});

describe("migrations", () => {
  it("roll back to an empty schema and re-apply cleanly", async () => {
    const scratch = connect(db.container.getConnectionUri().replace(/\/[^/]+$/, "/postgres"));
    await sql`drop database if exists migration_roundtrip`.execute(scratch);
    await sql`create database migration_roundtrip`.execute(scratch);
    await scratch.destroy();

    const roundtrip = connect(
      db.container.getConnectionUri().replace(/\/[^/]+$/, "/migration_roundtrip"),
    );
    try {
      await migrateToLatest(roundtrip);
      await migrateDownToZero(roundtrip);
      const { rows } = await sql<{ count: string }>`
        select count(*)::text as count from pg_tables where schemaname = 'public'
          and tablename not like 'kysely_%'`.execute(roundtrip);
      expect(rows[0]?.count).toBe("0");
      await migrateToLatest(roundtrip);
    } finally {
      await roundtrip.destroy();
    }
  });
});

describe("tenant-scoped keys", () => {
  it("rejects a mission that points at another tenant's workspace", async () => {
    const crossTenant = draftMission(
      TENANT_A,
      WORKSPACE_B,
      "0a000000-0000-4000-8000-00000000a002",
      USER_A,
    );
    await expect(admin.insertInto("missions").values(crossTenant).execute()).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("rejects a mission created by a user who is not a member of the tenant", async () => {
    const outsider = draftMission(
      TENANT_A,
      WORKSPACE_A,
      "0a000000-0000-4000-8000-00000000a003",
      USER_B,
    );
    await expect(admin.insertInto("missions").values(outsider).execute()).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("rejects a mission whose status column disagrees with its state document", async () => {
    const inconsistent = {
      ...draftMission(TENANT_A, WORKSPACE_A, "0a000000-0000-4000-8000-00000000a004", USER_A),
      status: "COMPLETED",
    };
    await expect(admin.insertInto("missions").values(inconsistent).execute()).rejects.toMatchObject(
      { code: "23514" },
    );
  });
});

describe("append-only records", () => {
  beforeEach(async () => {
    await admin
      .insertInto("mission_events")
      .values({
        tenant_id: TENANT_A,
        mission_id: MISSION_A,
        seq: "1",
        type: "MissionCreated",
        payload: JSON.stringify({}),
        actor_kind: "human",
        actor_id: USER_A,
      })
      .execute();
    await admin
      .insertInto("approvals")
      .values({
        tenant_id: TENANT_A,
        mission_id: MISSION_A,
        id: "0a000000-0000-4000-8000-0000000ab001",
        subject: "plan",
        subject_version: 1,
        decision: "approved",
        decided_by: USER_A,
      })
      .execute();
    await admin
      .insertInto("artifacts")
      .values({
        tenant_id: TENANT_A,
        mission_id: MISSION_A,
        id: "0a000000-0000-4000-8000-0000000af001",
        kind: "plan",
        version: 1,
        checksum_sha256: "a".repeat(64),
        storage_uri: "db://plans/1",
        provenance: JSON.stringify({ producer: "test" }),
        access_policy: "tenant_members",
      })
      .execute();
    await admin
      .insertInto("plans")
      .values({
        tenant_id: TENANT_A,
        mission_id: MISSION_A,
        version: 1,
        body: "plan",
        checksum_sha256: sha256("plan"),
        author_kind: "agent",
        author_id: "claude",
      })
      .execute();
  });

  it.each(["mission_events", "approvals", "artifacts", "plans"] as const)(
    "refuses UPDATE and DELETE on %s",
    async (table) => {
      await expect(
        sql`update ${sql.table(table)} set tenant_id = tenant_id`.execute(admin),
      ).rejects.toThrow(/append-only/);
      await expect(sql`delete from ${sql.table(table)}`.execute(admin)).rejects.toThrow(
        /append-only/,
      );
    },
  );

  it("rejects an artifact checksum that is not a lowercase SHA-256 hex digest", async () => {
    await expect(
      admin
        .insertInto("artifacts")
        .values({
          tenant_id: TENANT_A,
          mission_id: MISSION_A,
          id: "0a000000-0000-4000-8000-0000000af002",
          kind: "plan",
          version: 2,
          checksum_sha256: "not-a-digest",
          storage_uri: "db://plans/2",
          provenance: JSON.stringify({}),
          access_policy: "tenant_members",
        })
        .execute(),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("approvals", () => {
  it.each(["", "x".repeat(4001)])("rejects a comment of length %#", async (comment) => {
    await expect(
      admin
        .insertInto("approvals")
        .values({
          tenant_id: TENANT_A,
          mission_id: MISSION_A,
          id: "0a000000-0000-4000-8000-0000000ab002",
          subject: "plan",
          subject_version: 1,
          decision: "rejected",
          decided_by: USER_A,
          comment,
        })
        .execute(),
    ).rejects.toThrow(/approvals_comment_length/);
  });
});

describe("plans", () => {
  const row = (body: string, checksum: string) => ({
    tenant_id: TENANT_A,
    mission_id: MISSION_A,
    version: 1,
    body,
    checksum_sha256: checksum,
    author_kind: "agent" as const,
    author_id: null,
  });

  it("rejects a checksum that does not match the body", async () => {
    await expect(
      admin
        .insertInto("plans")
        .values(row("plan", sha256("other")))
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects an empty body", async () => {
    await expect(
      admin
        .insertInto("plans")
        .values(row("", sha256("")))
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects a plan for another tenant's mission", async () => {
    await expect(
      admin
        .insertInto("plans")
        .values({ ...row("plan", sha256("plan")), mission_id: MISSION_B })
        .execute(),
    ).rejects.toThrow(/foreign key/);
  });

  it("shows the runtime role only the session tenant's plans", async () => {
    await admin
      .insertInto("plans")
      .values(row("plan", sha256("plan")))
      .execute();
    const seen = (tenant: string) =>
      withTenant(app, tenant, (trx) => trx.selectFrom("plans").select("version").execute());
    expect(await seen(TENANT_A)).toEqual([{ version: 1 }]);
    expect(await seen(TENANT_B)).toEqual([]);
  });
});

describe("acceptance_packets", () => {
  const row = (content: string, checksum = sha256(content)) => ({
    tenant_id: TENANT_A,
    mission_id: MISSION_A,
    version: 1,
    content,
    checksum_sha256: checksum,
  });

  it("accepts a JSON object whose checksum matches, and keeps it append-only", async () => {
    await admin.insertInto("acceptance_packets").values(row('{"schemaVersion":1}')).execute();
    await expect(
      sql`update acceptance_packets set content = content`.execute(admin),
    ).rejects.toThrow(/append-only/);
    await expect(sql`delete from acceptance_packets`.execute(admin)).rejects.toThrow(/append-only/);
  });

  it.each([
    ["a checksum of other content", row("{}", sha256("{ }"))],
    ["a JSON array", row("[]")],
  ])("rejects %s", async (_, values) => {
    await expect(admin.insertInto("acceptance_packets").values(values).execute()).rejects.toThrow(
      /check constraint/,
    );
  });

  it("rejects text that is not JSON", async () => {
    await expect(
      admin.insertInto("acceptance_packets").values(row("not json")).execute(),
    ).rejects.toThrow(/json/i);
  });
});

describe("row-level security for the runtime role", () => {
  it("shows only the session tenant's missions", async () => {
    const ids = await withTenant(app, TENANT_A, (trx) =>
      trx.selectFrom("missions").select("id").execute(),
    );
    expect(ids).toEqual([{ id: MISSION_A }]);
  });

  it("shows nothing when no tenant is set on the session", async () => {
    expect(await app.selectFrom("missions").select("id").execute()).toEqual([]);
    expect(await app.selectFrom("tenants").select("id").execute()).toEqual([]);
  });

  it("refuses to write a row for another tenant", async () => {
    await expect(
      withTenant(app, TENANT_A, (trx) =>
        trx
          .insertInto("missions")
          .values(
            draftMission(TENANT_B, WORKSPACE_B, "0b000000-0000-4000-8000-00000000b002", USER_B),
          )
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("does not leak the tenant setting to the next transaction on the same pool", async () => {
    await withTenant(app, TENANT_A, (trx) => trx.selectFrom("missions").select("id").execute());
    expect(await app.selectFrom("missions").select("id").execute()).toEqual([]);
  });
});
