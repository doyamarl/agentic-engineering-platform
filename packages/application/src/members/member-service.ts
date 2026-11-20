import {
  can,
  err,
  isRole,
  normalizeEmail,
  ok,
  validateDisplayName,
  type Result,
  type UserId,
} from "@aep/domain";
import type { PasswordHasher } from "../auth/auth-ports.ts";
import type { AppError } from "../errors.ts";
import type { Principal } from "../principal.ts";
import type {
  AuditEvent,
  AuditEventInput,
  AuditLog,
  Member,
  MemberChange,
  MemberRepository,
  MemberWriteError,
} from "./member-ports.ts";

export const DEFAULT_AUDIT_LIMIT = 100;
export const MAX_AUDIT_LIMIT = 500;

type Deps = {
  readonly members: MemberRepository;
  readonly audit: AuditLog;
  readonly hasher: PasswordHasher;
  readonly newUserId: () => UserId;
  /** A random password of at least 12 characters, shown to the admin once. */
  readonly newPassword: () => string;
};

/** A member with the password an admin hands over; shown once, never stored in plain text. */
export type MemberWithPassword = { readonly member: Member; readonly initialPassword: string };

const forbidden = () => err({ kind: "Forbidden", action: "member:manage" } as const);
const notFound = () => err({ kind: "NotFound", resource: "member" } as const);

function writeError(error: MemberWriteError): AppError {
  switch (error.kind) {
    case "EmailTaken":
      return { kind: "Conflict", reason: "the email is already in use" };
    case "NotFound":
      return { kind: "NotFound", resource: "member" };
    case "Stale":
      return { kind: "Conflict", reason: "the member changed meanwhile; read it and retry" };
    case "LastAdmin":
      return { kind: "Conflict", reason: "the tenant needs at least one active admin" };
  }
}

const invalid = (field: string, reason: string) => err({ kind: "Invalid", field, reason } as const);

export function memberService(deps: Deps) {
  const { members, hasher } = deps;

  return {
    async list(principal: Principal): Promise<Result<readonly Member[], AppError>> {
      if (!can(principal.role, "member:manage")) return forbidden();
      return ok(await members.list(principal.tenantId));
    },

    async create(
      principal: Principal,
      input: { readonly displayName: string; readonly email: string; readonly role: string },
    ): Promise<Result<MemberWithPassword, AppError>> {
      if (!can(principal.role, "member:manage")) return forbidden();
      const displayName = validateDisplayName(input.displayName);
      if (!displayName.ok) return invalid("displayName", displayName.error.reason);
      const email = normalizeEmail(input.email);
      if (!email.ok) return invalid("email", email.error.reason);
      if (!isRole(input.role)) return invalid("role", "is not a role");

      const userId = deps.newUserId();
      const initialPassword = deps.newPassword();
      const created = await members.create(
        principal.tenantId,
        {
          userId,
          displayName: displayName.value,
          email: email.value,
          role: input.role,
          passwordHash: await hasher.hash(initialPassword),
        },
        {
          type: "member.created",
          actorId: principal.userId,
          subjectId: userId,
          payload: { role: input.role },
        },
      );
      return created.ok
        ? ok({ member: created.value, initialPassword })
        : err(writeError(created.error));
    },

    async update(
      principal: Principal,
      userId: UserId,
      input: { readonly role?: string; readonly disabled?: boolean },
    ): Promise<Result<Member, AppError>> {
      if (!can(principal.role, "member:manage")) return forbidden();
      if (input.role !== undefined && !isRole(input.role)) return invalid("role", "is not a role");
      const current = await members.find(principal.tenantId, userId);
      if (current === undefined) return notFound();

      let change: MemberChange = {};
      const audit: AuditEventInput[] = [];
      const event = (type: AuditEventInput["type"], payload: AuditEventInput["payload"] = {}) =>
        audit.push({ type, actorId: principal.userId, subjectId: userId, payload });
      if (input.role !== undefined && input.role !== current.role) {
        change = { ...change, role: input.role };
        event("member.role_changed", { from: current.role, to: input.role });
      }
      if (input.disabled !== undefined && input.disabled !== current.disabled) {
        change = { ...change, disabled: input.disabled };
        event(input.disabled ? "member.disabled" : "member.enabled");
      }
      if (audit.length === 0) return ok(current);

      const updated = await members.update(principal.tenantId, current, change, audit);
      return updated.ok ? updated : err(writeError(updated.error));
    },

    /** Issues a new password that must be changed at the next login, and ends all sessions. */
    async resetPassword(
      principal: Principal,
      userId: UserId,
    ): Promise<Result<MemberWithPassword, AppError>> {
      if (!can(principal.role, "member:manage")) return forbidden();
      const current = await members.find(principal.tenantId, userId);
      if (current === undefined) return notFound();
      if (current.email === null) {
        return err({ kind: "Conflict", reason: "the member has no email to log in with" });
      }
      const initialPassword = deps.newPassword();
      const reset = await members.resetPassword(
        principal.tenantId,
        userId,
        await hasher.hash(initialPassword),
        {
          type: "member.password_reset",
          actorId: principal.userId,
          subjectId: userId,
          payload: {},
        },
      );
      return reset.ok ? ok({ member: reset.value, initialPassword }) : err(writeError(reset.error));
    },

    async listAudit(
      principal: Principal,
      options: { readonly afterId?: number; readonly limit?: number } = {},
    ): Promise<Result<readonly AuditEvent[], AppError>> {
      if (!can(principal.role, "member:manage")) return forbidden();
      const limit = options.limit ?? DEFAULT_AUDIT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_LIMIT) {
        return invalid("limit", `must be 1 to ${String(MAX_AUDIT_LIMIT)}`);
      }
      return ok(
        await deps.audit.list(principal.tenantId, {
          limit,
          ...(options.afterId === undefined ? {} : { afterId: options.afterId }),
        }),
      );
    },
  };
}

export type MemberService = ReturnType<typeof memberService>;
