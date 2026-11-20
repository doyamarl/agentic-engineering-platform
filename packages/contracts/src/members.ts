import { z } from "zod";

// Public HTTP contract for /v1/members and /v1/audit-events (ADR-011), for tenant admins.
// Upper bounds only bound the payload; the domain enforces the rules.

const Role = z.enum(["admin", "planner", "engineer", "viewer"]);

export const MemberDto = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  email: z.string().nullable(),
  role: Role,
  disabled: z.boolean(),
  /** Whether the member has a password to log in with. */
  passwordLogin: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type MemberDto = z.infer<typeof MemberDto>;

export const MemberListDto = z.object({ items: z.array(MemberDto) });
export type MemberListDto = z.infer<typeof MemberListDto>;

/** Returned once when a member is created or a password is reset; hand it over securely. */
export const MemberWithPasswordDto = z.object({
  member: MemberDto,
  initialPassword: z.string(),
});
export type MemberWithPasswordDto = z.infer<typeof MemberWithPasswordDto>;

export const CreateMemberRequest = z.strictObject({
  displayName: z.string().max(1000),
  email: z.string().max(1000),
  role: z.string().max(50),
});
export type CreateMemberRequest = z.infer<typeof CreateMemberRequest>;

export const UpdateMemberRequest = z.strictObject({
  role: z.string().max(50).optional(),
  disabled: z.boolean().optional(),
});
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

export const ListAuditEventsQuery = z.strictObject({
  /** The last id already seen; events after it are returned. */
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().optional(),
});
export type ListAuditEventsQuery = z.infer<typeof ListAuditEventsQuery>;

export const AuditEventDto = z.object({
  id: z.number().int(),
  type: z.string(),
  actorId: z.uuid().nullable(),
  subjectId: z.uuid().nullable(),
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  occurredAt: z.iso.datetime(),
});
export type AuditEventDto = z.infer<typeof AuditEventDto>;

export const AuditEventListDto = z.object({ items: z.array(AuditEventDto) });
export type AuditEventListDto = z.infer<typeof AuditEventListDto>;
