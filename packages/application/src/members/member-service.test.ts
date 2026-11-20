import { err, ok, type Role, type TenantId, type UserId } from "@aep/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "../principal.ts";
import type {
  AuditEventInput,
  AuditLog,
  Member,
  MemberChange,
  MemberRepository,
  NewMember,
} from "./member-ports.ts";
import { memberService } from "./member-service.ts";

const TENANT_A = "0a000000-0000-4000-8000-000000000001" as TenantId;
const TENANT_B = "0b000000-0000-4000-8000-000000000001" as TenantId;
const ADMIN = "0a000000-0000-4000-8000-0000000000ad" as UserId;
const BOB = "0a000000-0000-4000-8000-0000000000bb" as UserId;
const OTHER = "0b000000-0000-4000-8000-0000000000cc" as UserId;
const CREATED = new Date("2026-11-14T00:00:00Z");

const member = (userId: UserId, role: Role, extra: Partial<Member> = {}): Member => ({
  userId,
  displayName: userId.slice(-2),
  email: `${userId.slice(-2)}@example.com`,
  role,
  disabled: false,
  passwordLogin: true,
  createdAt: CREATED,
  ...extra,
});

type Row = { -readonly [K in keyof Member]: Member[K] } & {
  tenantId: TenantId;
  passwordHash?: string;
};

/** Keeps members per tenant and enforces what the database enforces. */
class FakeMembers implements MemberRepository {
  rows: Row[] = [];
  audit: AuditEventInput[] = [];
  revokedSessionsOf: UserId[] = [];

  #of(tenantId: TenantId, userId: UserId) {
    return this.rows.find((r) => r.tenantId === tenantId && r.userId === userId);
  }
  static #public({ tenantId: _t, passwordHash: _p, ...m }: Row): Member {
    return m;
  }
  list(tenantId: TenantId) {
    return Promise.resolve(
      this.rows.filter((r) => r.tenantId === tenantId).map((r) => FakeMembers.#public(r)),
    );
  }
  find(tenantId: TenantId, userId: UserId) {
    const row = this.#of(tenantId, userId);
    return Promise.resolve(row && FakeMembers.#public(row));
  }
  create(tenantId: TenantId, m: NewMember, audit: AuditEventInput) {
    if (this.rows.some((r) => r.email === m.email))
      return Promise.resolve(err({ kind: "EmailTaken" } as const));
    const row: Row = {
      tenantId,
      userId: m.userId,
      displayName: m.displayName,
      email: m.email,
      role: m.role,
      disabled: false,
      passwordLogin: true,
      createdAt: CREATED,
      passwordHash: m.passwordHash,
    };
    this.rows.push(row);
    this.audit.push(audit);
    return Promise.resolve(ok(FakeMembers.#public(row)));
  }
  update(
    tenantId: TenantId,
    expected: Member,
    change: MemberChange,
    audit: readonly AuditEventInput[],
  ) {
    const row = this.#of(tenantId, expected.userId);
    if (!row) return Promise.resolve(err({ kind: "NotFound" } as const));
    if (row.role !== expected.role || row.disabled !== expected.disabled) {
      return Promise.resolve(err({ kind: "Stale" } as const));
    }
    const next = { ...row, ...change };
    const activeAdmins = this.rows.filter(
      (r) =>
        r.tenantId === tenantId &&
        (r === row ? next : r).role === "admin" &&
        !(r === row ? next : r).disabled,
    );
    if (activeAdmins.length === 0) return Promise.resolve(err({ kind: "LastAdmin" } as const));
    Object.assign(row, change);
    if (change.disabled === true) this.revokedSessionsOf.push(row.userId);
    this.audit.push(...audit);
    return Promise.resolve(ok(FakeMembers.#public(row)));
  }
  resetPassword(tenantId: TenantId, userId: UserId, passwordHash: string, audit: AuditEventInput) {
    const row = this.#of(tenantId, userId);
    if (!row) return Promise.resolve(err({ kind: "NotFound" } as const));
    row.passwordHash = passwordHash;
    row.passwordLogin = true;
    this.revokedSessionsOf.push(userId);
    this.audit.push(audit);
    return Promise.resolve(ok(FakeMembers.#public(row)));
  }
}

const noAudit: AuditLog = { record: () => Promise.resolve(), list: () => Promise.resolve([]) };
const admin: Principal = { tenantId: TENANT_A, userId: ADMIN, role: "admin" };
const planner: Principal = { tenantId: TENANT_A, userId: BOB, role: "planner" };

let repo: FakeMembers;
let service: ReturnType<typeof memberService>;
let passwords: number;

beforeEach(() => {
  repo = new FakeMembers();
  repo.rows.push(
    { tenantId: TENANT_A, ...member(ADMIN, "admin") },
    { tenantId: TENANT_A, ...member(BOB, "planner") },
    { tenantId: TENANT_B, ...member(OTHER, "admin") },
  );
  passwords = 0;
  service = memberService({
    members: repo,
    audit: noAudit,
    hasher: { hash: (p) => Promise.resolve(`fake$${p}`), verify: () => Promise.resolve(false) },
    newUserId: () => "0a000000-0000-4000-8000-0000000000ee" as UserId,
    newPassword: () => `initial-password-${String(++passwords)}`,
  });
});

describe("permissions", () => {
  it.each(["planner", "engineer", "viewer"] as const)("refuses a %s everything", async (role) => {
    const p = { ...planner, role };
    const forbidden = { ok: false, error: { kind: "Forbidden", action: "member:manage" } };
    expect(await service.list(p)).toEqual(forbidden);
    expect(
      await service.create(p, { displayName: "x", email: "x@example.com", role: "viewer" }),
    ).toEqual(forbidden);
    expect(await service.update(p, BOB, { role: "admin" })).toEqual(forbidden);
    expect(await service.resetPassword(p, BOB)).toEqual(forbidden);
    expect(await service.listAudit(p)).toEqual(forbidden);
  });

  it("lists only the admin's own tenant", async () => {
    const listed = await service.list(admin);
    expect(listed.ok && listed.value.map((m) => m.userId)).toEqual([ADMIN, BOB]);
  });

  it("treats a member of another tenant as missing", async () => {
    expect(await service.update(admin, OTHER, { disabled: true })).toMatchObject({
      ok: false,
      error: { kind: "NotFound", resource: "member" },
    });
    expect(await service.resetPassword(admin, OTHER)).toMatchObject({
      ok: false,
      error: { kind: "NotFound" },
    });
  });
});

describe("create", () => {
  it("creates a member with a hashed initial password, returned once, and audits it", async () => {
    const created = await service.create(admin, {
      displayName: "  Carol ",
      email: "Carol@Example.com",
      role: "engineer",
    });
    expect(created).toMatchObject({
      ok: true,
      value: {
        member: { displayName: "Carol", email: "carol@example.com", role: "engineer" },
        initialPassword: "initial-password-1",
      },
    });
    expect(repo.rows.at(-1)?.passwordHash).toBe("fake$initial-password-1");
    expect(repo.audit).toEqual([
      {
        type: "member.created",
        actorId: ADMIN,
        subjectId: created.ok && created.value.member.userId,
        payload: { role: "engineer" },
      },
    ]);
  });

  it.each([
    ["displayName", { displayName: " ", email: "c@example.com", role: "viewer" }],
    ["email", { displayName: "Carol", email: "carol", role: "viewer" }],
    ["role", { displayName: "Carol", email: "c@example.com", role: "owner" }],
  ])("refuses an invalid %s", async (field, input) => {
    expect(await service.create(admin, input)).toMatchObject({
      ok: false,
      error: { kind: "Invalid", field },
    });
  });

  it("reports an email in use as a Conflict", async () => {
    expect(
      await service.create(admin, { displayName: "x", email: "bb@example.com", role: "viewer" }),
    ).toMatchObject({
      ok: false,
      error: { kind: "Conflict" },
    });
  });
});

describe("update", () => {
  it("changes the role and audits from and to", async () => {
    expect(await service.update(admin, BOB, { role: "viewer" })).toMatchObject({
      ok: true,
      value: { role: "viewer" },
    });
    expect(repo.audit).toEqual([
      {
        type: "member.role_changed",
        actorId: ADMIN,
        subjectId: BOB,
        payload: { from: "planner", to: "viewer" },
      },
    ]);
  });

  it("disables and re-enables, ending sessions on disable", async () => {
    await service.update(admin, BOB, { disabled: true });
    expect(repo.revokedSessionsOf).toEqual([BOB]);
    await service.update(admin, BOB, { disabled: false });
    expect(repo.audit.map((e) => e.type)).toEqual(["member.disabled", "member.enabled"]);
  });

  it("writes nothing when nothing changes", async () => {
    expect(await service.update(admin, BOB, { role: "planner", disabled: false })).toMatchObject({
      ok: true,
    });
    expect(repo.audit).toEqual([]);
  });

  it.each([
    ["demoting", { role: "planner" }],
    ["disabling", { disabled: true }],
  ])("refuses %s the last active admin", async (_, change) => {
    expect(await service.update(admin, ADMIN, change)).toEqual({
      ok: false,
      error: { kind: "Conflict", reason: "the tenant needs at least one active admin" },
    });
    expect(repo.audit).toEqual([]);
  });

  it("allows an admin to step down once another admin exists", async () => {
    await service.update(admin, BOB, { role: "admin" });
    expect((await service.update(admin, ADMIN, { role: "viewer" })).ok).toBe(true);
  });

  it("refuses an unknown role", async () => {
    expect(await service.update(admin, BOB, { role: "owner" })).toMatchObject({
      ok: false,
      error: { field: "role" },
    });
  });
});

describe("resetPassword", () => {
  it("issues a new password, ends sessions and audits without the password", async () => {
    const reset = await service.resetPassword(admin, BOB);
    expect(reset).toMatchObject({ ok: true, value: { initialPassword: "initial-password-1" } });
    expect(repo.revokedSessionsOf).toEqual([BOB]);
    expect(repo.audit).toEqual([
      { type: "member.password_reset", actorId: ADMIN, subjectId: BOB, payload: {} },
    ]);
  });

  it("refuses a member without an email", async () => {
    const row = repo.rows.find((r) => r.userId === BOB);
    if (row) row.email = null;
    expect(await service.resetPassword(admin, BOB)).toMatchObject({
      ok: false,
      error: { kind: "Conflict" },
    });
  });
});

describe("listAudit", () => {
  it.each([0, 501, 1.5])("refuses the limit %s", async (limit) => {
    expect(await service.listAudit(admin, { limit })).toMatchObject({
      ok: false,
      error: { field: "limit" },
    });
  });
});
