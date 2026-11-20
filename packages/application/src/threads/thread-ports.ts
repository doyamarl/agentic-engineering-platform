import type {
  Actor,
  MessageId,
  Result,
  TenantId,
  Thread,
  ThreadId,
  ThreadMessage,
  ThreadVisibility,
  UserId,
  WorkspaceId,
} from "@aep/domain";
import type { NewJob } from "../jobs/job-queue.ts";

/** Whose view of the threads a repository call reads or writes with (ADR-014). */
export type ThreadScope = { readonly tenantId: TenantId; readonly userId: UserId };

/** An appended thread_events row. `message.created` names the message, not its content. */
export type ThreadEventInput = {
  readonly type: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly actor: Actor & { readonly id?: string };
};

export type ThreadEvent = ThreadEventInput & {
  /** 1, 2, ... per thread, in commit order. Clients pass the last one they saw as `after`. */
  readonly seq: number;
  readonly occurredAt: Date;
};

/**
 * Every method reads and writes as `scope.userId`. Implementations must return only threads that
 * user may read (canReadThread), so the database and the service each enforce the rule.
 * The members of a `members` thread are listed only when the scope's user owns it.
 */
export interface ThreadRepository {
  insert(thread: Thread): Promise<Result<void, { readonly kind: "WorkspaceNotFound" }>>;
  findById(scope: ThreadScope, id: ThreadId): Promise<Thread | undefined>;
  /** Readable threads, newest first. */
  list(
    scope: ThreadScope,
    filter: { readonly workspaceId?: WorkspaceId; readonly limit: number },
  ): Promise<readonly Thread[]>;
  /** Owner only: replaces the visibility and, for `members`, the whole member list. */
  setVisibility(
    scope: ThreadScope,
    id: ThreadId,
    visibility: ThreadVisibility,
    at: Date,
  ): Promise<Result<Thread, { readonly kind: "NotFound" } | { readonly kind: "MemberNotFound" }>>;
  /**
   * Stores the message and its event in one transaction, and `enqueue` with them (outbox): the
   * job exists only if the message does.
   */
  appendMessage(
    scope: ThreadScope,
    message: ThreadMessage,
    event: ThreadEventInput,
    enqueue?: NewJob,
  ): Promise<Result<void, { readonly kind: "NotFound" }>>;
  /** Appends an event that has no message, e.g. a piece of a reply being written. */
  appendEvent(
    scope: ThreadScope,
    threadId: ThreadId,
    event: ThreadEventInput,
    at: Date,
  ): Promise<Result<void, { readonly kind: "NotFound" }>>;
  /**
   * Stores a reply (reply.inReplyTo is set) and its event, unless the message already has a reply:
   * then nothing is written and the result is `exists`.
   */
  appendReply(
    scope: ThreadScope,
    reply: ThreadMessage,
    event: ThreadEventInput,
  ): Promise<Result<"stored" | "exists", { readonly kind: "NotFound" }>>;
  /** The reply to `messageId`, if one was stored. */
  findReply(
    scope: ThreadScope,
    threadId: ThreadId,
    messageId: MessageId,
  ): Promise<ThreadMessage | undefined>;
  /**
   * Oldest first, at most `limit`: the first ones, or with `upTo` the last ones up to and
   * including that message (none if it is not in the thread).
   */
  listMessages(
    scope: ThreadScope,
    id: ThreadId,
    page: { readonly limit: number; readonly upTo?: MessageId },
  ): Promise<readonly ThreadMessage[]>;
  /** Events with seq > `afterSeq` (default 0), oldest first, at most `limit`. */
  listEvents(
    scope: ThreadScope,
    id: ThreadId,
    page: { readonly afterSeq?: number; readonly limit: number },
  ): Promise<readonly ThreadEvent[]>;
}

export const toScope = (principal: { tenantId: TenantId; userId: UserId }): ThreadScope => ({
  tenantId: principal.tenantId,
  userId: principal.userId,
});
