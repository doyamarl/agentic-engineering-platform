import {
  can,
  draftMission,
  err,
  ok,
  type Action,
  type Mission,
  type MissionId,
  type MissionSource,
  type Result,
  type WorkspaceId,
} from "@aep/domain";
import type { AppError } from "../errors.ts";
import type {
  MissionEvent,
  MissionRepository,
  StoredAcceptancePacket,
  StoredPlan,
} from "../ports.ts";
import type { Principal } from "../principal.ts";
import {
  applyTo,
  planningJob,
  startExecution,
  startPlanning,
  type CommandError,
} from "./mission-workflow.ts";

/** Bounds decision comments as the approvals table does. */
export const MAX_COMMENT_LENGTH = 4000;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_EVENT_LIMIT = 100;
export const MAX_EVENT_LIMIT = 500;

type Deps = {
  readonly missions: MissionRepository;
  readonly newMissionId: () => MissionId;
  readonly now: () => Date;
};

const forbidden = (action: Action) => err({ kind: "Forbidden", action } as const);

function commandError(error: CommandError): AppError {
  switch (error.kind) {
    case "NotFound":
      return { kind: "NotFound", resource: "mission" };
    case "Conflict":
      return { kind: "Conflict", reason: "the mission changed meanwhile; read it and retry" };
    case "InvalidTransition":
      return { kind: "Conflict", reason: `not allowed while the mission is ${error.from}` };
    case "VersionMismatch":
      return {
        kind: "Conflict",
        reason: `${error.subject} version ${String(error.actual)} is not the current version ${String(error.expected)}`,
      };
    case "HumanActorRequired":
      return { kind: "Conflict", reason: `${error.command} needs a human` };
  }
}

export function missionService({ missions, newMissionId, now }: Deps) {
  /** The principal's mission, if the principal may `action` and the mission is in its tenant. */
  async function authorized(
    principal: Principal,
    action: Action,
    id: MissionId,
  ): Promise<Result<Mission, AppError>> {
    if (!can(principal.role, action)) return forbidden(action);
    const mission = await missions.findById(principal.tenantId, id);
    return mission ? ok(mission) : err({ kind: "NotFound", resource: "mission" });
  }

  return {
    async create(
      principal: Principal,
      input: {
        readonly workspaceId: WorkspaceId;
        readonly title: string;
        readonly source?: MissionSource;
      },
    ): Promise<Result<Mission, AppError>> {
      if (!can(principal.role, "mission:create")) return forbidden("mission:create");

      const drafted = draftMission({
        tenantId: principal.tenantId,
        workspaceId: input.workspaceId,
        id: newMissionId(),
        title: input.title,
        ...(input.source === undefined ? {} : { source: input.source }),
        createdBy: principal.userId,
        createdAt: now(),
      });
      if (!drafted.ok) {
        return err({ kind: "Invalid", field: drafted.error.field, reason: drafted.error.reason });
      }

      const inserted = await missions.insert(drafted.value);
      return inserted.ok ? drafted : err({ kind: "NotFound", resource: "workspace" });
    },

    get(principal: Principal, id: MissionId): Promise<Result<Mission, AppError>> {
      return authorized(principal, "mission:read", id);
    },

    /** DRAFT → PLANNING; an agent then writes the first plan version (job mission.plan). */
    async startPlanning(principal: Principal, id: MissionId): Promise<Result<Mission, AppError>> {
      const found = await authorized(principal, "mission:plan", id);
      if (!found.ok) return found;
      if (found.value.source === undefined) {
        return err({ kind: "Invalid", field: "source", reason: "is required to plan a mission" });
      }
      const started = await startPlanning(missions, {
        tenantId: principal.tenantId,
        missionId: id,
        actor: { kind: "human", id: principal.userId },
        now: now(),
      });
      return started.ok ? started : err(commandError(started.error));
    },

    /**
     * Approves plan `planVersion` and starts executing it (job mission.execute). Repeating the
     * request after the approval committed but the start did not, starts it.
     */
    async approvePlan(
      principal: Principal,
      id: MissionId,
      input: { readonly planVersion: number; readonly comment?: string },
    ): Promise<Result<Mission, AppError>> {
      const found = await authorized(principal, "plan:approve", id);
      if (!found.ok) return found;
      const comment = input.comment?.trim() ?? "";
      if (comment.length > MAX_COMMENT_LENGTH) {
        return err({
          kind: "Invalid",
          field: "comment",
          reason: "must be at most 4000 characters",
        });
      }
      const actor = { kind: "human", id: principal.userId } as const;
      const { state } = found.value;
      const resuming =
        state.status === "APPROVED" && state.approvedPlanVersion === input.planVersion;
      if (!resuming) {
        const approved = await applyTo(missions, found.value, {
          command: { type: "ApprovePlan", planVersion: input.planVersion },
          actor,
          now: now(),
          decision: {
            planVersion: input.planVersion,
            decision: "approved",
            decidedBy: principal.userId,
            comment: comment === "" ? null : comment,
          },
        });
        if (!approved.ok) return err(commandError(approved.error));
      }
      const started = await startExecution(missions, {
        tenantId: principal.tenantId,
        missionId: id,
        planVersion: input.planVersion,
        actor,
        now: now(),
      });
      return started.ok ? started : err(commandError(started.error));
    },

    /** Rejects plan `planVersion`; an agent then writes the next version, addressing `reason`. */
    async rejectPlan(
      principal: Principal,
      id: MissionId,
      input: { readonly planVersion: number; readonly reason: string },
    ): Promise<Result<Mission, AppError>> {
      const found = await authorized(principal, "plan:approve", id);
      if (!found.ok) return found;
      const reason = input.reason.trim();
      if (reason.length === 0 || reason.length > MAX_COMMENT_LENGTH) {
        return err({ kind: "Invalid", field: "reason", reason: "must be 1-4000 characters" });
      }
      const rejected = await applyTo(missions, found.value, {
        command: { type: "RejectPlan", planVersion: input.planVersion, reason },
        actor: { kind: "human", id: principal.userId },
        now: now(),
        decision: {
          planVersion: input.planVersion,
          decision: "rejected",
          decidedBy: principal.userId,
          comment: reason,
        },
        enqueue: planningJob,
      });
      return rejected.ok ? rejected : err(commandError(rejected.error));
    },

    /** The mission's audit trail, oldest first; pass the last seq seen as `afterSeq` to page. */
    async listEvents(
      principal: Principal,
      id: MissionId,
      page: { readonly afterSeq?: number; readonly limit?: number },
    ): Promise<Result<readonly MissionEvent[], AppError>> {
      const found = await authorized(principal, "mission:read", id);
      if (!found.ok) return found;
      const limit = page.limit ?? DEFAULT_EVENT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
        return err({ kind: "Invalid", field: "limit", reason: "must be an integer 1-500" });
      }
      const afterSeq = page.afterSeq ?? 0;
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        return err({ kind: "Invalid", field: "after", reason: "must be a non-negative integer" });
      }
      return ok(await missions.listEvents(principal.tenantId, id, { afterSeq, limit }));
    },

    /**
     * Cancels the mission. Work in progress (PLANNING, EXECUTING, VERIFYING) is asked to stop
     * (CANCEL_REQUESTED) and its job confirms it; other states are cancelled at once.
     */
    async cancel(principal: Principal, id: MissionId): Promise<Result<Mission, AppError>> {
      const found = await authorized(principal, "mission:cancel", id);
      if (!found.ok) return found;
      const cancelled = await applyTo(missions, found.value, {
        command: { type: "Cancel" },
        actor: { kind: "human", id: principal.userId },
        now: now(),
      });
      return cancelled.ok ? cancelled : err(commandError(cancelled.error));
    },

    /** The given acceptance packet version, or the latest when `version` is omitted. */
    async getAcceptancePacket(
      principal: Principal,
      id: MissionId,
      version?: number,
    ): Promise<Result<StoredAcceptancePacket, AppError>> {
      const found = await authorized(principal, "mission:read", id);
      if (!found.ok) return found;
      const packet = await missions.findAcceptancePacket(principal.tenantId, id, version);
      return packet ? ok(packet) : err({ kind: "NotFound", resource: "acceptance packet" });
    },

    /** The given plan version of the mission, or its latest when `version` is omitted. */
    async getPlan(
      principal: Principal,
      id: MissionId,
      version?: number,
    ): Promise<Result<StoredPlan, AppError>> {
      const found = await authorized(principal, "mission:read", id);
      if (!found.ok) return found;
      const plan = await missions.findPlan(principal.tenantId, id, version);
      return plan ? ok(plan) : err({ kind: "NotFound", resource: "plan" });
    },

    async list(
      principal: Principal,
      filter: { readonly workspaceId?: WorkspaceId; readonly limit?: number },
    ): Promise<Result<readonly Mission[], AppError>> {
      if (!can(principal.role, "mission:read")) return forbidden("mission:read");
      const limit = filter.limit ?? DEFAULT_LIST_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        return err({ kind: "Invalid", field: "limit", reason: "must be an integer 1-100" });
      }
      const query =
        filter.workspaceId === undefined ? { limit } : { limit, workspaceId: filter.workspaceId };
      return ok(await missions.list(principal.tenantId, query));
    },
  };
}

export type MissionService = ReturnType<typeof missionService>;
