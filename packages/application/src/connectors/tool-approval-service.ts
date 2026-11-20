import {
  can,
  err,
  type MessageId,
  type Result,
  type TenantId,
  type ThreadId,
  type UserId,
} from "@aep/domain";
import type { AppError } from "../errors.ts";
import type { Job, NewJob } from "../jobs/job-queue.ts";
import type { JobHandler } from "../jobs/run-worker.ts";
import type { Principal } from "../principal.ts";
import { replyJob } from "../threads/reply-job.ts";
import { APPROVAL_TTL_MS, type ToolApprovalRepository } from "./tool-approval-ports.ts";

// The person whose connection a write call would use approves or declines it in the thread
// (#52 decision 2). Only that person: another member who can read the thread sees the card but
// cannot decide, since the call would act with someone else's account. What nobody decides
// within APPROVAL_TTL_MS expires, and the reply goes on without it.

export const APPROVAL_EXPIRY_JOB = "thread.approval_expiry";

type Decision = "approve" | "reject" | "expired";

/** The event, audit entry and continuation every decision writes, by a person or by expiry. */
function effects(tenantId: TenantId, threadId: ThreadId, actor: UserId | null, decision: Decision) {
  return {
    event: (approval: { id: string; callId: string; connectorId: string; tool: string }) => ({
      type: "tool.approval_decided",
      payload: {
        approvalId: approval.id,
        callId: approval.callId,
        connectorId: approval.connectorId,
        tool: approval.tool,
        decision,
      },
      actor: actor === null ? { kind: "system" as const } : { kind: "human" as const, id: actor },
    }),
    audit: (approval: { id: string; connectorId: string; tool: string }) => ({
      type: "connector.tool_decided" as const,
      actorId: actor,
      subjectId: actor,
      payload: {
        connectorId: approval.connectorId,
        tool: approval.tool,
        approvalId: approval.id,
        threadId,
        decision,
      },
    }),
    continuation: (pause: {
      id: string;
      threadId: ThreadId;
      messageId: MessageId;
      requestedBy: UserId;
    }) =>
      replyJob({
        tenantId,
        threadId: pause.threadId,
        messageId: pause.messageId,
        requestedBy: pause.requestedBy,
        pauseId: pause.id,
      }),
  };
}

/** Enqueued with a pause; runs once the time to decide is up. */
export function approvalExpiryJob(input: {
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly requestedBy: UserId;
  readonly pauseId: string;
  readonly pausedAt: Date;
}): NewJob {
  return {
    tenantId: input.tenantId,
    kind: APPROVAL_EXPIRY_JOB,
    idempotencyKey: input.pauseId,
    payload: {
      threadId: input.threadId,
      messageId: input.messageId,
      requestedBy: input.requestedBy,
      pauseId: input.pauseId,
    },
    runAfter: new Date(input.pausedAt.getTime() + APPROVAL_TTL_MS),
  };
}

export function toolApprovalService({
  approvals,
  now,
}: {
  readonly approvals: ToolApprovalRepository;
  readonly now: () => Date;
}) {
  return {
    async decide(
      principal: Principal,
      threadId: ThreadId,
      approvalId: string,
      decision: "approve" | "reject",
    ): Promise<Result<{ readonly complete: boolean }, AppError>> {
      if (!can(principal.role, "connector:use")) {
        return err({ kind: "Forbidden", action: "connector:use" });
      }
      const scope = { tenantId: principal.tenantId, userId: principal.userId };
      const result = await approvals.decide(
        scope,
        threadId,
        approvalId,
        decision,
        now(),
        effects(principal.tenantId, threadId, principal.userId, decision),
      );
      if (result.ok) return result;
      return result.error.kind === "NotFound"
        ? err({ kind: "NotFound", resource: "tool approval" })
        : err({ kind: "Conflict", reason: "already decided" });
    },
  };
}

export type ToolApprovalService = ReturnType<typeof toolApprovalService>;

/** Expires what is still undecided in a pause; the continuation then tells the model. */
export function expireApprovals({
  approvals,
  now,
}: {
  readonly approvals: ToolApprovalRepository;
  readonly now: () => Date;
}): JobHandler {
  return async (job: Job) => {
    const { threadId, requestedBy, pauseId } = job.payload;
    if (
      typeof threadId !== "string" ||
      typeof requestedBy !== "string" ||
      typeof pauseId !== "string"
    ) {
      throw new Error(`${APPROVAL_EXPIRY_JOB} ${job.id}: malformed payload`);
    }
    await approvals.expire(
      { tenantId: job.tenantId, userId: requestedBy as UserId },
      pauseId,
      now(),
      effects(job.tenantId, threadId as ThreadId, null, "expired"),
    );
  };
}
