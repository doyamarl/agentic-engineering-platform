import {
  can,
  canReadThread,
  DEFAULT_REPLY_EFFORT,
  draftThread,
  draftUserMessage,
  err,
  normalizeVisibility,
  ok,
  type Action,
  type MessageId,
  type ReplyEffort,
  type Result,
  type Thread,
  type ThreadId,
  type ThreadMessage,
  type ThreadVisibility,
  type WorkspaceId,
} from "@aep/domain";
import type { AppError } from "../errors.ts";
import type { Principal } from "../principal.ts";
import { replyJob } from "./reply-job.ts";
import { toScope, type ThreadEvent, type ThreadRepository } from "./thread-ports.ts";

export const DEFAULT_THREAD_LIST_LIMIT = 50;
export const MAX_THREAD_LIST_LIMIT = 100;
export const DEFAULT_MESSAGE_LIMIT = 200;
export const MAX_MESSAGE_LIMIT = 500;
export const DEFAULT_THREAD_EVENT_LIMIT = 100;
export const MAX_THREAD_EVENT_LIMIT = 500;

type Deps = {
  readonly threads: ThreadRepository;
  readonly newThreadId: () => ThreadId;
  readonly newMessageId: () => MessageId;
  readonly now: () => Date;
};

const forbidden = (action: Action) => err({ kind: "Forbidden", action } as const);
const notFound = () => err({ kind: "NotFound", resource: "thread" } as const);

function limitWithin(
  value: number | undefined,
  fallback: number,
  max: number,
): Result<number, AppError> {
  const limit = value ?? fallback;
  return Number.isInteger(limit) && limit >= 1 && limit <= max
    ? ok(limit)
    : err({ kind: "Invalid", field: "limit", reason: `must be an integer 1-${String(max)}` });
}

/**
 * Personal threads and sharing (ADR-014). Every read goes through canReadThread here as well as
 * through the repository, whose Postgres adapter is filtered by row-level security.
 */
export function threadService({ threads, newThreadId, newMessageId, now }: Deps) {
  async function readable(
    principal: Principal,
    action: Action,
    id: ThreadId,
  ): Promise<Result<Thread, AppError>> {
    if (!can(principal.role, action)) return forbidden(action);
    const thread = await threads.findById(toScope(principal), id);
    if (
      thread === undefined ||
      thread.tenantId !== principal.tenantId ||
      !canReadThread(thread, principal.userId)
    ) {
      return notFound();
    }
    return ok(thread);
  }

  return {
    async create(
      principal: Principal,
      input: { readonly workspaceId: WorkspaceId; readonly title: string },
    ): Promise<Result<Thread, AppError>> {
      if (!can(principal.role, "thread:write")) return forbidden("thread:write");
      const drafted = draftThread({
        tenantId: principal.tenantId,
        workspaceId: input.workspaceId,
        id: newThreadId(),
        ownerId: principal.userId,
        title: input.title,
        createdAt: now(),
      });
      if (!drafted.ok) {
        return err({ kind: "Invalid", field: drafted.error.field, reason: drafted.error.reason });
      }
      const inserted = await threads.insert(drafted.value);
      return inserted.ok ? drafted : err({ kind: "NotFound", resource: "workspace" });
    },

    get(principal: Principal, id: ThreadId): Promise<Result<Thread, AppError>> {
      return readable(principal, "thread:read", id);
    },

    async list(
      principal: Principal,
      filter: { readonly workspaceId?: WorkspaceId; readonly limit?: number },
    ): Promise<Result<readonly Thread[], AppError>> {
      if (!can(principal.role, "thread:read")) return forbidden("thread:read");
      const limit = limitWithin(filter.limit, DEFAULT_THREAD_LIST_LIMIT, MAX_THREAD_LIST_LIMIT);
      if (!limit.ok) return limit;
      const found = await threads.list(toScope(principal), {
        limit: limit.value,
        ...(filter.workspaceId === undefined ? {} : { workspaceId: filter.workspaceId }),
      });
      return ok(
        found.filter(
          (thread) =>
            thread.tenantId === principal.tenantId && canReadThread(thread, principal.userId),
        ),
      );
    },

    /** Owner only. Going back to personal removes every chosen member. */
    async share(
      principal: Principal,
      id: ThreadId,
      visibility: ThreadVisibility,
    ): Promise<Result<Thread, AppError>> {
      const found = await readable(principal, "thread:write", id);
      if (!found.ok) return found;
      if (found.value.ownerId !== principal.userId) {
        return err({ kind: "NotOwner", resource: "thread" });
      }
      const normalized = normalizeVisibility(principal.userId, visibility);
      if (!normalized.ok) {
        return err({
          kind: "Invalid",
          field: normalized.error.field,
          reason: normalized.error.reason,
        });
      }
      const changed = await threads.setVisibility(toScope(principal), id, normalized.value, now());
      if (changed.ok) return changed;
      return changed.error.kind === "MemberNotFound"
        ? err({ kind: "Invalid", field: "memberIds", reason: "must be members of the tenant" })
        : notFound();
    },

    /** Anyone who may read the thread may write in it; the model then replies. */
    async postMessage(
      principal: Principal,
      id: ThreadId,
      input: { readonly content: string; readonly effort?: ReplyEffort },
    ): Promise<Result<ThreadMessage, AppError>> {
      const found = await readable(principal, "thread:write", id);
      if (!found.ok) return found;
      const drafted = draftUserMessage({
        tenantId: principal.tenantId,
        threadId: id,
        id: newMessageId(),
        authorId: principal.userId,
        content: input.content,
        effort: input.effort ?? DEFAULT_REPLY_EFFORT,
        createdAt: now(),
      });
      if (!drafted.ok) {
        return err({ kind: "Invalid", field: drafted.error.field, reason: drafted.error.reason });
      }
      // The model's reply is written by the worker (job thread.reply), as this person.
      const appended = await threads.appendMessage(
        toScope(principal),
        drafted.value,
        {
          type: "message.created",
          payload: { messageId: drafted.value.id, role: "user" },
          actor: { kind: "human", id: principal.userId },
        },
        replyJob({
          tenantId: principal.tenantId,
          threadId: id,
          messageId: drafted.value.id,
          requestedBy: principal.userId,
        }),
      );
      // The thread became unreadable between the check and the write, e.g. unshared.
      return appended.ok ? drafted : notFound();
    },

    async listMessages(
      principal: Principal,
      id: ThreadId,
      page: { readonly limit?: number },
    ): Promise<Result<readonly ThreadMessage[], AppError>> {
      const found = await readable(principal, "thread:read", id);
      if (!found.ok) return found;
      const limit = limitWithin(page.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
      if (!limit.ok) return limit;
      return ok(await threads.listMessages(toScope(principal), id, { limit: limit.value }));
    },

    /** The thread's stream, oldest first; pass the last seq seen as `afterSeq` to follow it. */
    async listEvents(
      principal: Principal,
      id: ThreadId,
      page: { readonly afterSeq?: number; readonly limit?: number },
    ): Promise<Result<readonly ThreadEvent[], AppError>> {
      const found = await readable(principal, "thread:read", id);
      if (!found.ok) return found;
      const limit = limitWithin(page.limit, DEFAULT_THREAD_EVENT_LIMIT, MAX_THREAD_EVENT_LIMIT);
      if (!limit.ok) return limit;
      const afterSeq = page.afterSeq ?? 0;
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        return err({ kind: "Invalid", field: "after", reason: "must be a non-negative integer" });
      }
      return ok(await threads.listEvents(toScope(principal), id, { afterSeq, limit: limit.value }));
    },
  };
}

export type ThreadService = ReturnType<typeof threadService>;
