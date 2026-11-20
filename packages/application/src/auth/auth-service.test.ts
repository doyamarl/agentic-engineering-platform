import type { TenantId, UserId } from "@aep/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "../principal.ts";
import type { AuditEventInput, AuditLog } from "../members/member-ports.ts";
import type {
  AccessClaims,
  AccessTokenCodec,
  Members,
  NewSession,
  PasswordAccount,
  PasswordAccounts,
  LoginMember,
  OidcChecks,
  OidcClaims,
  OidcIdentities,
  OidcProvider,
  PasswordHasher,
  Rotation,
  Sessions,
} from "./auth-ports.ts";
import {
  AUTH_LIMITS,
  authService,
  bearerIdentity,
  type RefreshedTokens,
  type Tokens,
} from "./auth-service.ts";

const TENANT = "0a000000-0000-4000-8000-000000000001" as TenantId;
const ALICE = "0a000000-0000-4000-8000-0000000000aa" as UserId;
const PASSWORD = "correct horse battery";

/** Readable fake: the "hash" is the password with a prefix. Counts verifications. */
class FakeHasher implements PasswordHasher {
  verifications = 0;
  hash(password: string) {
    return Promise.resolve(`fake$${password}`);
  }
  verify(hash: string, password: string) {
    this.verifications++;
    return Promise.resolve(hash === `fake$${password}`);
  }
}

class FakeCodec implements AccessTokenCodec {
  issued: { claims: AccessClaims; expiresAt: Date }[] = [];
  issue(claims: AccessClaims, expiresAt: Date) {
    this.issued.push({ claims, expiresAt });
    return Promise.resolve(`jwt.${String(this.issued.length)}`);
  }
  verify(token: string) {
    const n = Number(token.slice("jwt.".length));
    return Promise.resolve(this.issued[n - 1]?.claims);
  }
}

type AccountRow = PasswordAccount & { email: string; failures: number };

class FakeAccounts implements PasswordAccounts {
  rows = new Map<UserId, AccountRow>();
  findByEmail(email: string) {
    return Promise.resolve([...this.rows.values()].find((row) => row.email === email));
  }
  findByUserId(userId: UserId) {
    return Promise.resolve(this.rows.get(userId));
  }
  #update(userId: UserId, change: Partial<AccountRow>) {
    const row = this.rows.get(userId);
    if (row) this.rows.set(userId, { ...row, ...change });
  }
  addFailure(userId: UserId) {
    const failures = (this.rows.get(userId)?.failures ?? 0) + 1;
    this.#update(userId, { failures });
    return Promise.resolve(failures);
  }
  lock(userId: UserId, until: Date) {
    this.#update(userId, { lockedUntil: until, failures: 0 });
    return Promise.resolve();
  }
  clearFailures(userId: UserId) {
    this.#update(userId, { lockedUntil: null, failures: 0 });
    return Promise.resolve();
  }
  setPassword(userId: UserId, hash: string, mustChangePassword: boolean) {
    this.#update(userId, { passwordHash: hash, mustChangePassword });
    return Promise.resolve();
  }
}

type SessionRow = {
  -readonly [K in keyof NewSession]: NewSession[K];
} & { previousHash?: string; rotatedAt?: Date; revoked: boolean };

class FakeSessions implements Sessions {
  rows: SessionRow[] = [];
  create(session: NewSession) {
    this.rows.push({ ...session, revoked: false });
    return Promise.resolve();
  }
  rotate(
    refreshHash: string,
    next: { refreshHash: string; idleExpiresAt: Date },
    now: Date,
    graceSince: Date,
  ): Promise<Rotation | undefined> {
    const live = (r: SessionRow) =>
      !r.revoked && r.idleExpiresAt > now && r.absoluteExpiresAt > now;
    const view = ({ id, tenantId, userId, idleExpiresAt, absoluteExpiresAt }: SessionRow) => ({
      id,
      tenantId,
      userId,
      idleExpiresAt,
      absoluteExpiresAt,
    });
    const replaced = this.rows.find((row) => row.previousHash === refreshHash && !row.revoked);
    if (replaced) {
      if (live(replaced) && (replaced.rotatedAt ?? now) > graceSince) {
        return Promise.resolve({ kind: "superseded", session: view(replaced) });
      }
      replaced.revoked = true;
      return Promise.resolve({ kind: "reused" });
    }
    const row = this.rows.find((r) => r.refreshHash === refreshHash && live(r));
    if (!row) return Promise.resolve(undefined);
    row.previousHash = row.refreshHash;
    row.refreshHash = next.refreshHash;
    row.idleExpiresAt = next.idleExpiresAt;
    row.rotatedAt = now;
    return Promise.resolve({ kind: "rotated", session: view(row) });
  }
  revokeByRefreshHash(refreshHash: string) {
    for (const row of this.rows) if (row.refreshHash === refreshHash) row.revoked = true;
    return Promise.resolve();
  }
  revokeAllOf(userId: UserId) {
    for (const row of this.rows) if (row.userId === userId) row.revoked = true;
    return Promise.resolve();
  }
}

class FakeAudit implements AuditLog {
  events: (AuditEventInput & { tenantId: TenantId })[] = [];
  record(tenantId: TenantId, event: AuditEventInput) {
    this.events.push({ tenantId, ...event });
    return Promise.resolve();
  }
  list() {
    return Promise.resolve([]);
  }
}

const ISSUER = "https://idp.example";
const CHECKS: OidcChecks = { state: "s", nonce: "n", codeVerifier: "v" };

/** Answers finish() with whatever the test set as `claims`. */
class FakeProvider implements OidcProvider {
  readonly name = "Example IdP";
  claims: OidcClaims | undefined;
  start() {
    return Promise.resolve({ ...CHECKS, authorizationUrl: `${ISSUER}/authorize` });
  }
  finish(_callback: URL, checks: OidcChecks) {
    return Promise.resolve(checks === CHECKS ? this.claims : undefined);
  }
}

class FakeOidcIdentities implements OidcIdentities {
  bound = new Map<string, LoginMember>();
  byEmail = new Map<string, LoginMember>();
  findBySubject(issuer: string, subject: string) {
    return Promise.resolve(this.bound.get(`${issuer} ${subject}`));
  }
  findByEmail(email: string) {
    return Promise.resolve(this.byEmail.get(email));
  }
  bind(issuer: string, subject: string, member: LoginMember) {
    const taken = [...this.bound.entries()].some(
      ([key, m]) => key.startsWith(`${issuer} `) && m.userId === member.userId,
    );
    if (taken) return Promise.resolve(false);
    this.bound.set(`${issuer} ${subject}`, member);
    return Promise.resolve(true);
  }
}

let provider: FakeProvider;
let identities: FakeOidcIdentities;
let audit: FakeAudit;
let clock: Date;
let hasher: FakeHasher;
let codec: FakeCodec;
let accounts: FakeAccounts;
let sessions: FakeSessions;
let members: Map<UserId, Principal>;
let service: ReturnType<typeof authService>;

const updateAlice = (change: Partial<AccountRow>) => {
  const row = accounts.rows.get(ALICE);
  if (row) accounts.rows.set(ALICE, { ...row, ...change });
};

const tick = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

beforeEach(() => {
  provider = new FakeProvider();
  identities = new FakeOidcIdentities();
  identities.byEmail.set("alice@example.com", { userId: ALICE, tenantId: TENANT, disabled: false });
  clock = new Date("2026-11-14T00:00:00Z");
  hasher = new FakeHasher();
  codec = new FakeCodec();
  accounts = new FakeAccounts();
  sessions = new FakeSessions();
  audit = new FakeAudit();
  members = new Map([[ALICE, { tenantId: TENANT, userId: ALICE, role: "planner" }]]);
  accounts.rows.set(ALICE, {
    userId: ALICE,
    tenantId: TENANT,
    email: "alice@example.com",
    passwordHash: `fake$${PASSWORD}`,
    mustChangePassword: false,
    lockedUntil: null,
    disabled: false,
    failures: 0,
  });
  let secret = 0;
  let sessionId = 0;
  const membersPort: Members = {
    principalFor: (tenantId, userId) => {
      const principal = members.get(userId);
      return Promise.resolve(principal?.tenantId === tenantId ? principal : undefined);
    },
  };
  service = authService({
    accounts,
    sessions,
    hasher,
    tokens: codec,
    members: membersPort,
    audit,
    now: () => clock,
    newSessionId: () => `session-${String(++sessionId)}`,
    newSecret: () => String(++secret).padStart(43, "s"),
    oidc: { provider, identities },
  });
});

async function loggedIn(): Promise<Tokens> {
  const result = await service.login("alice@example.com", PASSWORD);
  if (!result.ok) throw new Error("login failed");
  return result.value;
}

describe("login", () => {
  it("issues a 10-minute access token and a refresh token, storing only the refresh token's digest", async () => {
    const tokens = await loggedIn();
    expect(tokens.accessExpiresAt).toEqual(new Date(clock.getTime() + 10 * 60_000));
    expect(tokens.refreshToken).toMatch(/^aer_[A-Za-z0-9_-]{43}$/);
    expect(tokens.refreshExpiresAt).toEqual(new Date(clock.getTime() + AUTH_LIMITS.idleTtlMs));
    expect(codec.issued[0]?.claims).toEqual({
      userId: ALICE,
      tenantId: TENANT,
      sessionId: "session-1",
    });
    const stored = sessions.rows[0];
    expect(stored?.refreshHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sessions.rows)).not.toContain(tokens.refreshToken);
  });

  it("matches the email regardless of case and surrounding spaces", async () => {
    expect((await service.login("  Alice@Example.com ", PASSWORD)).ok).toBe(true);
  });

  it.each([
    ["a wrong password", "alice@example.com", "wrong password!"],
    ["an unknown email", "nobody@example.com", PASSWORD],
    ["a malformed email", "not-an-email", PASSWORD],
  ])(
    "answers %s with the same LoginFailed, after one hash verification",
    async (_, email, password) => {
      expect(await service.login(email, password)).toEqual({
        ok: false,
        error: { kind: "LoginFailed" },
      });
      expect(hasher.verifications).toBe(1);
      expect(sessions.rows).toHaveLength(0);
    },
  );

  it("refuses a disabled account", async () => {
    updateAlice({ disabled: true });
    expect((await service.login("alice@example.com", PASSWORD)).ok).toBe(false);
  });

  it("locks the account for 15 minutes after 5 consecutive failures, even for the right password", async () => {
    for (let i = 0; i < 5; i++) await service.login("alice@example.com", "wrong password!");
    expect((await service.login("alice@example.com", PASSWORD)).ok).toBe(false);
    tick(15 * 60_000 - 1);
    expect((await service.login("alice@example.com", PASSWORD)).ok).toBe(false);
    tick(1);
    expect((await service.login("alice@example.com", PASSWORD)).ok).toBe(true);
  });

  it("starts the failure count again after a successful login", async () => {
    for (let i = 0; i < 4; i++) await service.login("alice@example.com", "wrong password!");
    await loggedIn();
    for (let i = 0; i < 4; i++) await service.login("alice@example.com", "wrong password!");
    expect((await service.login("alice@example.com", PASSWORD)).ok).toBe(true);
  });

  it("reports that the password must be changed", async () => {
    updateAlice({ mustChangePassword: true });
    expect((await loggedIn()).mustChangePassword).toBe(true);
  });
});

describe("audit", () => {
  const types = () => audit.events.map((e) => [e.type, e.payload]);

  it("records successful and failed logins of known accounts under their tenant", async () => {
    await loggedIn();
    await service.login("alice@example.com", "wrong password!");
    expect(audit.events.every((e) => e.tenantId === TENANT && e.subjectId === ALICE)).toBe(true);
    expect(types()).toEqual([
      ["login.succeeded", {}],
      ["login.failed", { reason: "wrong_password", locked: false }],
    ]);
  });

  it("records the failure that locks the account, and later ones as locked", async () => {
    for (let i = 0; i < 6; i++) await service.login("alice@example.com", "wrong password!");
    expect(types().slice(-2)).toEqual([
      ["login.failed", { reason: "wrong_password", locked: true }],
      ["login.failed", { reason: "locked", locked: true }],
    ]);
  });

  it("records nothing for an unknown email, which has no tenant", async () => {
    await service.login("nobody@example.com", PASSWORD);
    expect(audit.events).toEqual([]);
  });

  it("records a password change, and never a password", async () => {
    await service.changePassword(
      { tenantId: TENANT, userId: ALICE, role: "planner" },
      PASSWORD,
      "a brand new passphrase",
    );
    expect(types()).toContainEqual(["password.changed", {}]);
    expect(JSON.stringify(audit.events)).not.toMatch(/correct horse|brand new/);
  });
});

describe("refresh", () => {
  it("rotates the refresh token and issues a new access token", async () => {
    const first = await loggedIn();
    tick(60_000);
    const second = await service.refresh(first.refreshToken);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.refreshToken).not.toBe(first.refreshToken);
    expect(second.value.accessExpiresAt).toEqual(new Date(clock.getTime() + 10 * 60_000));
    expect((await service.refresh(second.value.refreshToken ?? "")).ok).toBe(true);
  });

  it("answers a concurrent refresh with the replaced token with an access token only", async () => {
    const first = await loggedIn();
    const second = await service.refresh(first.refreshToken);
    tick(AUTH_LIMITS.refreshGraceMs - 1);
    const late = await service.refresh(first.refreshToken);
    expect(late.ok && late.value.refreshToken).toBeUndefined();
    expect(late.ok && late.value.accessToken).toMatch(/^jwt\./);
    // The session lives on with the token from the first refresh.
    expect(second.ok && (await service.refresh(second.value.refreshToken ?? "")).ok).toBe(true);
  });

  it("revokes the session when a replaced refresh token is presented after the grace period", async () => {
    const first = await loggedIn();
    const second = await service.refresh(first.refreshToken);
    if (!second.ok) throw new Error("refresh failed");
    tick(AUTH_LIMITS.refreshGraceMs);
    expect(await service.refresh(first.refreshToken)).toEqual({
      ok: false,
      error: { kind: "SessionInvalid" },
    });
    expect((await service.refresh(second.value.refreshToken ?? "")).ok).toBe(false);
  });

  it("ends a session idle for 12 hours", async () => {
    const tokens = await loggedIn();
    tick(AUTH_LIMITS.idleTtlMs);
    expect((await service.refresh(tokens.refreshToken)).ok).toBe(false);
  });

  it("ends a session 7 days after login, however active", async () => {
    let tokens: RefreshedTokens = await loggedIn();
    for (let elapsed = 0; elapsed < AUTH_LIMITS.absoluteTtlMs - 11 * 60 * 60_000;) {
      tick(11 * 60 * 60_000);
      elapsed += 11 * 60 * 60_000;
      const next = await service.refresh(tokens.refreshToken ?? "");
      if (!next.ok) throw new Error(`refresh failed after ${String(elapsed)} ms`);
      tokens = next.value;
      expect(tokens.refreshExpiresAt <= new Date("2026-11-21T00:00:00Z")).toBe(true);
    }
    tick(11 * 60 * 60_000);
    expect((await service.refresh(tokens.refreshToken ?? "")).ok).toBe(false);
  });

  it("refuses a user who is no longer a member", async () => {
    const tokens = await loggedIn();
    members.delete(ALICE);
    expect((await service.refresh(tokens.refreshToken)).ok).toBe(false);
  });

  it.each(["", "aep_" + "a".repeat(43), "aer_short"])(
    "refuses the malformed token %j",
    async (token) => {
      expect((await service.refresh(token)).ok).toBe(false);
    },
  );
});

describe("logout", () => {
  it("revokes the session's refresh token", async () => {
    const tokens = await loggedIn();
    await service.logout(tokens.refreshToken);
    expect((await service.refresh(tokens.refreshToken)).ok).toBe(false);
  });
});

describe("changePassword", () => {
  const alice: Principal = { tenantId: TENANT, userId: ALICE, role: "planner" };

  it("replaces the password, clears the must-change flag, ends every session and starts a new one", async () => {
    updateAlice({ mustChangePassword: true });
    const old = await loggedIn();
    const changed = await service.changePassword(alice, PASSWORD, "a brand new passphrase");
    expect(changed.ok && changed.value.mustChangePassword).toBe(false);
    expect((await service.refresh(old.refreshToken)).ok).toBe(false);
    expect((await service.login("alice@example.com", PASSWORD)).ok).toBe(false);
    expect((await service.login("alice@example.com", "a brand new passphrase")).ok).toBe(true);
  });

  it.each([
    ["a wrong current password", "wrong password!", "a brand new passphrase", "currentPassword"],
    ["a short new password", PASSWORD, "short", "newPassword"],
    ["the same password", PASSWORD, PASSWORD, "newPassword"],
  ])("refuses %s", async (_, current, next, field) => {
    expect(await service.changePassword(alice, current, next)).toMatchObject({
      ok: false,
      error: { kind: "Invalid", field },
    });
    expect(accounts.rows.get(ALICE)?.passwordHash).toBe(`fake$${PASSWORD}`);
  });

  it("counts wrong current passwords towards the lock", async () => {
    for (let i = 0; i < 5; i++)
      await service.changePassword(alice, "wrong password!", "a brand new passphrase");
    expect((await service.login("alice@example.com", PASSWORD)).ok).toBe(false);
  });
});

describe("bearerIdentity", () => {
  const apiPrincipal: Principal = { tenantId: TENANT, userId: ALICE, role: "admin" };
  const identity = () =>
    bearerIdentity({
      apiTokens: {
        authenticate: (credential) =>
          Promise.resolve(credential === `aep_${"k".repeat(43)}` ? apiPrincipal : undefined),
      },
      tokens: codec,
      members: {
        principalFor: (tenantId, userId) =>
          Promise.resolve(
            members.get(userId)?.tenantId === tenantId ? members.get(userId) : undefined,
          ),
      },
    });

  it("hands API tokens to the API token identity", async () => {
    expect(await identity().authenticate(`aep_${"k".repeat(43)}`)).toBe(apiPrincipal);
  });

  it("resolves an access token to the member's current principal", async () => {
    const tokens = await loggedIn();
    members.set(ALICE, { tenantId: TENANT, userId: ALICE, role: "viewer" });
    expect(await identity().authenticate(tokens.accessToken)).toMatchObject({ role: "viewer" });
  });

  it("refuses an access token of a user who is no longer a member", async () => {
    const tokens = await loggedIn();
    members.delete(ALICE);
    expect(await identity().authenticate(tokens.accessToken)).toBeUndefined();
  });

  it("refuses an unknown token", async () => {
    expect(await identity().authenticate("jwt.99")).toBeUndefined();
  });
});

describe("OIDC login", () => {
  const callback = new URL("https://web.example/login/oidc/callback?code=c&state=s");
  const claims = (change: Partial<OidcClaims> = {}): OidcClaims => ({
    issuer: ISSUER,
    subject: "idp-alice",
    email: "Alice@Example.com",
    emailVerified: true,
    ...change,
  });
  const finish = () => service.oidcFinish(callback, CHECKS);

  it("logs in a registered member by verified email, binds the subject, and audits the method", async () => {
    provider.claims = claims();
    const result = await finish();
    expect(result.ok && result.value.mustChangePassword).toBe(false);
    expect(codec.issued[0]?.claims).toMatchObject({ userId: ALICE, tenantId: TENANT });
    expect(identities.bound.get(`${ISSUER} idp-alice`)?.userId).toBe(ALICE);
    expect(audit.events.map((e) => [e.type, e.payload])).toEqual([
      ["login.succeeded", { method: "oidc" }],
    ]);
  });

  it("logs in later by the bound subject, even if the email claim changed", async () => {
    provider.claims = claims();
    await finish();
    provider.claims = claims({ email: "renamed@example.com" });
    expect((await finish()).ok).toBe(true);
  });

  it.each([
    ["an unverified email", claims({ emailVerified: false }), "unverified_email"],
    ["no email claim", { issuer: ISSUER, subject: "idp-alice", emailVerified: true }, undefined],
    ["an unregistered email", claims({ email: "nobody@example.com" }), undefined],
  ])("refuses %s without binding", async (_, given, reason) => {
    provider.claims = given;
    expect(await finish()).toEqual({ ok: false, error: { kind: "LoginFailed" } });
    expect(identities.bound.size).toBe(0);
    expect(audit.events.map((e) => e.payload["reason"])).toEqual(
      reason === undefined ? [] : [reason],
    );
  });

  it("refuses a second subject at the same issuer for a member already bound", async () => {
    provider.claims = claims();
    await finish();
    provider.claims = claims({ subject: "someone-else" });
    expect((await finish()).ok).toBe(false);
    expect(audit.events.at(-1)?.payload).toMatchObject({ reason: "subject_mismatch" });
  });

  it("refuses a disabled member", async () => {
    identities.byEmail.set("alice@example.com", {
      userId: ALICE,
      tenantId: TENANT,
      disabled: true,
    });
    provider.claims = claims();
    expect((await finish()).ok).toBe(false);
    expect(audit.events.at(-1)?.payload).toMatchObject({ reason: "disabled" });
  });

  it("refuses when the provider's checks fail", async () => {
    provider.claims = claims();
    expect((await service.oidcFinish(callback, { ...CHECKS, state: "other" })).ok).toBe(false);
    expect(codec.issued).toEqual([]);
  });
});
