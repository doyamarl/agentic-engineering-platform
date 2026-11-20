import type { MessageId, Result, ThreadId, UserId } from "@aep/domain";
import type { NewJob } from "../jobs/job-queue.ts";
import type { AuditEventInput } from "../members/member-ports.ts";
import type { ModelContent, ModelMessage } from "../models/model-port.ts";
import type { ThreadEventInput, ThreadScope } from "../threads/thread-ports.ts";

// Approval of write tools in the thread (ADR-013, #52 decision 2). When the model calls a tool the
// manifest classes as write, the reply pauses: its state is kept with one approval per write call,
// and a card in the thread asks the person whose connection it is. When every call of the pause
// is decided, a job continues the reply; an approved call runs at most once.

/**
 * pending → approved | rejected (by the person) | expired (undecided after APPROVAL_TTL_MS).
 * approved → executing (claimed by the job that runs it) → done. A call left in `executing` by
 * a crashed worker is never run again.
 */
export type ToolApprovalStatus =
  "pending" | "approved" | "rejected" | "expired" | "executing" | "done";

/**
 * How long a write call waits for a decision (owner, 2026-11-16): three days, so a card left on a
 * Friday evening is still there on Monday. Later, the data it was based on may have changed, the
 * person may not remember the context, and the paused state (data read through the connection)
 * should not stay.
 */
export const APPROVAL_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export type ToolApproval = {
  readonly id: string;
  readonly pauseId: string;
  /** The model's id for the call, to answer it with a tool result. */
  readonly callId: string;
  readonly connectorId: string;
  readonly tool: string;
  /** The arguments exactly as the person saw them; the call runs with these. */
  readonly input: unknown;
  readonly status: ToolApprovalStatus;
};

/** What the reply needs to continue where it paused. Holds data read through the connection. */
export type ReplySnapshot = {
  /** Turns after the thread's messages: assistant tool calls and their results, oldest first. */
  readonly turns: readonly ModelMessage[];
  /** Ids of every call of the paused round, in the model's order. */
  readonly callOrder: readonly string[];
  /** Results of the round's calls that did not need approval. */
  readonly answered: readonly ModelContent[];
  /** The reply's text so far. */
  readonly text: string;
  /** The round that paused (0-based); the reply goes on with the next one. */
  readonly round: number;
  readonly sources: readonly string[];
};

export type ReplyPause = {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /** The person who asked; whose connection the calls use, and who decides. */
  readonly requestedBy: UserId;
  readonly snapshot: ReplySnapshot;
  readonly approvals: readonly ToolApproval[];
  /** Set when the reply has continued; the snapshot is gone then. */
  readonly closed: boolean;
};

export type DecideError =
  | { readonly kind: "NotFound" }
  /** Already decided, or the pause is closed. */
  | { readonly kind: "Conflict" };

export interface ToolApprovalRepository {
  /**
   * Stores the pause with its approvals (all `pending`) and appends `events`, in one transaction.
   * NotFound when the person can no longer read the thread.
   */
  pause(
    scope: ThreadScope,
    pause: Omit<ReplyPause, "closed">,
    events: readonly ThreadEventInput[],
    at: Date,
    /** Enqueued with the pause: expires what is still undecided when the time is up. */
    expiry?: NewJob,
  ): Promise<Result<void, { readonly kind: "NotFound" }>>;
  /**
   * Records the decision of `scope.userId`, who must be the pause's requester, with `event` and
   * `audit`. When it was the last pending approval of the pause, enqueues `continuation` in the
   * same transaction. Returns whether the pause is now fully decided.
   */
  decide(
    scope: ThreadScope,
    threadId: ThreadId,
    approvalId: string,
    decision: "approve" | "reject",
    at: Date,
    effects: {
      readonly event: (approval: ToolApproval) => ThreadEventInput;
      readonly audit: (approval: ToolApproval) => AuditEventInput;
      readonly continuation: (pause: Omit<ReplyPause, "snapshot" | "approvals">) => NewJob;
    },
  ): Promise<Result<{ readonly complete: boolean }, DecideError>>;
  /**
   * Marks every approval of the pause still `pending` as `expired`, with `event` and `audit` for
   * each, and enqueues `continuation` when any was. Nothing when the pause is closed or decided.
   */
  expire(
    scope: ThreadScope,
    pauseId: string,
    at: Date,
    effects: Parameters<ToolApprovalRepository["decide"]>[5],
  ): Promise<{ readonly expired: number }>;
  findPause(scope: ThreadScope, pauseId: string): Promise<ReplyPause | undefined>;
  /** Whether a reply to `messageId` is waiting for decisions (a pause not yet closed). */
  hasOpenPause(scope: ThreadScope, threadId: ThreadId, messageId: MessageId): Promise<boolean>;
  /**
   * approved → executing, only while the approval matches the call (connector, tool and
   * arguments). False otherwise: not approved, already claimed, or not this call.
   */
  claim(
    scope: ThreadScope,
    approvalId: string,
    call: { readonly connectorId: string; readonly tool: string; readonly input: unknown },
  ): Promise<boolean>;
  /** executing → done. */
  finish(scope: ThreadScope, approvalId: string, at: Date): Promise<void>;
  /** Marks the pause closed and drops its snapshot. */
  close(scope: ThreadScope, pauseId: string, at: Date): Promise<void>;
}
