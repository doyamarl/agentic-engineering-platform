import type { AuditEventInput, Member } from "@aep/application";
import type { TenantId, UserId } from "@aep/domain";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresAuditLog, PostgresMemberRepository } from "./member-repository.ts";
import { PostgresSessions } from "./password-login.ts";
import { withTenant } from "./tenant-session.ts";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
  connect,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "./test-support.ts";

let db: TestDatabase;

beforeAll(async () => {
  db = await startDatabase();
}, 180_000);

afterAll(async () => {
  await db.stop();
});

const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";
const tenantA = TENANT_A as TenantId;
const alice = USER_A as UserId;
const CAROL = "0a000000-0000-4000-8000-0000000000cc" as UserId;
const event = (
  type: AuditEventInput["type"],
  subjectId: UserId | null = alice,
): AuditEventInput => ({
  type,
  actorId: alice,
  subjectId,
  payload: {},
});
const repo = () => new PostgresMemberRepository(db.app);

beforeEach(async () => {
  await seedTwoTenants(db.admin);
  await db.admin.updateTable("memberships").set({ role: "admin" }).execute();
  await db.admin
    .updateTable("users")
    .set({ email: "alice@example.com" })
    .where("id", "=", USER_A)
    .execute();
});

async function createCarol(role: Member["role"] = "engineer") {
  const created = await repo().create(
    tenantA,
    { userId: CAROL, displayName: "Carol", email: "carol@example.com", role, passwordHash: HASH },
    event("member.created", CAROL),
  );
  if (!created.ok) throw new Error(created.error.kind);
  return created.value;
}

describe("PostgresMemberRepository (runtime role, RLS active)", () => {
  it("creates a user, a membership and a password that must be changed, with the audit event", async () => {
    const carol = await createCarol();
    expect(carol).toMatchObject({
      userId: CAROL,
      displayName: "Carol",
      email: "carol@example.com",
      role: "engineer",
      disabled: false,
      passwordLogin: true,
    });
    const credential = await db.admin
      .selectFrom("password_credentials")
      .selectAll()
      .where("user_id", "=", CAROL)
      .executeTakeFirst();
    expect(credential).toMatchObject({
      tenant_id: TENANT_A,
      must_change_password: true,
      password_hash: HASH,
    });
    expect(
      (await new PostgresAuditLog(db.app).list(tenantA, { limit: 10 })).map((e) => e.type),
    ).toEqual(["member.created"]);
  });

  it("reports a taken email and writes nothing", async () => {
    const result = await repo().create(
      tenantA,
      {
        userId: CAROL,
        displayName: "Carol",
        email: "alice@example.com",
        role: "viewer",
        passwordHash: HASH,
      },
      event("member.created", CAROL),
    );
    expect(result).toEqual({ ok: false, error: { kind: "EmailTaken" } });
    expect(await repo().find(tenantA, CAROL)).toBeUndefined();
    expect(await new PostgresAuditLog(db.app).list(tenantA, { limit: 10 })).toEqual([]);
  });

  it("lists and finds members of the tenant only", async () => {
    expect((await repo().list(tenantA)).map((m) => m.userId)).toEqual([USER_A]);
    expect(await repo().find(tenantA, USER_B as UserId)).toBeUndefined();
  });

  it("changes a role and disables, ending the member's sessions", async () => {
    const carol = await createCarol();
    await new PostgresSessions(db.app).create({
      id: "0a000000-0000-4000-8000-00000000c0de",
      tenantId: tenantA,
      userId: CAROL,
      refreshHash: "1".padStart(64, "0"),
      idleExpiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
    });
    const updated = await repo().update(tenantA, carol, { role: "viewer", disabled: true }, [
      event("member.role_changed", CAROL),
      event("member.disabled", CAROL),
    ]);
    expect(updated).toMatchObject({ ok: true, value: { role: "viewer", disabled: true } });
    const { rows } = await sql<{ open: string }>`
      select count(*)::text as open from sessions where revoked_at is null`.execute(db.admin);
    expect(rows[0]?.open).toBe("0");
  });

  it("refuses a change based on a stale read", async () => {
    const carol = await createCarol();
    await db.admin
      .updateTable("memberships")
      .set({ role: "viewer" })
      .where("user_id", "=", CAROL)
      .execute();
    expect(await repo().update(tenantA, carol, { role: "planner" }, [])).toEqual({
      ok: false,
      error: { kind: "Stale" },
    });
  });

  it("refuses to demote or disable the last active admin", async () => {
    const [aliceMember] = await repo().list(tenantA);
    if (!aliceMember) throw new Error("no member");
    expect(await repo().update(tenantA, aliceMember, { role: "planner" }, [])).toEqual({
      ok: false,
      error: { kind: "LastAdmin" },
    });
    expect(await repo().update(tenantA, aliceMember, { disabled: true }, [])).toEqual({
      ok: false,
      error: { kind: "LastAdmin" },
    });
  });

  it("does not count a disabled admin as active", async () => {
    const carol = await createCarol("admin");
    const [aliceMember] = await repo().list(tenantA);
    if (!aliceMember) throw new Error("no member");
    await repo().update(tenantA, carol, { disabled: true }, []);
    expect((await repo().update(tenantA, aliceMember, { role: "viewer" }, [])).ok).toBe(false);
  });

  it("keeps one admin when two admins demote each other at the same time", async () => {
    const carol = await createCarol("admin");
    const [aliceMember] = await repo().list(tenantA);
    if (!aliceMember) throw new Error("no member");
    const first = connect(db.appUri, 1);
    const second = connect(db.appUri, 1);
    const conns = [first, second];
    try {
      const results = await Promise.all([
        new PostgresMemberRepository(first).update(tenantA, aliceMember, { role: "viewer" }, []),
        new PostgresMemberRepository(second).update(tenantA, carol, { role: "viewer" }, []),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await repo().list(tenantA)).filter((m) => m.role === "admin")).toHaveLength(1);
    } finally {
      await Promise.all(conns.map((c) => c.destroy()));
    }
  });

  it("resets a password, creating the credential when there was none, and clears a lock", async () => {
    const reset = await repo().resetPassword(tenantA, alice, HASH, event("member.password_reset"));
    expect(reset).toMatchObject({ ok: true, value: { passwordLogin: true } });
    await db.admin
      .updateTable("password_credentials")
      .set({
        failed_attempts: 3,
        locked_until: new Date("2030-01-01T00:00:00Z"),
        must_change_password: false,
      })
      .execute();
    await repo().resetPassword(tenantA, alice, HASH, event("member.password_reset"));
    expect(
      await db.admin.selectFrom("password_credentials").selectAll().executeTakeFirst(),
    ).toMatchObject({
      failed_attempts: 0,
      locked_until: null,
      must_change_password: true,
    });
  });

  it("treats another tenant's user as missing", async () => {
    expect(
      await repo().resetPassword(tenantA, USER_B as UserId, HASH, event("member.password_reset")),
    ).toEqual({
      ok: false,
      error: { kind: "NotFound" },
    });
  });
});

describe("row-level security on users", () => {
  it("lets the runtime role update only users who are members of the current tenant", async () => {
    const changed = await withTenant(db.app, TENANT_A, (trx) =>
      trx
        .updateTable("users")
        .set({ display_name: "Mallory" })
        .where("id", "in", [USER_A, USER_B])
        .execute(),
    );
    expect(changed[0]?.numUpdatedRows).toBe(1n);
    const bob = await db.admin
      .selectFrom("users")
      .select("display_name")
      .where("id", "=", USER_B)
      .executeTakeFirst();
    expect(bob?.display_name).toBe("Bob");
  });

  it("lets nobody update users outside a tenant scope", async () => {
    const result = await db.app.updateTable("users").set({ display_name: "Mallory" }).execute();
    expect(result[0]?.numUpdatedRows).toBe(0n);
  });
});

describe("PostgresAuditLog", () => {
  it("lists the tenant's events in order, after an id, and refuses changes", async () => {
    const log = new PostgresAuditLog(db.app);
    await log.record(tenantA, event("login.succeeded"));
    await log.record(TENANT_B as TenantId, {
      ...event("login.succeeded", USER_B as UserId),
      actorId: null,
    });
    await log.record(tenantA, {
      ...event("login.failed"),
      actorId: null,
      payload: { reason: "wrong_password" },
    });
    const all = await log.list(tenantA, { limit: 10 });
    expect(all.map((e) => [e.type, e.payload])).toEqual([
      ["login.succeeded", {}],
      ["login.failed", { reason: "wrong_password" }],
    ]);
    expect(await log.list(tenantA, { afterId: all[0]?.id ?? 0, limit: 10 })).toHaveLength(1);
    // The superuser bypasses RLS, so the delete reaches the rows and the trigger refuses it.
    await expect(db.admin.deleteFrom("audit_events").execute()).rejects.toThrow(/append-only/);
    await expect(db.app.deleteFrom("audit_events").execute()).rejects.toThrow(/permission denied/);
  });

  it("refuses an actor who is not a member of the tenant", async () => {
    await expect(
      new PostgresAuditLog(db.app).record(tenantA, {
        ...event("login.succeeded"),
        actorId: USER_B as UserId,
      }),
    ).rejects.toThrow(/foreign key/);
  });
});
