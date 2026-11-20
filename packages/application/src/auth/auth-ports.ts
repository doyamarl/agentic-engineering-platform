import type { TenantId, UserId } from "@aep/domain";
import type { Principal } from "../principal.ts";

// Ports for people logging in with a password (ADR-011). API tokens stay behind IdentityPort.

export interface PasswordHasher {
  /** A self-describing hash string (algorithm, parameters, salt and digest). */
  hash(password: string): Promise<string>;
  /** False for a wrong password or a hash this hasher cannot read; never throws for either. */
  verify(hash: string, password: string): Promise<boolean>;
}

/** What an access token asserts. The API still loads the membership on every request. */
export type AccessClaims = {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly sessionId: string;
};

export interface AccessTokenCodec {
  issue(claims: AccessClaims, expiresAt: Date): Promise<string>;
  /** The claims of a token this codec issued and that has not expired, otherwise undefined. */
  verify(token: string): Promise<AccessClaims | undefined>;
}

export type PasswordAccount = {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly passwordHash: string;
  readonly mustChangePassword: boolean;
  readonly lockedUntil: Date | null;
  readonly disabled: boolean;
};

export interface PasswordAccounts {
  findByEmail(email: string): Promise<PasswordAccount | undefined>;
  findByUserId(userId: UserId): Promise<PasswordAccount | undefined>;
  /** Adds one to the consecutive failures and returns the new count. */
  addFailure(userId: UserId): Promise<number>;
  /** Sets locked_until and clears the failure count. */
  lock(userId: UserId, until: Date): Promise<void>;
  /** Clears the failure count and any lock. */
  clearFailures(userId: UserId): Promise<void>;
  setPassword(userId: UserId, hash: string, mustChangePassword: boolean): Promise<void>;
}

export type NewSession = {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  /** SHA-256 hex of the refresh token; the token itself is never stored. */
  readonly refreshHash: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
};

export type ActiveSession = Omit<NewSession, "refreshHash">;

export type Rotation =
  | { readonly kind: "rotated"; readonly session: ActiveSession }
  /**
   * The token replaced last, presented again within the grace period: two requests from one
   * browser refreshed at the same time. The session stays and nothing rotates.
   */
  | { readonly kind: "superseded"; readonly session: ActiveSession }
  /** The token replaced last, presented after the grace period; the session is now revoked. */
  | { readonly kind: "reused" };

export interface Sessions {
  create(session: NewSession): Promise<void>;
  /**
   * Replaces the refresh token of the live session that holds `refreshHash`. The token replaced
   * last is "superseded" if that replacement happened after `graceSince`, otherwise "reused"
   * (a copy of it was used by someone else, so the session is revoked). Anything else
   * (unknown, revoked, expired) answers undefined.
   */
  rotate(
    refreshHash: string,
    next: { readonly refreshHash: string; readonly idleExpiresAt: Date },
    now: Date,
    graceSince: Date,
  ): Promise<Rotation | undefined>;
  revokeByRefreshHash(refreshHash: string, now: Date): Promise<void>;
  revokeAllOf(userId: UserId, now: Date): Promise<void>;
}

/** Resolves a user to the principal they act as now, or undefined if disabled or not a member. */
export interface Members {
  principalFor(tenantId: TenantId, userId: UserId): Promise<Principal | undefined>;
}

// OIDC login (ADR-011): one identity provider for the instance. The API exchanges the code, so
// the client secret stays here; the web server only redirects and keeps the one-time checks.

/** The one-time values a login attempt must present again on the way back. */
export type OidcChecks = {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
};

export type OidcStart = OidcChecks & { readonly authorizationUrl: string };

/** Claims of an ID token whose signature, issuer, audience, expiry and nonce were verified. */
export type OidcClaims = {
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified: boolean;
};

export interface OidcProvider {
  /** Shown on the login button, e.g. the company's name. */
  readonly name: string;
  start(): Promise<OidcStart>;
  /**
   * Exchanges the code in `callback` (the redirect URI with the provider's query) and returns
   * the verified claims, or undefined for any error, refusal or failed check.
   */
  finish(callback: URL, checks: OidcChecks): Promise<OidcClaims | undefined>;
}

export type LoginMember = {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly disabled: boolean;
};

export interface OidcIdentities {
  findBySubject(issuer: string, subject: string): Promise<LoginMember | undefined>;
  /** The registered member with this (normalized) email, if any. */
  findByEmail(email: string): Promise<LoginMember | undefined>;
  /**
   * Binds the provider's subject to the member. False when the member already has another
   * subject at this issuer (the email now belongs to someone else there).
   */
  bind(issuer: string, subject: string, member: LoginMember): Promise<boolean>;
}
