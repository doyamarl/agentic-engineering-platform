import type { Result, Role, TenantId, UserId } from "@aep/domain";

// Tenant administration (ADR-011): members, their roles and logins, and the audit trail of
// those changes. Every method takes tenantId; implementations scope reads and writes to it.

export type AuditEventType =
  | "member.created"
  | "member.role_changed"
  | "member.disabled"
  | "member.enabled"
  | "member.password_reset"
  | "login.succeeded"
  | "login.failed"
  | "password.changed"
  | "settings.chat_model_changed"
  | "connection.connected"
  | "connection.disconnected"
  | "connector.tool_called"
  | "connector.tool_decided"
  | "workspace.repository_added"
  | "workspace.repository_removed";

/** Payloads hold identifiers, roles and reasons; never passwords or tokens. */
export type AuditEventInput = {
  readonly type: AuditEventType;
  /** The person who acted; null when nobody was logged in (e.g. a failed login). */
  readonly actorId: UserId | null;
  readonly subjectId: UserId | null;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
};

export type AuditEvent = AuditEventInput & {
  /** Increasing across the instance; clients follow the log by passing the last id they saw. */
  readonly id: number;
  readonly occurredAt: Date;
};

export interface AuditLog {
  record(tenantId: TenantId, event: AuditEventInput): Promise<void>;
  list(
    tenantId: TenantId,
    options: { readonly afterId?: number; readonly limit: number },
  ): Promise<readonly AuditEvent[]>;
}

export type Member = {
  readonly userId: UserId;
  readonly displayName: string;
  readonly email: string | null;
  readonly role: Role;
  readonly disabled: boolean;
  /** Whether the member has a password to log in with. */
  readonly passwordLogin: boolean;
  readonly createdAt: Date;
};

export type NewMember = {
  readonly userId: UserId;
  readonly displayName: string;
  readonly email: string;
  readonly role: Role;
  readonly passwordHash: string;
};

export type MemberChange = { readonly role?: Role; readonly disabled?: boolean };

export type MemberWriteError =
  | { readonly kind: "EmailTaken" }
  | { readonly kind: "NotFound" }
  /** The member changed since it was read. */
  | { readonly kind: "Stale" }
  /** The change would leave the tenant without an active admin. */
  | { readonly kind: "LastAdmin" };

export interface MemberRepository {
  list(tenantId: TenantId): Promise<readonly Member[]>;
  find(tenantId: TenantId, userId: UserId): Promise<Member | undefined>;
  /** Creates the user, the membership and a password that must be changed, with `audit`. */
  create(
    tenantId: TenantId,
    member: NewMember,
    audit: AuditEventInput,
  ): Promise<Result<Member, MemberWriteError>>;
  /**
   * Applies `change` if the member still has `expected`'s role and disabled flag, refusing
   * to leave no active admin. Disabling ends the member's sessions. Writes `audit` with it.
   */
  update(
    tenantId: TenantId,
    expected: Member,
    change: MemberChange,
    audit: readonly AuditEventInput[],
  ): Promise<Result<Member, MemberWriteError>>;
  /** Sets a password that must be changed, clears any lock and ends the member's sessions. */
  resetPassword(
    tenantId: TenantId,
    userId: UserId,
    passwordHash: string,
    audit: AuditEventInput,
  ): Promise<Result<Member, MemberWriteError>>;
}
