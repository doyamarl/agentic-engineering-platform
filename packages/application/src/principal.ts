import type { Role, TenantId, UserId } from "@aep/domain";

/**
 * The authenticated caller. Every use case takes its tenant from here and never from request
 * input, so a client cannot choose which tenant it acts on (ADR §2).
 */
export type Principal = {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly role: Role;
  /** Set after an admin issued the password: only the password change is allowed until then. */
  readonly mustChangePassword?: boolean;
};
