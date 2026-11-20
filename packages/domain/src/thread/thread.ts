import type { MessageId, TenantId, ThreadId, UserId, WorkspaceId } from "../ids.ts";
import { err, ok, type Result } from "../result.ts";

// Threads for talking with a model (ADR-014, PRD FR-11). A thread is personal unless its owner
// shares it. The database enforces the same rule with row-level security; canReadThread is the
// application's own check, so neither is the only control.

/** Who besides the owner may read the thread. `members` never lists the owner. */
export type ThreadVisibility =
  | { readonly kind: "personal" }
  | { readonly kind: "members"; readonly memberIds: readonly UserId[] }
  | { readonly kind: "workspace" };

export type Thread = {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
  readonly id: ThreadId;
  readonly ownerId: UserId;
  readonly title: string;
  readonly visibility: ThreadVisibility;
  readonly createdAt: Date;
};

export type MessageRole = "user" | "assistant";

/** How deeply the model thinks before replying; chosen per message, `low` by default. */
export const REPLY_EFFORTS = ["low", "medium", "high"] as const;
export type ReplyEffort = (typeof REPLY_EFFORTS)[number];
export const DEFAULT_REPLY_EFFORT: ReplyEffort = "low";

export const isReplyEffort = (value: unknown): value is ReplyEffort =>
  (REPLY_EFFORTS as readonly unknown[]).includes(value);

export type ThreadMessage = {
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly id: MessageId;
  readonly role: MessageRole;
  /** The person who wrote a user message; absent for the model's replies. */
  readonly authorId?: UserId;
  /** The user message a reply answers; absent for user messages. */
  readonly inReplyTo?: MessageId;
  /** The effort chosen for the reply to a user message. */
  readonly effort?: ReplyEffort;
  /** The model that wrote a reply. */
  readonly model?: string;
  readonly content: string;
  readonly createdAt: Date;
};

export type InvalidThread = {
  readonly kind: "InvalidThread";
  readonly field: "title" | "content" | "memberIds";
  readonly reason: string;
};

export const MAX_THREAD_TITLE_LENGTH = 200;
export const MAX_MESSAGE_LENGTH = 32_000;
/** About 64,000 output tokens; the database holds replies up to this length. */
export const MAX_REPLY_LENGTH = 400_000;
export const MAX_THREAD_MEMBERS = 100;

/**
 * Whether `userId` may read `thread`. Callers have already scoped the thread to the user's
 * tenant. "Workspace" means every member of the tenant: memberships are per tenant today.
 */
export function canReadThread(thread: Thread, userId: UserId): boolean {
  if (thread.ownerId === userId) return true;
  switch (thread.visibility.kind) {
    case "personal":
      return false;
    case "members":
      return thread.visibility.memberIds.includes(userId);
    case "workspace":
      return true;
  }
}

export function draftThread(input: {
  tenantId: TenantId;
  workspaceId: WorkspaceId;
  id: ThreadId;
  ownerId: UserId;
  title: string;
  createdAt: Date;
}): Result<Thread, InvalidThread> {
  const title = input.title.trim();
  if (title.length === 0 || title.length > MAX_THREAD_TITLE_LENGTH) {
    return err({ kind: "InvalidThread", field: "title", reason: "must be 1-200 characters" });
  }
  return ok({ ...input, title, visibility: { kind: "personal" } });
}

/** Removes duplicates and the owner, who always has access. */
export function normalizeVisibility(
  ownerId: UserId,
  visibility: ThreadVisibility,
): Result<ThreadVisibility, InvalidThread> {
  if (visibility.kind !== "members") return ok(visibility);
  const memberIds = [...new Set(visibility.memberIds)].filter((id) => id !== ownerId);
  if (memberIds.length === 0) {
    return err({ kind: "InvalidThread", field: "memberIds", reason: "must name another member" });
  }
  if (memberIds.length > MAX_THREAD_MEMBERS) {
    return err({ kind: "InvalidThread", field: "memberIds", reason: "must be at most 100" });
  }
  return ok({ kind: "members", memberIds });
}

/** A person's message. Surrounding whitespace is kept: it can matter in code blocks. */
export function draftUserMessage(input: {
  tenantId: TenantId;
  threadId: ThreadId;
  id: MessageId;
  authorId: UserId;
  content: string;
  effort?: ReplyEffort;
  createdAt: Date;
}): Result<ThreadMessage, InvalidThread> {
  if (input.content.trim().length === 0 || input.content.length > MAX_MESSAGE_LENGTH) {
    return err({ kind: "InvalidThread", field: "content", reason: "must be 1-32000 characters" });
  }
  return ok({ ...input, role: "user" });
}

/** The model's reply to `inReplyTo`. Undefined when there is nothing to store. */
export function draftReply(input: {
  tenantId: TenantId;
  threadId: ThreadId;
  id: MessageId;
  inReplyTo: MessageId;
  content: string;
  model: string;
  createdAt: Date;
}): ThreadMessage | undefined {
  if (input.content.trim().length === 0) return undefined;
  return {
    ...input,
    role: "assistant",
    content: input.content.slice(0, MAX_REPLY_LENGTH),
  };
}
