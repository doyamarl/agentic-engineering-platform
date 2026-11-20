import { z } from "zod";

// Public HTTP contract for /v1/missions (PRD FR-10: UI and CLI use the same versioned API).
// Requests are strict: unknown fields such as tenantId are rejected, never ignored.

/** Where the mission's work comes from. Upper bounds only bound the payload; the domain validates. */
export const MissionSourceDto = z.strictObject({
  kind: z.literal("github_issue"),
  owner: z.string().max(100),
  repo: z.string().max(100),
  issueNumber: z.number().int(),
  baseBranch: z.string().max(255),
});
export type MissionSourceDto = z.infer<typeof MissionSourceDto>;

export const CreateMissionRequest = z.strictObject({
  workspaceId: z.uuid(),
  // Upper bound only bounds the payload; the domain enforces the 1-200 character rule.
  title: z.string().max(1000),
  source: MissionSourceDto.optional(),
});
export type CreateMissionRequest = z.infer<typeof CreateMissionRequest>;

export const ListMissionsQuery = z.strictObject({
  workspaceId: z.uuid().optional(),
  limit: z.coerce.number().int().optional(),
});
export type ListMissionsQuery = z.infer<typeof ListMissionsQuery>;

/** Upper bounds only bound the payload; the service trims and enforces 1-4000 characters. */
export const ApprovePlanRequest = z.strictObject({
  planVersion: z.number().int().positive(),
  comment: z.string().max(8000).optional(),
});
export type ApprovePlanRequest = z.infer<typeof ApprovePlanRequest>;

export const RejectPlanRequest = z.strictObject({
  planVersion: z.number().int().positive(),
  reason: z.string().max(8000),
});
export type RejectPlanRequest = z.infer<typeof RejectPlanRequest>;

export const MissionDto = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  title: z.string(),
  source: MissionSourceDto.optional(),
  status: z.string(),
  /** The plan version awaiting approval (AWAITING_PLAN_APPROVAL). */
  planVersion: z.number().int().optional(),
  /** The plan version a person approved, once there is one. */
  approvedPlanVersion: z.number().int().optional(),
  /** The acceptance packet version presented for release approval, once there is one. */
  packetVersion: z.number().int().optional(),
  /** Why the mission failed or is blocked. */
  reason: z.string().optional(),
  version: z.number().int(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
});
export type MissionDto = z.infer<typeof MissionDto>;

export const MissionListDto = z.object({ items: z.array(MissionDto) });
export type MissionListDto = z.infer<typeof MissionListDto>;

/** One immutable plan version. Approval names `version`; `checksumSha256` identifies the body. */
export const PlanDto = z.object({
  missionId: z.uuid(),
  version: z.number().int(),
  body: z.string(),
  checksumSha256: z.string(),
  author: z.object({ kind: z.enum(["human", "agent", "system"]), id: z.string().optional() }),
  createdAt: z.iso.datetime(),
});
export type PlanDto = z.infer<typeof PlanDto>;

export const ListEventsQuery = z.strictObject({
  /** The last seq already seen; events after it are returned. */
  after: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().optional(),
});
export type ListEventsQuery = z.infer<typeof ListEventsQuery>;

/** One audit trail entry. Payloads hold identifiers, numbers, URLs and short reasons. */
export const MissionEventDto = z.object({
  seq: z.number().int(),
  type: z.string(),
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  actor: z.object({ kind: z.enum(["human", "agent", "system"]), id: z.string().optional() }),
  occurredAt: z.iso.datetime(),
});
export type MissionEventDto = z.infer<typeof MissionEventDto>;

export const MissionEventListDto = z.object({ items: z.array(MissionEventDto) });
export type MissionEventListDto = z.infer<typeof MissionEventListDto>;

const CiCheckDto = z.object({
  name: z.string(),
  state: z.enum(["pending", "success", "failure", "neutral"]),
  url: z.string().nullable(),
});

/** One immutable acceptance packet version (PRD FR-06). */
export const AcceptancePacketDto = z.object({
  missionId: z.uuid(),
  version: z.number().int(),
  checksumSha256: z.string(),
  createdAt: z.iso.datetime(),
  content: z.object({
    schemaVersion: z.literal(1),
    mission: z.object({ id: z.uuid(), title: z.string() }),
    source: MissionSourceDto,
    plan: z.object({
      version: z.number().int(),
      checksumSha256: z.string(),
      acceptanceCriteria: z.string().nullable(),
      risks: z.string().nullable(),
    }),
    approvals: z
      .array(
        z.object({
          subject: z.literal("plan"),
          version: z.number().int(),
          decision: z.enum(["approved", "rejected"]),
          decidedBy: z.uuid(),
          decidedAt: z.iso.datetime(),
          comment: z.string().nullable(),
        }),
      )
      .readonly(),
    pullRequest: z.object({
      number: z.number().int(),
      url: z.string(),
      branch: z.string(),
      commitSha: z.string(),
    }),
    diff: z.object({
      files: z
        .array(
          z.object({ path: z.string(), additions: z.number().int(), deletions: z.number().int() }),
        )
        .readonly(),
      additions: z.number().int(),
      deletions: z.number().int(),
      truncated: z.boolean(),
    }),
    ci: z.object({ state: z.enum(["success", "none"]), checks: z.array(CiCheckDto).readonly() }),
    costUsd: z.number().nullable(),
    residualRisks: z.array(z.string()).readonly(),
  }),
});
export type AcceptancePacketDto = z.infer<typeof AcceptancePacketDto>;

export const ErrorDto = z.object({
  error: z.object({
    code: z.enum([
      "unauthorized",
      "forbidden",
      /** The caller must change the password set by an admin before anything else. */
      "password_change_required",
      "not_found",
      "invalid_request",
      "conflict",
      "internal",
      /** An outside service, such as a connector's authorization server, failed or refused. */
      "bad_gateway",
    ]),
    message: z.string(),
  }),
});
export type ErrorDto = z.infer<typeof ErrorDto>;
