import {
  err,
  type MessageId,
  ok,
  type TenantId,
  type Thread,
  type ThreadId,
  type ThreadMessage,
  type ThreadVisibility,
  type UserId,
  type WorkspaceId,
} from "@aep/domain";
import type {
  ThreadEvent,
  ThreadEventInput,
  ThreadRepository,
  ThreadScope,
} from "./thread-ports.ts";
import type { NewJob } from "../jobs/job-queue.ts";

/**
 * In-memory ThreadRepository scoped by tenant only, like a database without the per-user
 * row-level security. Service tests use it to show that the service checks access by itself.
 */
export class InMemoryThreads implements ThreadRepository {
  readonly rows: Thread[] = [];
  readonly messages: ThreadMessage[] = [];
  readonly events: (ThreadEvent & { readonly threadId: ThreadId })[] = [];
  readonly enqueued: NewJob[] = [];
  readonly #workspaces: ReadonlyMap<TenantId, readonly WorkspaceId[]>;
  readonly #members: ReadonlyMap<TenantId, readonly UserId[]>;

  constructor(options: {
    readonly workspaces: ReadonlyMap<TenantId, readonly WorkspaceId[]>;
    readonly members: ReadonlyMap<TenantId, readonly UserId[]>;
  }) {
    this.#workspaces = options.workspaces;
    this.#members = options.members;
  }

  #find(scope: ThreadScope, id: ThreadId): Thread | undefined {
    return this.rows.find((t) => t.tenantId === scope.tenantId && t.id === id);
  }

  insert(thread: Thread) {
    if (!this.#workspaces.get(thread.tenantId)?.includes(thread.workspaceId)) {
      return Promise.resolve(err({ kind: "WorkspaceNotFound" } as const));
    }
    this.rows.unshift(thread);
    return Promise.resolve(ok(undefined));
  }

  findById(scope: ThreadScope, id: ThreadId) {
    return Promise.resolve(this.#find(scope, id));
  }

  list(scope: ThreadScope, filter: { workspaceId?: WorkspaceId; limit: number }) {
    return Promise.resolve(
      this.rows
        .filter((t) => t.tenantId === scope.tenantId)
        .filter((t) => filter.workspaceId === undefined || t.workspaceId === filter.workspaceId)
        .slice(0, filter.limit),
    );
  }

  setVisibility(scope: ThreadScope, id: ThreadId, visibility: ThreadVisibility) {
    const index = this.rows.findIndex((t) => t.tenantId === scope.tenantId && t.id === id);
    const thread = this.rows[index];
    if (thread === undefined || thread.ownerId !== scope.userId) {
      return Promise.resolve(err({ kind: "NotFound" } as const));
    }
    const members = this.#members.get(scope.tenantId) ?? [];
    if (visibility.kind === "members" && !visibility.memberIds.every((m) => members.includes(m))) {
      return Promise.resolve(err({ kind: "MemberNotFound" } as const));
    }
    const changed = { ...thread, visibility };
    this.rows[index] = changed;
    return Promise.resolve(ok(changed));
  }

  #event(threadId: ThreadId, event: ThreadEventInput, at: Date) {
    const seq = this.events.filter((e) => e.threadId === threadId).length + 1;
    this.events.push({ ...event, seq, occurredAt: at, threadId });
  }

  appendMessage(
    scope: ThreadScope,
    message: ThreadMessage,
    event: ThreadEventInput,
    enqueue?: NewJob,
  ) {
    if (this.#find(scope, message.threadId) === undefined) {
      return Promise.resolve(err({ kind: "NotFound" } as const));
    }
    this.messages.push(message);
    this.#event(message.threadId, event, message.createdAt);
    if (enqueue !== undefined) this.enqueued.push(enqueue);
    return Promise.resolve(ok(undefined));
  }

  appendEvent(scope: ThreadScope, threadId: ThreadId, event: ThreadEventInput, at: Date) {
    if (this.#find(scope, threadId) === undefined) {
      return Promise.resolve(err({ kind: "NotFound" } as const));
    }
    this.#event(threadId, event, at);
    return Promise.resolve(ok(undefined));
  }

  appendReply(scope: ThreadScope, reply: ThreadMessage, event: ThreadEventInput) {
    if (this.#find(scope, reply.threadId) === undefined) {
      return Promise.resolve(err({ kind: "NotFound" } as const));
    }
    if (this.messages.some((m) => m.inReplyTo !== undefined && m.inReplyTo === reply.inReplyTo)) {
      return Promise.resolve(ok("exists" as const));
    }
    this.messages.push(reply);
    this.#event(reply.threadId, event, reply.createdAt);
    return Promise.resolve(ok("stored" as const));
  }

  findReply(scope: ThreadScope, threadId: ThreadId, messageId: MessageId) {
    return Promise.resolve(
      this.messages.find(
        (m) =>
          m.tenantId === scope.tenantId && m.threadId === threadId && m.inReplyTo === messageId,
      ),
    );
  }

  listMessages(scope: ThreadScope, id: ThreadId, page: { limit: number; upTo?: MessageId }) {
    const all = this.messages.filter((m) => m.tenantId === scope.tenantId && m.threadId === id);
    if (page.upTo === undefined) return Promise.resolve(all.slice(0, page.limit));
    const end = all.findIndex((m) => m.id === page.upTo);
    return Promise.resolve(end < 0 ? [] : all.slice(Math.max(0, end + 1 - page.limit), end + 1));
  }

  listEvents(scope: ThreadScope, id: ThreadId, page: { afterSeq?: number; limit: number }) {
    if (this.#find(scope, id) === undefined) return Promise.resolve([]);
    return Promise.resolve(
      this.events
        .filter((e) => e.threadId === id && e.seq > (page.afterSeq ?? 0))
        .slice(0, page.limit)
        .map(({ threadId: _, ...event }) => event),
    );
  }
}
