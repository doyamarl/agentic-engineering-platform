import type { Mission, MissionId, MissionState, TenantId, UserId, WorkspaceId } from "@aep/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { Job } from "../jobs/job-queue.ts";
import { failMissionOfDeadJob } from "./fail-dead-mission-job.ts";
import { InMemoryMissions } from "./in-memory-missions.ts";

const TENANT = "0a000000-0000-4000-8000-000000000001" as TenantId;
const OTHER_TENANT = "0b000000-0000-4000-8000-000000000001" as TenantId;
const WORKSPACE = "0a000000-0000-4000-8000-0000000000a1" as WorkspaceId;
const MISSION = "0a000000-0000-4000-8000-00000000a001" as MissionId;
const NOW = new Date("2026-11-14T00:00:00Z");

let missions: InMemoryMissions;

beforeEach(() => {
  missions = new InMemoryMissions(new Map([[TENANT, [WORKSPACE]]]));
});

function seed(state: MissionState) {
  const mission: Mission = {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    id: MISSION,
    title: "Greeting",
    state,
    version: 3,
    createdBy: "0a000000-0000-4000-8000-0000000000aa" as UserId,
    createdAt: NOW,
  };
  missions.rows.push(mission);
}

const job = (overrides: Partial<Job> = {}): Job => ({
  id: "job-1",
  tenantId: TENANT,
  kind: "mission.execute",
  idempotencyKey: `${MISSION}:plan-1`,
  payload: { missionId: MISSION },
  attempt: 2,
  maxAttempts: 2,
  lastError: null,
  ...overrides,
});

const onDead = (deadJob: Job, error: string) =>
  failMissionOfDeadJob({ missions, activeStatus: "EXECUTING", now: () => NOW })(deadJob, error);
const state = () => missions.rows[0]?.state;

describe("failMissionOfDeadJob", () => {
  it("fails the mission the dead job was working for, with the job's error", async () => {
    seed({ status: "EXECUTING", approvedPlanVersion: 1 });
    await onDead(job(), "Error: GitHub is down");
    expect(state()).toEqual({
      status: "FAILED",
      from: { status: "EXECUTING", approvedPlanVersion: 1 },
      reason: "mission.execute gave up after 2 attempts: Error: GitHub is down",
    });
    expect(missions.events).toEqual([
      {
        missionId: MISSION,
        type: "Fail",
        payload: { reason: "mission.execute gave up after 2 attempts: Error: GitHub is down" },
        actor: { kind: "system" },
      },
    ]);
  });

  it("bounds the reason it records", async () => {
    seed({ status: "EXECUTING", approvedPlanVersion: 1 });
    await onDead(job(), "x".repeat(5000));
    const failed = state();
    expect(failed?.status === "FAILED" && failed.reason.length).toBe(500);
  });

  it("confirms a cancellation that was waiting for the job", async () => {
    seed({ status: "CANCEL_REQUESTED", from: { status: "EXECUTING", approvedPlanVersion: 1 } });
    await onDead(job(), "boom");
    expect(state()).toEqual({ status: "CANCELLED" });
  });

  it("leaves a mission that has already moved on alone", async () => {
    seed({ status: "VERIFYING", approvedPlanVersion: 1 });
    await onDead(job(), "boom");
    expect(state()).toEqual({ status: "VERIFYING", approvedPlanVersion: 1 });
    expect(missions.events).toEqual([]);
  });

  it("does nothing for a missing mission or another tenant's id", async () => {
    seed({ status: "EXECUTING", approvedPlanVersion: 1 });
    await onDead(job({ tenantId: OTHER_TENANT }), "boom");
    await onDead(job({ payload: { missionId: "0a000000-0000-4000-8000-00000000ffff" } }), "boom");
    await onDead(job({ payload: {} }), "boom");
    expect(state()).toEqual({ status: "EXECUTING", approvedPlanVersion: 1 });
  });

  it("reads the mission again after a concurrent change", async () => {
    seed({ status: "EXECUTING", approvedPlanVersion: 1 });
    const racing = new InMemoryMissions(new Map([[TENANT, [WORKSPACE]]]));
    racing.rows.push(...missions.rows);
    let first = true;
    const original = racing.findById.bind(racing);
    racing.findById = async (tenantId, id) => {
      const read = await original(tenantId, id);
      if (first && read !== undefined) {
        first = false;
        // Someone requests cancellation between our read and our write.
        racing.rows[0] = {
          ...read,
          state: {
            status: "CANCEL_REQUESTED",
            from: { status: "EXECUTING", approvedPlanVersion: 1 },
          },
          version: read.version + 1,
        };
      }
      return read;
    };
    await failMissionOfDeadJob({
      missions: racing,
      activeStatus: "EXECUTING",
      now: () => NOW,
    })(job(), "boom");
    expect(racing.rows[0]?.state).toEqual({ status: "CANCELLED" });
  });
});
