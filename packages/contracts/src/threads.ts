import { z } from "zod";

// Public HTTP contract for /v1/threads (ADR-014). Requests are strict, like /v1/missions.

export const CreateThreadRequest = z.strictObject({
  workspaceId: z.uuid(),
  // Upper bound only bounds the payload; the domain enforces 1-200 characters.
  title: z.string().max(1000),
});
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;

export const ListThreadsQuery = z.strictObject({
  workspaceId: z.uuid().optional(),
  limit: z.coerce.number().int().optional(),
});
export type ListThreadsQuery = z.infer<typeof ListThreadsQuery>;

/** Replaces who besides the owner may read the thread. Owner only. */
export const ShareThreadRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("personal") }),
  z.strictObject({ kind: z.literal("members"), memberIds: z.array(z.uuid()).max(200) }),
  z.strictObject({ kind: z.literal("workspace") }),
]);
export type ShareThreadRequest = z.infer<typeof ShareThreadRequest>;

/** `memberIds` is the full list for the owner; another member sees only itself in it. */
export const ThreadVisibilityDto = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal") }),
  z.object({ kind: z.literal("members"), memberIds: z.array(z.uuid()) }),
  z.object({ kind: z.literal("workspace") }),
]);
export type ThreadVisibilityDto = z.infer<typeof ThreadVisibilityDto>;

export const ThreadDto = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  ownerId: z.uuid(),
  title: z.string(),
  visibility: ThreadVisibilityDto,
  createdAt: z.iso.datetime(),
});
export type ThreadDto = z.infer<typeof ThreadDto>;

export const ThreadListDto = z.object({ items: z.array(ThreadDto) });
export type ThreadListDto = z.infer<typeof ThreadListDto>;

export const PostMessageRequest = z.strictObject({
  // Upper bound only bounds the payload; the domain enforces 1-32000 characters.
  content: z.string().max(40_000),
  /** How deeply the model thinks before replying. Defaults to low. */
  effort: z.enum(["low", "medium", "high"]).optional(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

export const ListMessagesQuery = z.strictObject({
  limit: z.coerce.number().int().optional(),
});
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;

export const MessageDto = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  role: z.enum(["user", "assistant"]),
  authorId: z.uuid().optional(),
  content: z.string(),
  /** On a person's message: the effort chosen for its reply. */
  effort: z.enum(["low", "medium", "high"]).optional(),
  /** On a reply: the model that wrote it. */
  model: z.string().optional(),
  /** On a reply: the person's message it answers. */
  inReplyTo: z.uuid().optional(),
  createdAt: z.iso.datetime(),
});
export type MessageDto = z.infer<typeof MessageDto>;

export const MessageListDto = z.object({ items: z.array(MessageDto) });
export type MessageListDto = z.infer<typeof MessageListDto>;

/** One entry of the thread's stream; `message.created` names a message to fetch. */
export const ThreadEventDto = z.object({
  seq: z.number().int(),
  type: z.string(),
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  actor: z.object({ kind: z.enum(["human", "agent", "system"]), id: z.string().optional() }),
  occurredAt: z.iso.datetime(),
});
export type ThreadEventDto = z.infer<typeof ThreadEventDto>;

export const ThreadEventListDto = z.object({ items: z.array(ThreadEventDto) });
export type ThreadEventListDto = z.infer<typeof ThreadEventListDto>;

/** A member of the caller's tenant, to share a thread with. Disabled members are left out. */
export const PersonDto = z.object({ userId: z.uuid(), displayName: z.string() });
export type PersonDto = z.infer<typeof PersonDto>;

export const PersonListDto = z.object({ items: z.array(PersonDto) });
export type PersonListDto = z.infer<typeof PersonListDto>;
