import { describe, expect, it } from "vitest";
import type { MessageId, TenantId, ThreadId, UserId, WorkspaceId } from "../ids.ts";
import {
  canReadThread,
  draftThread,
  draftUserMessage,
  normalizeVisibility,
  type Thread,
  type ThreadVisibility,
} from "./thread.ts";

const TENANT = "0a000000-0000-4000-8000-000000000001" as TenantId;
const WORKSPACE = "0a000000-0000-4000-8000-0000000000a1" as WorkspaceId;
const THREAD = "0a000000-0000-4000-8000-00000000c001" as ThreadId;
const OWNER = "0a000000-0000-4000-8000-0000000000aa" as UserId;
const MEMBER = "0a000000-0000-4000-8000-0000000000ab" as UserId;
const OTHER = "0a000000-0000-4000-8000-0000000000ac" as UserId;
const NOW = new Date("2026-11-15T00:00:00Z");

const thread = (visibility: ThreadVisibility): Thread => ({
  tenantId: TENANT,
  workspaceId: WORKSPACE,
  id: THREAD,
  ownerId: OWNER,
  title: "Signup",
  visibility,
  createdAt: NOW,
});

describe("canReadThread", () => {
  it.each<[string, ThreadVisibility, UserId, boolean]>([
    ["the owner of a personal thread", { kind: "personal" }, OWNER, true],
    ["anyone else on a personal thread", { kind: "personal" }, MEMBER, false],
    ["a chosen member", { kind: "members", memberIds: [MEMBER] }, MEMBER, true],
    ["a member who was not chosen", { kind: "members", memberIds: [MEMBER] }, OTHER, false],
    ["any member of a workspace thread", { kind: "workspace" }, OTHER, true],
  ])("%s → %s", (_, visibility, user, expected) => {
    expect(canReadThread(thread(visibility), user)).toBe(expected);
  });
});

describe("draftThread", () => {
  it("starts personal with a trimmed title", () => {
    const drafted = draftThread({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      id: THREAD,
      ownerId: OWNER,
      title: "  Signup  ",
      createdAt: NOW,
    });
    expect(drafted).toEqual({ ok: true, value: thread({ kind: "personal" }) });
  });

  it.each(["", "   ", "x".repeat(201)])("rejects the title %j", (title) => {
    const drafted = draftThread({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      id: THREAD,
      ownerId: OWNER,
      title,
      createdAt: NOW,
    });
    expect(drafted).toMatchObject({ ok: false, error: { field: "title" } });
  });
});

describe("normalizeVisibility", () => {
  it("drops duplicates and the owner", () => {
    expect(
      normalizeVisibility(OWNER, { kind: "members", memberIds: [MEMBER, OWNER, MEMBER] }),
    ).toEqual({ ok: true, value: { kind: "members", memberIds: [MEMBER] } });
  });

  it("rejects a member list with nobody but the owner", () => {
    expect(normalizeVisibility(OWNER, { kind: "members", memberIds: [OWNER] })).toMatchObject({
      ok: false,
      error: { field: "memberIds" },
    });
  });

  it("rejects more than 100 members", () => {
    const memberIds = Array.from(
      { length: 101 },
      (_, i) => `0a000000-0000-4000-8000-${String(i).padStart(12, "0")}` as UserId,
    );
    expect(normalizeVisibility(OWNER, { kind: "members", memberIds })).toMatchObject({
      ok: false,
      error: { field: "memberIds" },
    });
  });
});

describe("draftUserMessage", () => {
  const draft = (content: string) =>
    draftUserMessage({
      tenantId: TENANT,
      threadId: THREAD,
      id: "0a000000-0000-4000-8000-00000000d001" as MessageId,
      authorId: OWNER,
      content,
      createdAt: NOW,
    });

  it("keeps the content as written", () => {
    expect(draft("  ```ts\nx\n```")).toMatchObject({
      ok: true,
      value: { role: "user", content: "  ```ts\nx\n```" },
    });
  });

  it("keeps the chosen effort", () => {
    const drafted = draftUserMessage({
      tenantId: TENANT,
      threadId: THREAD,
      id: "0a000000-0000-4000-8000-00000000d001" as MessageId,
      authorId: OWNER,
      content: "x",
      effort: "high",
      createdAt: NOW,
    });
    expect(drafted).toMatchObject({ ok: true, value: { effort: "high" } });
  });

  it.each(["", " \n ", "x".repeat(32_001)])("rejects %j", (content) => {
    expect(draft(content)).toMatchObject({ ok: false, error: { field: "content" } });
  });
});
