import type {
  AcceptancePacket,
  Actor,
  Mission,
  MissionId,
  MissionState,
  Plan,
  Result,
  TenantId,
  UserId,
  WorkspaceId,
} from "@aep/domain";
import type { NewJob } from "./jobs/job-queue.ts";
import type { Principal } from "./principal.ts";

export interface IdentityPort {
  /** Resolves a bearer credential to a principal, or undefined if it is unknown, expired or revoked. */
  authenticate(credential: string): Promise<Principal | undefined>;
}

/** An appended mission_events row. Payloads hold identifiers, numbers and URLs, not content. */
export type MissionEventInput = {
  readonly type: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly actor: Actor & { readonly id?: string };
};

/** A state change of `mission`, written atomically with its event and, optionally, a job. */
export type MissionChange = {
  /** The mission as read; the write fails with Conflict if its version has moved on. */
  readonly mission: Mission;
  readonly state: MissionState;
  readonly event: MissionEventInput;
  readonly at: Date;
  /** Outbox: enqueued in the same transaction, so it exists only if the change committed. */
  readonly enqueue?: NewJob;
  /** A new plan version, stored in the same transaction (e.g. with SubmitPlan). */
  readonly plan?: Plan;
  /** A person's decision on a plan version, recorded (append-only) with ApprovePlan/RejectPlan. */
  readonly decision?: PlanDecisionInput;
  /** A new acceptance packet version, stored with PassVerification. */
  readonly packet?: AcceptancePacket;
};

/** A packet as stored: immutable, with the SHA-256 of its content's JSON text. */
export type StoredAcceptancePacket = AcceptancePacket & { readonly checksumSha256: string };

export type PlanDecisionInput = {
  readonly planVersion: number;
  readonly decision: "approved" | "rejected";
  readonly decidedBy: UserId;
  /** For a rejection, what the next plan version must address. */
  readonly comment: string | null;
};

export type PlanDecision = PlanDecisionInput & { readonly decidedAt: Date };

/** A recorded mission_events row: the mission's audit trail. */
export type MissionEvent = MissionEventInput & {
  /** 1, 2, ... per mission, in the order the changes committed. */
  readonly seq: number;
  readonly occurredAt: Date;
};

/** A plan as stored: immutable, with the SHA-256 of its body (lowercase hex). */
export type StoredPlan = Plan & { readonly checksumSha256: string };

/** Every method takes tenantId explicitly; implementations must scope all reads and writes to it. */
export interface MissionRepository {
  insert(mission: Mission): Promise<Result<void, { readonly kind: "WorkspaceNotFound" }>>;
  findById(tenantId: TenantId, id: MissionId): Promise<Mission | undefined>;
  list(
    tenantId: TenantId,
    filter: { readonly workspaceId?: WorkspaceId; readonly limit: number },
  ): Promise<readonly Mission[]>;
  /**
   * Optimistic: succeeds only if the stored version still equals change.mission.version. A plan
   * or packet version that already exists is also a Conflict.
   */
  recordTransition(change: MissionChange): Promise<Result<Mission, { readonly kind: "Conflict" }>>;
  /** Events with seq > `afterSeq` (default 0), oldest first, at most `limit`. */
  listEvents(
    tenantId: TenantId,
    missionId: MissionId,
    page: { readonly afterSeq?: number; readonly limit: number },
  ): Promise<readonly MissionEvent[]>;
  /** Every decision on the mission's plans, oldest first. */
  listPlanDecisions(tenantId: TenantId, missionId: MissionId): Promise<readonly PlanDecision[]>;
  /** The given packet version, or the latest one when `version` is omitted. */
  findAcceptancePacket(
    tenantId: TenantId,
    missionId: MissionId,
    version?: number,
  ): Promise<StoredAcceptancePacket | undefined>;
  /** The latest decision on the given plan version, if any. */
  findPlanDecision(
    tenantId: TenantId,
    missionId: MissionId,
    planVersion: number,
  ): Promise<PlanDecision | undefined>;
  /** The given plan version, or the latest one when `version` is omitted. */
  findPlan(
    tenantId: TenantId,
    missionId: MissionId,
    version?: number,
  ): Promise<StoredPlan | undefined>;
}
