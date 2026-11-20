import type { Mission, MissionCommand, MissionId, MissionStatus } from "@aep/domain";
import type { DeadJobHandler } from "../jobs/run-worker.ts";
import type { MissionRepository } from "../ports.ts";
import { applyTo } from "./mission-workflow.ts";

// onDead hook for mission jobs: when a job gives up (attempts exhausted, or its worker died on
// the last one), the mission it was working for must not stay in its working state forever.

const SYSTEM = { kind: "system" } as const;
const MAX_REASON = 500;
const MAX_CONFLICTS = 3;

/**
 * Fails the job's mission if it is still in `activeStatus`, or confirms a cancellation that was
 * waiting for the job. A mission that has moved on (an earlier attempt finished it) is left alone.
 */
export function failMissionOfDeadJob(deps: {
  readonly missions: MissionRepository;
  /** The state the job's work runs in, e.g. EXECUTING for mission.execute. */
  readonly activeStatus: MissionStatus;
  readonly now: () => Date;
}): DeadJobHandler {
  const commandFor = (mission: Mission, reason: string): MissionCommand | undefined => {
    if (mission.state.status === "CANCEL_REQUESTED") return { type: "ConfirmCancelled" };
    if (mission.state.status === deps.activeStatus) return { type: "Fail", reason };
    return undefined;
  };

  return async (job, error) => {
    const missionId = job.payload["missionId"];
    if (typeof missionId !== "string") return;
    const reason =
      `${job.kind} gave up after ${String(Math.min(job.attempt, job.maxAttempts))} attempts: ${error}`.slice(
        0,
        MAX_REASON,
      );
    for (let tries = 0; tries < MAX_CONFLICTS; tries++) {
      const mission = await deps.missions.findById(job.tenantId, missionId as MissionId);
      if (mission === undefined) return;
      const command = commandFor(mission, reason);
      if (command === undefined) return;
      const result = await applyTo(deps.missions, mission, {
        command,
        actor: SYSTEM,
        now: deps.now(),
      });
      if (result.ok) return;
      if (result.error.kind !== "Conflict") {
        throw new Error(`mission ${mission.id}: ${command.type} refused (${result.error.kind})`);
      }
    }
    throw new Error(`mission ${missionId}: kept changing while failing it`);
  };
}
