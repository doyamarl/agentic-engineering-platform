import type { MessageId, TenantId, ThreadId, UserId } from "@aep/domain";
import type { NewJob } from "../jobs/job-queue.ts";

export const REPLY_JOB = "thread.reply";

/** Payload of `thread.reply`. The reply is written as the person who asked, under RLS. */
export function replyJob(input: {
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly requestedBy: UserId;
  /** Continues a reply that paused for approval of write tools (ADR-013). */
  readonly pauseId?: string;
}): NewJob {
  return {
    tenantId: input.tenantId,
    kind: REPLY_JOB,
    idempotencyKey:
      input.pauseId === undefined ? input.messageId : `${input.messageId}:${input.pauseId}`,
    payload: {
      threadId: input.threadId,
      messageId: input.messageId,
      requestedBy: input.requestedBy,
      ...(input.pauseId === undefined ? {} : { pauseId: input.pauseId }),
    },
    // A reply that has not started within a few attempts is no longer what the person waits for.
    maxAttempts: 3,
  };
}
