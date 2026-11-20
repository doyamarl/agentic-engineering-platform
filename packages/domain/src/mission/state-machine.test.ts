import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  initialMissionState,
  isTerminal,
  transition,
  type Actor,
  type MissionCommand,
  type MissionState,
} from "./state-machine.ts";

const human: Actor = { kind: "human" };
const agent: Actor = { kind: "agent" };
const system: Actor = { kind: "system" };

function run(steps: readonly (readonly [MissionCommand, Actor])[]): MissionState {
  let state = initialMissionState();
  for (const [command, actor] of steps) {
    const result = transition(state, command, actor);
    if (!result.ok) {
      throw new Error(`${command.type} rejected in ${state.status}: ${result.error.kind}`);
    }
    state = result.value;
  }
  return state;
}

const toApproved = [
  [{ type: "StartPlanning" }, system],
  [{ type: "SubmitPlan", planVersion: 2 }, agent],
  [{ type: "ApprovePlan", planVersion: 2 }, human],
] as const;

const toExecuting = [...toApproved, [{ type: "StartExecution", planVersion: 2 }, system]] as const;

const toAcceptanceReady = [
  ...toExecuting,
  [{ type: "CompleteExecution" }, agent],
  [{ type: "PassVerification", packetVersion: 1 }, system],
] as const;

describe("mission golden path (ADR §6)", () => {
  it("reaches COMPLETED through plan approval, execution, verification and release approval", () => {
    const state = run([
      ...toAcceptanceReady,
      [{ type: "RequestReleaseApproval" }, system],
      [{ type: "ApproveRelease", packetVersion: 1 }, human],
    ]);
    expect(state).toEqual({ status: "COMPLETED", approvedPlanVersion: 2, packetVersion: 1 });
  });
});

describe("version-bound approval (FR-07, PRD §8-B)", () => {
  it("rejects approving a plan version other than the one submitted", () => {
    const state = run(toApproved.slice(0, 2));
    expect(transition(state, { type: "ApprovePlan", planVersion: 3 }, human)).toEqual({
      ok: false,
      error: { kind: "VersionMismatch", subject: "plan", expected: 2, actual: 3 },
    });
  });

  it("does not let a plan approved at version 2 authorize version 3 execution", () => {
    const state = run(toApproved);
    expect(transition(state, { type: "StartExecution", planVersion: 3 }, system)).toEqual({
      ok: false,
      error: { kind: "VersionMismatch", subject: "plan", expected: 2, actual: 3 },
    });
  });

  it("rejects release approval for an acceptance packet version that was not presented", () => {
    const state = run([...toAcceptanceReady, [{ type: "RequestReleaseApproval" }, system]]);
    expect(transition(state, { type: "ApproveRelease", packetVersion: 2 }, human)).toEqual({
      ok: false,
      error: { kind: "VersionMismatch", subject: "acceptancePacket", expected: 1, actual: 2 },
    });
  });

  it("returns a rejected plan to PLANNING so a new version must be submitted and approved", () => {
    const state = run([
      ...toApproved.slice(0, 2),
      [{ type: "RejectPlan", planVersion: 2, reason: "missing metric" }, human],
    ]);
    expect(state).toEqual({ status: "PLANNING" });
  });

  it("rejects rejecting a plan version other than the one submitted", () => {
    const state = run(toApproved.slice(0, 2));
    expect(transition(state, { type: "RejectPlan", planVersion: 1, reason: "r" }, human)).toEqual({
      ok: false,
      error: { kind: "VersionMismatch", subject: "plan", expected: 2, actual: 1 },
    });
  });
});

describe("approvals require a human actor (FR-09)", () => {
  it.each([agent, system])("rejects plan approval by %j", (actor) => {
    const state = run(toApproved.slice(0, 2));
    expect(transition(state, { type: "ApprovePlan", planVersion: 2 }, actor)).toEqual({
      ok: false,
      error: { kind: "HumanActorRequired", command: "ApprovePlan" },
    });
  });

  it.each([agent, system])("rejects plan rejection by %j", (actor) => {
    const state = run(toApproved.slice(0, 2));
    expect(transition(state, { type: "RejectPlan", planVersion: 2, reason: "r" }, actor)).toEqual({
      ok: false,
      error: { kind: "HumanActorRequired", command: "RejectPlan" },
    });
  });

  it.each([agent, system])("rejects release approval by %j", (actor) => {
    const state = run([...toAcceptanceReady, [{ type: "RequestReleaseApproval" }, system]]);
    expect(transition(state, { type: "ApproveRelease", packetVersion: 1 }, actor)).toEqual({
      ok: false,
      error: { kind: "HumanActorRequired", command: "ApproveRelease" },
    });
  });
});

describe("cancellation (FR-08)", () => {
  it("routes cancel through CANCEL_REQUESTED while work is running", () => {
    const requested = run([...toExecuting, [{ type: "Cancel" }, human]]);
    expect(requested.status).toBe("CANCEL_REQUESTED");
    expect(transition(requested, { type: "CompleteExecution" }, agent).ok).toBe(false);

    const cancelled = transition(requested, { type: "ConfirmCancelled" }, system);
    expect(cancelled).toEqual({ ok: true, value: { status: "CANCELLED" } });
  });

  it("cancels immediately when no work is running", () => {
    const state = run([...toApproved, [{ type: "Cancel" }, human]]);
    expect(state).toEqual({ status: "CANCELLED" });
  });
});

describe("failure, retry and blocking", () => {
  it("retries a failed mission from the state it failed in, keeping the approved version", () => {
    const state = run([
      ...toExecuting,
      [{ type: "Fail", reason: "sandbox timeout" }, system],
      [{ type: "Retry" }, human],
    ]);
    expect(state).toEqual({ status: "EXECUTING", approvedPlanVersion: 2 });
  });

  it("unblocks back to the state that was blocked", () => {
    const state = run([
      ...toApproved,
      [{ type: "Block", reason: "missing repo access" }, system],
      [{ type: "Unblock" }, human],
    ]);
    expect(state).toEqual({ status: "APPROVED", approvedPlanVersion: 2 });
  });
});

// ---------------------------------------------------------------------------
// Property tests: arbitrary command sequences from arbitrary actors.
// Golden-path commands are weighted up and versions kept to {1, 2}; with uniform weights most
// sequences hit an early Cancel and never reach APPROVED, so approval properties go untested.

const actorArb = fc.constantFrom<Actor>(human, agent, system);
const versionArb = fc.integer({ min: 1, max: 2 });
const weighted = (weight: number, arbitrary: fc.Arbitrary<MissionCommand>) => ({
  weight,
  arbitrary,
});
const commandArb: fc.Arbitrary<MissionCommand> = fc.oneof(
  weighted(6, fc.constant({ type: "StartPlanning" })),
  weighted(
    6,
    versionArb.map((planVersion) => ({ type: "SubmitPlan", planVersion })),
  ),
  weighted(
    6,
    versionArb.map((planVersion) => ({ type: "ApprovePlan", planVersion })),
  ),
  weighted(
    2,
    versionArb.map((planVersion) => ({ type: "RejectPlan", planVersion, reason: "r" })),
  ),
  weighted(
    6,
    versionArb.map((planVersion) => ({ type: "StartExecution", planVersion })),
  ),
  weighted(6, fc.constant({ type: "CompleteExecution" })),
  weighted(
    6,
    versionArb.map((packetVersion) => ({ type: "PassVerification", packetVersion })),
  ),
  weighted(6, fc.constant({ type: "RequestReleaseApproval" })),
  weighted(
    6,
    versionArb.map((packetVersion) => ({ type: "ApproveRelease", packetVersion })),
  ),
  weighted(1, fc.constant({ type: "Fail", reason: "f" })),
  weighted(1, fc.constant({ type: "Block", reason: "b" })),
  weighted(2, fc.constant({ type: "Unblock" })),
  weighted(2, fc.constant({ type: "Retry" })),
  weighted(1, fc.constant({ type: "Cancel" })),
  weighted(2, fc.constant({ type: "ConfirmCancelled" })),
);
const stepsArb = fc.array(fc.tuple(commandArb, actorArb), { maxLength: 60 });

type Trace = {
  state: MissionState;
  humanApprovedPlans: Set<number>;
  humanApprovedPackets: Set<number>;
};

/** Applies every step, skipping rejected ones, and records which versions a human approved. */
function explore(steps: readonly (readonly [MissionCommand, Actor])[]): Trace[] {
  let state = initialMissionState();
  const humanApprovedPlans = new Set<number>();
  const humanApprovedPackets = new Set<number>();
  const trace: Trace[] = [];
  for (const [command, actor] of steps) {
    const result = transition(state, command, actor);
    if (!result.ok) continue;
    if (command.type === "ApprovePlan" && actor.kind === "human") {
      humanApprovedPlans.add(command.planVersion);
    }
    if (command.type === "ApproveRelease" && actor.kind === "human") {
      humanApprovedPackets.add(command.packetVersion);
    }
    state = result.value;
    trace.push({
      state,
      humanApprovedPlans: new Set(humanApprovedPlans),
      humanApprovedPackets: new Set(humanApprovedPackets),
    });
  }
  return trace;
}

function approvedPlanVersionOf(state: MissionState): number | undefined {
  if ("approvedPlanVersion" in state) return state.approvedPlanVersion;
  if ("from" in state) return approvedPlanVersionOf(state.from);
  return undefined;
}

describe("state machine properties", () => {
  it("never leaves a terminal state", () => {
    fc.assert(
      fc.property(stepsArb, commandArb, actorArb, (steps, command, actor) => {
        const last = explore(steps).at(-1)?.state;
        fc.pre(last !== undefined && isTerminal(last));
        expect(transition(last, command, actor).ok).toBe(false);
      }),
    );
  });

  it("only carries a plan version that a human approved", () => {
    fc.assert(
      fc.property(stepsArb, (steps) => {
        for (const { state, humanApprovedPlans } of explore(steps)) {
          const version = approvedPlanVersionOf(state);
          if (version !== undefined) expect(humanApprovedPlans.has(version)).toBe(true);
        }
      }),
    );
  });

  it("completes only after a human approved the exact acceptance packet version", () => {
    fc.assert(
      fc.property(stepsArb, (steps) => {
        for (const { state, humanApprovedPackets } of explore(steps)) {
          if (state.status === "COMPLETED") {
            expect(humanApprovedPackets.has(state.packetVersion)).toBe(true);
          }
        }
      }),
    );
  });

  it.each([
    ["AWAITING_PLAN_APPROVAL", toApproved.slice(0, 2), "APPROVED"],
    [
      "AWAITING_RELEASE_APPROVAL",
      [...toAcceptanceReady, [{ type: "RequestReleaseApproval" }, system]],
      "COMPLETED",
    ],
  ] as const)("cannot leave %s for an approved state without a human", (_, prefix, approved) => {
    const nonHuman = fc.constantFrom<Actor>(agent, system);
    fc.assert(
      fc.property(fc.array(fc.tuple(commandArb, nonHuman), { maxLength: 20 }), (steps) => {
        let state = run(prefix);
        for (const [command, actor] of steps) {
          const result = transition(state, command, actor);
          if (result.ok) state = result.value;
          expect(state.status).not.toBe(approved);
        }
      }),
    );
  });

  it("never reaches APPROVED or COMPLETED when no human acts", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(commandArb, fc.constantFrom<Actor>(agent, system)), { maxLength: 60 }),
        (steps) => {
          const reached = explore(steps).map(({ state }) => state.status);
          expect(reached).not.toContain("APPROVED");
          expect(reached).not.toContain("COMPLETED");
        },
      ),
    );
  });
});
