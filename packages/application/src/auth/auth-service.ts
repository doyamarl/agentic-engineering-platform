import { createHash } from "node:crypto";
import {
  err,
  normalizeEmail,
  ok,
  validatePassword,
  type Result,
  type TenantId,
  type UserId,
} from "@aep/domain";
import type { AppError } from "../errors.ts";
import type { IdentityPort } from "../ports.ts";
import type { Principal } from "../principal.ts";
import type {
  AccessTokenCodec,
  LoginMember,
  Members,
  OidcChecks,
  OidcIdentities,
  OidcProvider,
  OidcStart,
  PasswordAccount,
  PasswordAccounts,
  PasswordHasher,
  Sessions,
} from "./auth-ports.ts";
import type { AuditLog } from "../members/member-ports.ts";

// Password login and the tokens it hands out (ADR-011).

export const AUTH_LIMITS = {
  accessTtlMs: 10 * 60_000,
  idleTtlMs: 12 * 60 * 60_000,
  absoluteTtlMs: 7 * 24 * 60 * 60_000,
  maxFailures: 5,
  /** How long the refresh token replaced last still works, without rotating (see Rotation). */
  refreshGraceMs: 10_000,
  lockMs: 15 * 60_000,
} as const;

export const REFRESH_TOKEN_PREFIX = "aer_";
/** 32 random bytes in base64url is 43 characters. */
const REFRESH_TOKEN = /^aer_[A-Za-z0-9_-]{43}$/;
const API_TOKEN_PREFIX = "aep_";

export type Tokens = {
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  /** The earlier of the idle and the absolute limit. */
  readonly refreshExpiresAt: Date;
  readonly mustChangePassword: boolean;
};

/** A refresh answer: without a refresh token when a concurrent refresh already replaced it. */
export type RefreshedTokens = Omit<Tokens, "refreshToken"> & { readonly refreshToken?: string };

/** One answer for every failed login, so a caller cannot learn which accounts exist. */
export type LoginFailed = { readonly kind: "LoginFailed" };
export type SessionInvalid = { readonly kind: "SessionInvalid" };

type Deps = {
  readonly accounts: PasswordAccounts;
  readonly sessions: Sessions;
  readonly hasher: PasswordHasher;
  readonly tokens: AccessTokenCodec;
  readonly members: Members;
  /** Records login outcomes of known accounts; unknown emails have no tenant to record under. */
  readonly audit: AuditLog;
  readonly now: () => Date;
  readonly newSessionId: () => string;
  /** 32 random bytes, base64url. */
  readonly newSecret: () => string;
  /** OIDC login, when the operator enabled it. */
  readonly oidc?: { readonly provider: OidcProvider; readonly identities: OidcIdentities };
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const later = (from: Date, ms: number): Date => new Date(from.getTime() + ms);
const earlier = (a: Date, b: Date): Date => (a < b ? a : b);
const loginFailed = () => err({ kind: "LoginFailed" } as const);
const sessionInvalid = () => err({ kind: "SessionInvalid" } as const);

export function authService(deps: Deps) {
  const { accounts, sessions, hasher, tokens, now } = deps;

  // Verified against when there is no real hash, so unknown accounts take as long as known ones.
  let dummyHash: Promise<string> | undefined;
  const burnTime = async (password: string): Promise<void> => {
    dummyHash ??= hasher.hash(deps.newSecret());
    await hasher.verify(await dummyHash, password);
  };

  async function issue<R extends string | undefined>(
    session: { readonly id: string; readonly tenantId: TenantId; readonly userId: UserId },
    refreshToken: R,
    refreshExpiresAt: Date,
    mustChangePassword: boolean,
  ): Promise<R extends string ? Tokens : RefreshedTokens> {
    const accessExpiresAt = later(now(), AUTH_LIMITS.accessTtlMs);
    const accessToken = await tokens.issue(
      { userId: session.userId, tenantId: session.tenantId, sessionId: session.id },
      accessExpiresAt,
    );
    const issued: RefreshedTokens = {
      accessToken,
      accessExpiresAt,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      refreshExpiresAt,
      mustChangePassword,
    };
    return issued as R extends string ? Tokens : RefreshedTokens;
  }

  async function startSession(
    account: Pick<LoginMember, "userId" | "tenantId">,
    mustChangePassword: boolean,
  ) {
    const at = now();
    const refreshToken = REFRESH_TOKEN_PREFIX + deps.newSecret();
    const session = {
      id: deps.newSessionId(),
      tenantId: account.tenantId,
      userId: account.userId,
      refreshHash: sha256(refreshToken),
      idleExpiresAt: later(at, AUTH_LIMITS.idleTtlMs),
      absoluteExpiresAt: later(at, AUTH_LIMITS.absoluteTtlMs),
    };
    await sessions.create(session);
    return issue(
      session,
      refreshToken,
      earlier(session.idleExpiresAt, session.absoluteExpiresAt),
      mustChangePassword,
    );
  }

  type Check =
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly reason: "disabled" | "locked" | "wrong_password";
        readonly locked: boolean;
      };

  /** Checks `password` against the account, counting failures and locking after too many. */
  async function checkPassword(account: PasswordAccount, password: string): Promise<Check> {
    if (account.disabled) {
      await burnTime(password);
      return { ok: false, reason: "disabled", locked: false };
    }
    if (account.lockedUntil !== null && account.lockedUntil > now()) {
      await burnTime(password);
      return { ok: false, reason: "locked", locked: true };
    }
    if (await hasher.verify(account.passwordHash, password)) {
      await accounts.clearFailures(account.userId);
      return { ok: true };
    }
    const failures = await accounts.addFailure(account.userId);
    const locked = failures >= AUTH_LIMITS.maxFailures;
    if (locked) await accounts.lock(account.userId, later(now(), AUTH_LIMITS.lockMs));
    return { ok: false, reason: "wrong_password", locked };
  }

  const recordFailure = (account: PasswordAccount, check: Check & { ok: false }) =>
    deps.audit.record(account.tenantId, {
      type: "login.failed",
      actorId: null,
      subjectId: account.userId,
      payload: { reason: check.reason, locked: check.locked },
    });

  return {
    async login(email: string, password: string): Promise<Result<Tokens, LoginFailed>> {
      const normalized = normalizeEmail(email);
      const account = normalized.ok ? await accounts.findByEmail(normalized.value) : undefined;
      if (account === undefined) {
        await burnTime(password);
        return loginFailed();
      }
      const check = await checkPassword(account, password);
      if (!check.ok) {
        await recordFailure(account, check);
        return loginFailed();
      }
      await deps.audit.record(account.tenantId, {
        type: "login.succeeded",
        actorId: account.userId,
        subjectId: account.userId,
        payload: {},
      });
      return ok(await startSession(account, account.mustChangePassword));
    },

    /** Where to send the browser, and the checks to keep for the way back; undefined if off. */
    async oidcStart(): Promise<OidcStart | undefined> {
      return deps.oidc?.provider.start();
    },

    /**
     * Logs in the member the provider vouches for. A first login matches a verified email of a
     * registered member and binds the provider's subject; later logins match the subject only.
     */
    async oidcFinish(callback: URL, checks: OidcChecks): Promise<Result<Tokens, LoginFailed>> {
      if (deps.oidc === undefined) return loginFailed();
      const { provider, identities } = deps.oidc;
      const claims = await provider.finish(callback, checks);
      if (claims === undefined) return loginFailed();

      const fail = async (member: LoginMember, reason: string) => {
        await deps.audit.record(member.tenantId, {
          type: "login.failed",
          actorId: null,
          subjectId: member.userId,
          payload: { method: "oidc", reason, locked: false },
        });
        return loginFailed();
      };

      let member = await identities.findBySubject(claims.issuer, claims.subject);
      if (member === undefined) {
        const email = normalizeEmail(claims.email ?? "");
        const byEmail = email.ok ? await identities.findByEmail(email.value) : undefined;
        if (byEmail === undefined) return loginFailed();
        // An unverified email claim could be anyone's; never bind on it.
        if (!claims.emailVerified) return fail(byEmail, "unverified_email");
        if (!(await identities.bind(claims.issuer, claims.subject, byEmail))) {
          return fail(byEmail, "subject_mismatch");
        }
        member = byEmail;
      }
      if (member.disabled) return fail(member, "disabled");

      await deps.audit.record(member.tenantId, {
        type: "login.succeeded",
        actorId: member.userId,
        subjectId: member.userId,
        payload: { method: "oidc" },
      });
      return ok(await startSession(member, false));
    },

    async refresh(refreshToken: string): Promise<Result<RefreshedTokens, SessionInvalid>> {
      if (!REFRESH_TOKEN.test(refreshToken)) return sessionInvalid();
      const at = now();
      const next = REFRESH_TOKEN_PREFIX + deps.newSecret();
      const rotation = await sessions.rotate(
        sha256(refreshToken),
        { refreshHash: sha256(next), idleExpiresAt: later(at, AUTH_LIMITS.idleTtlMs) },
        at,
        later(at, -AUTH_LIMITS.refreshGraceMs),
      );
      if (rotation === undefined || rotation.kind === "reused") return sessionInvalid();
      const { session } = rotation;
      const principal = await deps.members.principalFor(session.tenantId, session.userId);
      if (principal === undefined) {
        await sessions.revokeAllOf(session.userId, at);
        return sessionInvalid();
      }
      return ok(
        await issue(
          session,
          rotation.kind === "rotated" ? next : undefined,
          earlier(session.idleExpiresAt, session.absoluteExpiresAt),
          principal.mustChangePassword === true,
        ),
      );
    },

    async logout(refreshToken: string): Promise<void> {
      if (REFRESH_TOKEN.test(refreshToken)) {
        await sessions.revokeByRefreshHash(sha256(refreshToken), now());
      }
    },

    /**
     * Replaces the caller's password. Every session of the user ends, including the caller's,
     * and the caller gets a fresh one.
     */
    async changePassword(
      principal: Principal,
      currentPassword: string,
      newPassword: string,
    ): Promise<Result<Tokens, AppError>> {
      const account = await accounts.findByUserId(principal.userId);
      if (account === undefined) {
        return err({ kind: "Conflict", reason: "this user has no password login" });
      }
      const check = await checkPassword(account, currentPassword);
      if (!check.ok) {
        await recordFailure(account, check);
        return err({ kind: "Invalid", field: "currentPassword", reason: "is not correct" });
      }
      const valid = validatePassword(newPassword);
      if (!valid.ok)
        return err({ kind: "Invalid", field: "newPassword", reason: valid.error.reason });
      if (newPassword === currentPassword) {
        return err({
          kind: "Invalid",
          field: "newPassword",
          reason: "must differ from the current one",
        });
      }
      await accounts.setPassword(account.userId, await hasher.hash(newPassword), false);
      await sessions.revokeAllOf(account.userId, now());
      await deps.audit.record(account.tenantId, {
        type: "password.changed",
        actorId: account.userId,
        subjectId: account.userId,
        payload: {},
      });
      return ok(await startSession(account, false));
    },
  };
}

export type AuthService = ReturnType<typeof authService>;

/**
 * Accepts API tokens (`aep_…`) through `apiTokens` and access tokens through `tokens`. Both
 * resolve the principal from the current membership, so disabling a user or changing a role
 * applies to the next request.
 */
export function bearerIdentity(deps: {
  readonly apiTokens: IdentityPort;
  readonly tokens: AccessTokenCodec;
  readonly members: Members;
}): IdentityPort {
  return {
    async authenticate(credential) {
      if (credential.startsWith(API_TOKEN_PREFIX)) return deps.apiTokens.authenticate(credential);
      const claims = await deps.tokens.verify(credential);
      return claims && deps.members.principalFor(claims.tenantId, claims.userId);
    },
  };
}
