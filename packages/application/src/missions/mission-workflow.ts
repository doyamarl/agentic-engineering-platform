import {
  err,
  ok,
  transition,
  type Actor,
  type Mission,
  type MissionCommand,
  type AcceptancePacket,
  type MissionId,
  type Plan,
  type Result,
  type TenantId,
  type TransitionError,
} from "@aep/domain";
import type { NewJob } from "../jobs/job-queue.ts";
import type { MissionEventInput, MissionRepository, PlanDecisionInput } from "../ports.ts";

// Applies mission commands: the domain decides the next state, the repository writes it together
// with an event (and, for commands that start work, the job that does it). Callers authorize
// before calling; background jobs pass a system actor.

export const PLAN_MISSION_JOB = "mission.plan";
export const EXECUTE_MISSION_JOB = "mission.execute";
export const VERIFY_MISSION_JOB = "mission.verify";

export type CommandError =
  { readonly kind: "NotFound" } | { readonly kind: "Conflict" } | TransitionError;

export type CommandInput = {
  readonly tenantId: TenantId;
  readonly missionId: MissionId;
  readonly command: MissionCommand;
  readonly actor: Actor & { readonly id?: string };
  readonly now: Date;
  /** Extra event payload, e.g. the pull request a completed execution opened. */
  readonly payload?: MissionEventInput["payload"];
  readonly enqueue?: (mission: Mission) => NewJob;
  /** A new plan version to store with the change (SubmitPlan). */
  readonly plan?: Plan;
  /** A person's decision to record with the change (ApprovePlan, RejectPlan). */
  readonly decision?: PlanDecisionInput;
  /** A new acceptance packet version to store with the change (PassVerification). */
  readonly packet?: AcceptancePacket;
};

/** Applies `command` to the mission's current state, retrying nothing: Conflict is returned. */
export async function applyCommand(
  missions: MissionRepository,
  input: CommandInput,
): Promise<Result<Mission, CommandError>> {
  const mission = await missions.findById(input.tenantId, input.missionId);
  if (mission === undefined) return err({ kind: "NotFound" });
  return applyTo(missions, mission, input);
}

/** Like applyCommand, for a mission the caller has just read. */
export async function applyTo(
  missions: MissionRepository,
  mission: Mission,
  input: Omit<CommandInput, "tenantId" | "missionId">,
): Promise<Result<Mission, CommandError>> {
  const next = transition(mission.state, input.command, input.actor);
  if (!next.ok) return next;
  const { type, ...fields } = input.command;
  const recorded = await missions.recordTransition({
    mission,
    state: next.value,
    event: {
      type,
      payload: { ...(fields as MissionEventInput["payload"]), ...input.payload },
      actor: input.actor,
    },
    at: input.now,
    ...(input.enqueue === undefined ? {} : { enqueue: input.enqueue(mission) }),
    ...(input.plan === undefined ? {} : { plan: input.plan }),
    ...(input.decision === undefined ? {} : { decision: input.decision }),
    ...(input.packet === undefined ? {} : { packet: input.packet }),
  });
  return recorded.ok ? ok(recorded.value) : recorded;
}

/**
 * APPROVED → EXECUTING, enqueueing the execution job in the same transaction. The job's
 * idempotency key is the approved plan version, so approving the same plan twice runs it once.
 */
export function startExecution(
  missions: MissionRepository,
  input: {
    readonly tenantId: TenantId;
    readonly missionId: MissionId;
    readonly planVersion: number;
    readonly actor: Actor & { readonly id?: string };
    readonly now: Date;
  },
): Promise<Result<Mission, CommandError>> {
  return applyCommand(missions, {
    tenantId: input.tenantId,
    missionId: input.missionId,
    command: { type: "StartExecution", planVersion: input.planVersion },
    actor: input.actor,
    now: input.now,
    enqueue: (mission) => ({
      tenantId: mission.tenantId,
      kind: EXECUTE_MISSION_JOB,
      idempotencyKey: `${mission.id}:plan-${String(input.planVersion)}`,
      payload: { missionId: mission.id },
      // Each attempt runs the agent again, which costs money; a second attempt covers a crash.
      maxAttempts: 2,
    }),
  });
}

/**
 * DRAFT → PLANNING, enqueueing the planning job in the same transaction. The job's idempotency key
 * names the mission version it started from, so a repeated request plans once.
 */
export function startPlanning(
  missions: MissionRepository,
  input: {
    readonly tenantId: TenantId;
    readonly missionId: MissionId;
    readonly actor: Actor & { readonly id?: string };
    readonly now: Date;
  },
): Promise<Result<Mission, CommandError>> {
  return applyCommand(missions, {
    tenantId: input.tenantId,
    missionId: input.missionId,
    command: { type: "StartPlanning" },
    actor: input.actor,
    now: input.now,
    enqueue: planningJob,
  });
}

/**
 * The mission.plan job for a change that moves `mission` (as read) to PLANNING. The key names the
 * version it started from, so a repeated request plans once but each rejection plans again.
 */
export const planningJob = (mission: Mission): NewJob => ({
  tenantId: mission.tenantId,
  kind: PLAN_MISSION_JOB,
  idempotencyKey: `${mission.id}:plan-from-v${String(mission.version)}`,
  payload: { missionId: mission.id },
  // As for execution: each attempt pays for an agent session.
  maxAttempts: 2,
});

/**
 * One poll of the mission.verify job for a mission that entered VERIFYING from `fromVersion`.
 * Polls are separate jobs, each due after the previous one decided to wait.
 */
export function verificationJob(
  mission: Pick<Mission, "tenantId" | "id">,
  poll: {
    readonly fromVersion: number;
    readonly number: number;
    readonly startedAt: Date;
    readonly runAfter?: Date;
  },
): NewJob {
  return {
    tenantId: mission.tenantId,
    kind: VERIFY_MISSION_JOB,
    idempotencyKey: `${mission.id}:verify-from-v${String(poll.fromVersion)}-${String(poll.number)}`,
    payload: {
      missionId: mission.id,
      fromVersion: poll.fromVersion,
      poll: poll.number,
      startedAt: poll.startedAt.toISOString(),
    },
    ...(poll.runAfter === undefined ? {} : { runAfter: poll.runAfter }),
  };
}
