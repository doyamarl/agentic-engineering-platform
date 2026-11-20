import type { TenantId, UserId } from "@aep/domain";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapTenant } from "./bootstrap.ts";
import { issueApiToken, PostgresIdentity } from "./identity.ts";
import { PostgresPasswordAccounts, PostgresSessions } from "./password-login.ts";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
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
const digest = (n: number) => n.toString(16).padStart(64, "0");
const alice = USER_A as UserId;
const tenantA = TENANT_A as TenantId;

beforeEach(async () => {
  await seedTwoTenants(db.admin);
  await db.admin
    .updateTable("users")
    .set({ email: "alice@example.com" })
    .where("id", "=", USER_A)
    .execute();
  await db.admin
    .insertInto("password_credentials")
    .values({
      user_id: USER_A,
      tenant_id: TENANT_A,
      password_hash: HASH,
      must_change_password: false,
    })
    .execute();
});

describe("schema", () => {
  it("refuses a second tenant for the same user", async () => {
    await expect(
      db.admin
        .insertInto("memberships")
        .values({ tenant_id: TENANT_B, user_id: USER_A, role: "viewer" })
        .execute(),
    ).rejects.toThrow(/memberships_one_tenant_per_user/);
  });

  it.each(["Alice@example.com", " alice2@example.com", "no-at-sign"])(
    "refuses the email %j",
    async (email) => {
      await expect(
        db.admin.updateTable("users").set({ email }).where("id", "=", USER_B).execute(),
      ).rejects.toThrow(/check constraint/);
    },
  );

  it("refuses a duplicate email", async () => {
    await expect(
      db.admin
        .updateTable("users")
        .set({ email: "alice@example.com" })
        .where("id", "=", USER_B)
        .execute(),
    ).rejects.toThrow(/unique/);
  });

  it("refuses a password hash that is not Argon2id", async () => {
    await expect(
      db.admin
        .insertInto("password_credentials")
        .values({
          user_id: USER_B,
          tenant_id: TENANT_B,
          password_hash: "plain",
          must_change_password: true,
        })
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it("refuses credentials that name another tenant than the user's membership", async () => {
    await expect(
      db.admin
        .insertInto("password_credentials")
        .values({
          user_id: USER_B,
          tenant_id: TENANT_A,
          password_hash: HASH,
          must_change_password: true,
        })
        .execute(),
    ).rejects.toThrow(/foreign key/);
  });

  // Admins create members, so the runtime role may insert credentials (0009); it never deletes.
  it("does not let the runtime role delete credentials or sessions", async () => {
    await expect(db.app.deleteFrom("password_credentials").execute()).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.app.deleteFrom("sessions").execute()).rejects.toThrow(/permission denied/);
  });
});

describe("PostgresPasswordAccounts (runtime role)", () => {
  const accounts = () => new PostgresPasswordAccounts(db.app);

  it("finds an account by email and by user id, with its tenant", async () => {
    const expected = {
      userId: USER_A,
      tenantId: TENANT_A,
      passwordHash: HASH,
      mustChangePassword: false,
      lockedUntil: null,
      disabled: false,
    };
    expect(await accounts().findByEmail("alice@example.com")).toEqual(expected);
    expect(await accounts().findByUserId(alice)).toEqual(expected);
    expect(await accounts().findByEmail("bob@example.com")).toBeUndefined();
  });

  it("reports a disabled user", async () => {
    await db.admin
      .updateTable("users")
      .set({ disabled_at: new Date() })
      .where("id", "=", USER_A)
      .execute();
    expect(await accounts().findByEmail("alice@example.com")).toMatchObject({ disabled: true });
  });

  it("counts failures, locks, and clears", async () => {
    expect(await accounts().addFailure(alice)).toBe(1);
    expect(await accounts().addFailure(alice)).toBe(2);
    const until = new Date("2030-01-01T00:00:00Z");
    await accounts().lock(alice, until);
    expect(await accounts().findByUserId(alice)).toMatchObject({ lockedUntil: until });
    expect(await accounts().addFailure(alice)).toBe(1);
    await accounts().clearFailures(alice);
    expect(await accounts().findByUserId(alice)).toMatchObject({ lockedUntil: null });
    expect(await accounts().addFailure(alice)).toBe(1);
  });

  it("replaces the password and its must-change flag", async () => {
    const next = "$argon2id$v=19$m=19456,t=2,p=1$bmV3$bmV3";
    await accounts().setPassword(alice, next, true);
    expect(await accounts().findByUserId(alice)).toMatchObject({
      passwordHash: next,
      mustChangePassword: true,
    });
  });
});

describe("PostgresSessions (runtime role)", () => {
  const sessions = () => new PostgresSessions(db.app);
  const NOW = new Date("2026-11-14T00:00:00Z");
  const later = (ms: number) => new Date(NOW.getTime() + ms);
  const SESSION = "0a000000-0000-4000-8000-00000000c0de";
  const GRACE = 10_000;
  /** Rotates `from` to `to` at `at`, with the grace period ending GRACE ms before `at`. */
  const rotate = (from: number, to: number, at = NOW, idle = later(90_000)) =>
    sessions().rotate(
      digest(from),
      { refreshHash: digest(to), idleExpiresAt: idle },
      at,
      new Date(at.getTime() - GRACE),
    );

  beforeEach(async () => {
    await sessions().create({
      id: SESSION,
      tenantId: tenantA,
      userId: alice,
      refreshHash: digest(1),
      idleExpiresAt: later(60_000),
      absoluteExpiresAt: later(120_000),
    });
  });

  it("rotates a live refresh token", async () => {
    expect(await rotate(1, 2)).toEqual({
      kind: "rotated",
      session: {
        id: SESSION,
        tenantId: TENANT_A,
        userId: USER_A,
        idleExpiresAt: later(90_000),
        absoluteExpiresAt: later(120_000),
      },
    });
    expect(await rotate(2, 3)).toMatchObject({ kind: "rotated", session: { id: SESSION } });
  });

  it("never extends the idle limit past the absolute limit", async () => {
    expect(await rotate(1, 2, NOW, later(999_000))).toMatchObject({
      kind: "rotated",
      session: { idleExpiresAt: later(120_000) },
    });
  });

  it("answers the replaced token within the grace period as superseded, changing nothing", async () => {
    await rotate(1, 2);
    expect(await rotate(1, 3, later(GRACE - 1))).toMatchObject({
      kind: "superseded",
      session: { id: SESSION },
    });
    expect(await rotate(2, 4, later(GRACE - 1))).toMatchObject({ kind: "rotated" });
  });

  it("revokes the session when the replaced token comes back after the grace period", async () => {
    await rotate(1, 2);
    expect(await rotate(1, 3, later(GRACE))).toEqual({ kind: "reused" });
    expect(await rotate(2, 4, later(GRACE))).toBeUndefined();
  });

  it("lets one of two concurrent refreshes rotate and answers the other as superseded", async () => {
    const results = await Promise.all(
      [2, 3].map((n) =>
        new PostgresSessions(db.admin).rotate(
          digest(1),
          { refreshHash: digest(n), idleExpiresAt: later(90_000) },
          NOW,
          new Date(NOW.getTime() - GRACE),
        ),
      ),
    );
    expect(results.map((r) => r?.kind).sort()).toEqual(["rotated", "superseded"]);
  });

  it.each([
    ["idle", later(60_000)],
    ["past both limits", later(120_000)],
  ])("refuses a session that is %s", async (_, at) => {
    expect(await rotate(1, 2, at, later(200_000))).toBeUndefined();
  });

  it("revokes by refresh token and for a whole user", async () => {
    await sessions().revokeByRefreshHash(digest(1), NOW);
    expect(await rotate(1, 2)).toBeUndefined();

    await sessions().create({
      id: "0a000000-0000-4000-8000-00000000c0df",
      tenantId: tenantA,
      userId: alice,
      refreshHash: digest(5),
      idleExpiresAt: later(60_000),
      absoluteExpiresAt: later(120_000),
    });
    await sessions().revokeAllOf(alice, NOW);
    expect(await rotate(5, 6)).toBeUndefined();
    const { rows } = await sql<{ open: string }>`
      select count(*)::text as open from sessions where revoked_at is null`.execute(db.admin);
    expect(rows[0]?.open).toBe("0");
  });
});

describe("PostgresIdentity.principalFor", () => {
  const identity = () => new PostgresIdentity(db.app);

  it("resolves a member, flagging a required password change", async () => {
    expect(await identity().principalFor(tenantA, alice)).toEqual({
      tenantId: TENANT_A,
      userId: USER_A,
      role: "planner",
    });
    await db.admin
      .updateTable("password_credentials")
      .set({ must_change_password: true })
      .execute();
    expect(await identity().principalFor(tenantA, alice)).toMatchObject({
      mustChangePassword: true,
    });
  });

  it("does not gate an API token on a required password change", async () => {
    const token = await issueApiToken(db.admin, {
      tenantId: TENANT_A,
      userId: USER_A,
      name: "cli",
    });
    await db.admin
      .updateTable("password_credentials")
      .set({ must_change_password: true })
      .execute();
    expect(await identity().authenticate(token)).toEqual({
      tenantId: TENANT_A,
      userId: USER_A,
      role: "planner",
    });
  });

  it("refuses a disabled user, also through an API token", async () => {
    const token = await issueApiToken(db.admin, {
      tenantId: TENANT_A,
      userId: USER_A,
      name: "cli",
    });
    await db.admin
      .updateTable("users")
      .set({ disabled_at: new Date() })
      .where("id", "=", USER_A)
      .execute();
    expect(await identity().principalFor(tenantA, alice)).toBeUndefined();
    expect(await identity().authenticate(token)).toBeUndefined();
  });

  it("refuses the user under another tenant", async () => {
    expect(await identity().principalFor(TENANT_B as TenantId, alice)).toBeUndefined();
  });
});

describe("bootstrapTenant with a password", () => {
  it("creates the admin's email and a password that must be changed", async () => {
    const created = await bootstrapTenant(db.owner, {
      tenantName: "Acme",
      workspaceName: "Default",
      adminName: "Root",
      adminEmail: "root@acme.example",
      adminPasswordHash: HASH,
    });
    expect(await new PostgresPasswordAccounts(db.app).findByEmail("root@acme.example")).toEqual({
      userId: created.userId,
      tenantId: created.tenantId,
      passwordHash: HASH,
      mustChangePassword: true,
      lockedUntil: null,
      disabled: false,
    });
  });
});
