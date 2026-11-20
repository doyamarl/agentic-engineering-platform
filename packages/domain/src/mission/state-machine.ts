import { err, ok, type Result } from "../result.ts";

// Mission lifecycle from docs/02_ARCHITECTURE_ADR.md §6. Pure: no I/O, no clock, no ids.
// Who may issue a command (RBAC) is decided by the policy layer before calling transition().

export type Actor = { readonly kind: "human" | "agent" | "system" };

/** States in which the mission moves forward along the golden path. */
export type ProgressState =
  | { readonly status: "DRAFT" }
  | { readonly status: "PLANNING" }
  | { readonly status: "AWAITING_PLAN_APPROVAL"; readonly planVersion: number }
  | { readonly status: "APPROVED"; readonly approvedPlanVersion: number }
  | { readonly status: "EXECUTING"; readonly approvedPlanVersion: number }
  | { readonly status: "VERIFYING"; readonly approvedPlanVersion: number }
  | {
      readonly status: "ACCEPTANCE_READY";
      readonly approvedPlanVersion: number;
      readonly packetVersion: number;
    }
  | {
      readonly status: "AWAITING_RELEASE_APPROVAL";
      readonly approvedPlanVersion: number;
      readonly packetVersion: number;
    };

export type MissionState =
  | ProgressState
  | {
      readonly status: "COMPLETED";
      readonly approvedPlanVersion: number;
      readonly packetVersion: number;
    }
  | { readonly status: "FAILED"; readonly from: ProgressState; readonly reason: string }
  | { readonly status: "BLOCKED"; readonly from: ProgressState; readonly reason: string }
  | { readonly status: "CANCEL_REQUESTED"; readonly from: ProgressState }
  | { readonly status: "CANCELLED" };

export type MissionStatus = MissionState["status"];

export type MissionCommand =
  | { readonly type: "StartPlanning" }
  | { readonly type: "SubmitPlan"; readonly planVersion: number }
  | { readonly type: "ApprovePlan"; readonly planVersion: number }
  | { readonly type: "RejectPlan"; readonly planVersion: number; readonly reason: string }
  | { readonly type: "StartExecution"; readonly planVersion: number }
  | { readonly type: "CompleteExecution" }
  | { readonly type: "PassVerification"; readonly packetVersion: number }
  | { readonly type: "RequestReleaseApproval" }
  | { readonly type: "ApproveRelease"; readonly packetVersion: number }
  | { readonly type: "Fail"; readonly reason: string }
  | { readonly type: "Block"; readonly reason: string }
  | { readonly type: "Unblock" }
  | { readonly type: "Retry" }
  | { readonly type: "Cancel" }
  | { readonly type: "ConfirmCancelled" };

export type TransitionError =
  | {
      readonly kind: "InvalidTransition";
      readonly from: MissionStatus;
      readonly command: MissionCommand["type"];
    }
  | {
      readonly kind: "VersionMismatch";
      readonly subject: "plan" | "acceptancePacket";
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly kind: "HumanActorRequired";
      readonly command: "ApprovePlan" | "RejectPlan" | "ApproveRelease";
    };

type Transition = Result<MissionState, TransitionError>;

export const initialMissionState = (): MissionState => ({ status: "DRAFT" });

export const isTerminal = (state: MissionState): boolean =>
  state.status === "COMPLETED" || state.status === "CANCELLED";

/** Progress states in which an agent or worker may be acting; cancelling them needs confirmation. */
const isRunningWork = (state: ProgressState): boolean =>
  state.status === "PLANNING" || state.status === "EXECUTING" || state.status === "VERIFYING";

const isProgress = (state: MissionState): state is ProgressState => {
  switch (state.status) {
    case "DRAFT":
    case "PLANNING":
    case "AWAITING_PLAN_APPROVAL":
    case "APPROVED":
    case "EXECUTING":
    case "VERIFYING":
    case "ACCEPTANCE_READY":
    case "AWAITING_RELEASE_APPROVAL":
      return true;
    case "COMPLETED":
    case "FAILED":
    case "BLOCKED":
    case "CANCEL_REQUESTED":
    case "CANCELLED":
      return false;
  }
};

const invalid = (state: MissionState, command: MissionCommand): Transition =>
  err({ kind: "InvalidTransition", from: state.status, command: command.type });

const versionMismatch = (
  subject: "plan" | "acceptancePacket",
  expected: number,
  actual: number,
): Transition => err({ kind: "VersionMismatch", subject, expected, actual });

export function transition(state: MissionState, command: MissionCommand, actor: Actor): Transition {
  switch (command.type) {
    case "StartPlanning":
      return state.status === "DRAFT" ? ok({ status: "PLANNING" }) : invalid(state, command);

    case "SubmitPlan":
      return state.status === "PLANNING"
        ? ok({ status: "AWAITING_PLAN_APPROVAL", planVersion: command.planVersion })
        : invalid(state, command);

    case "ApprovePlan":
      if (state.status !== "AWAITING_PLAN_APPROVAL") return invalid(state, command);
      if (actor.kind !== "human") return err({ kind: "HumanActorRequired", command: command.type });
      if (command.planVersion !== state.planVersion) {
        return versionMismatch("plan", state.planVersion, command.planVersion);
      }
      return ok({ status: "APPROVED", approvedPlanVersion: state.planVersion });

    case "RejectPlan":
      if (state.status !== "AWAITING_PLAN_APPROVAL") return invalid(state, command);
      if (actor.kind !== "human") return err({ kind: "HumanActorRequired", command: command.type });
      if (command.planVersion !== state.planVersion) {
        return versionMismatch("plan", state.planVersion, command.planVersion);
      }
      return ok({ status: "PLANNING" });

    case "StartExecution":
      if (state.status !== "APPROVED") return invalid(state, command);
      if (command.planVersion !== state.approvedPlanVersion) {
        return versionMismatch("plan", state.approvedPlanVersion, command.planVersion);
      }
      return ok({ status: "EXECUTING", approvedPlanVersion: state.approvedPlanVersion });

    case "CompleteExecution":
      return state.status === "EXECUTING"
        ? ok({ status: "VERIFYING", approvedPlanVersion: state.approvedPlanVersion })
        : invalid(state, command);

    case "PassVerification":
      return state.status === "VERIFYING"
        ? ok({
            status: "ACCEPTANCE_READY",
            approvedPlanVersion: state.approvedPlanVersion,
            packetVersion: command.packetVersion,
          })
        : invalid(state, command);

    case "RequestReleaseApproval":
      return state.status === "ACCEPTANCE_READY"
        ? ok({ ...state, status: "AWAITING_RELEASE_APPROVAL" })
        : invalid(state, command);

    case "ApproveRelease":
      if (state.status !== "AWAITING_RELEASE_APPROVAL") return invalid(state, command);
      if (actor.kind !== "human") return err({ kind: "HumanActorRequired", command: command.type });
      if (command.packetVersion !== state.packetVersion) {
        return versionMismatch("acceptancePacket", state.packetVersion, command.packetVersion);
      }
      return ok({ ...state, status: "COMPLETED" });

    case "Fail":
      return isProgress(state)
        ? ok({ status: "FAILED", from: state, reason: command.reason })
        : invalid(state, command);

    case "Block":
      return isProgress(state)
        ? ok({ status: "BLOCKED", from: state, reason: command.reason })
        : invalid(state, command);

    case "Unblock":
      return state.status === "BLOCKED" ? ok(state.from) : invalid(state, command);

    case "Retry":
      return state.status === "FAILED" ? ok(state.from) : invalid(state, command);

    case "Cancel":
      if (isProgress(state)) {
        return isRunningWork(state)
          ? ok({ status: "CANCEL_REQUESTED", from: state })
          : ok({ status: "CANCELLED" });
      }
      return state.status === "FAILED" || state.status === "BLOCKED"
        ? ok({ status: "CANCELLED" })
        : invalid(state, command);

    case "ConfirmCancelled":
      return state.status === "CANCEL_REQUESTED"
        ? ok({ status: "CANCELLED" })
        : invalid(state, command);
  }
}
