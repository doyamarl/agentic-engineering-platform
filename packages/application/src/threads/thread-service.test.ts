import type { MessageId, TenantId, ThreadId, UserId, WorkspaceId } from "@aep/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "../principal.ts";
import { InMemoryThreads } from "./in-memory-threads.ts";
import { threadService } from "./thread-service.ts";

const TENANT_A = "0a000000-0000-4000-8000-000000000001" as TenantId;
const TENANT_B = "0b000000-0000-4000-8000-000000000001" as TenantId;
const WORKSPACE_A = "0a000000-0000-4000-8000-0000000000a1" as WorkspaceId;
const WORKSPACE_B = "0b000000-0000-4000-8000-0000000000b1" as WorkspaceId;
const NOW = new Date("2026-11-15T00:00:00Z");

const alice: Principal = {
  tenantId: TENANT_A,
  userId: "0a000000-0000-4000-8000-0000000000aa" as UserId,
  role: "planner",
};
const bob: Principal = {
  tenantId: TENANT_A,
  userId: "0a000000-0000-4000-8000-0000000000ab" as UserId,
  role: "engineer",
};
const carol: Principal = {
  tenantId: TENANT_A,
  userId: "0a000000-0000-4000-8000-0000000000ac" as UserId,
  role: "viewer",
};
const mallory: Principal = {
  tenantId: TENANT_B,
  userId: "0b000000-0000-4000-8000-0000000000bb" as UserId,
  role: "admin",
};

let threads: InMemoryThreads;
let service: ReturnType<typeof threadService>;
let nextId: number;

const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;

beforeEach(() => {
  threads = new InMemoryThreads({
    workspaces: new Map([
      [TENANT_A, [WORKSPACE_A]],
      [TENANT_B, [WORKSPACE_B]],
    ]),
    members: new Map([
      [TENANT_A, [alice.userId, bob.userId, carol.userId]],
      [TENANT_B, [mallory.userId]],
    ]),
  });
  nextId = 1;
  service = threadService({
    threads,
    newThreadId: () => id() as ThreadId,
    newMessageId: () => id() as MessageId,
    now: () => NOW,
  });
});

async function aliceThread(): Promise<ThreadId> {
  const created = await service.create(alice, { workspaceId: WORKSPACE_A, title: "Signup" });
  if (!created.ok) throw new Error("create failed");
  return created.value.id;
}

describe("create", () => {
  it("creates a personal thread owned by the caller", async () => {
    const created = await service.create(alice, { workspaceId: WORKSPACE_A, title: " Signup " });
    expect(created).toEqual({
      ok: true,
      value: {
        tenantId: TENANT_A,
        workspaceId: WORKSPACE_A,
        id: "00000000-0000-4000-8000-000000000001",
        ownerId: alice.userId,
        title: "Signup",
        visibility: { kind: "personal" },
        createdAt: NOW,
      },
    });
  });

  it("refuses a viewer", async () => {
    expect(await service.create(carol, { workspaceId: WORKSPACE_A, title: "x" })).toEqual({
      ok: false,
      error: { kind: "Forbidden", action: "thread:write" },
    });
  });

  it("answers NotFound for another tenant's workspace", async () => {
    expect(await service.create(alice, { workspaceId: WORKSPACE_B, title: "x" })).toEqual({
      ok: false,
      error: { kind: "NotFound", resource: "workspace" },
    });
  });
});

describe("reading a personal thread", () => {
  // The repository is scoped by tenant only, so these show the service's own check.
  it("hides it from another member by id, in the list, in messages and in events", async () => {
    const thread = await aliceThread();
    await service.postMessage(alice, thread, { content: "hello" });

    const hidden = { ok: false, error: { kind: "NotFound", resource: "thread" } };
    expect(await service.get(bob, thread)).toEqual(hidden);
    expect(await service.listMessages(bob, thread, {})).toEqual(hidden);
    expect(await service.listEvents(bob, thread, {})).toEqual(hidden);
    expect(await service.postMessage(bob, thread, { content: "hi" })).toEqual(hidden);
    expect(await service.list(bob, {})).toEqual({ ok: true, value: [] });
  });

  it("hides it from another tenant", async () => {
    const thread = await aliceThread();
    expect(await service.get(mallory, thread)).toMatchObject({ ok: false });
  });

  it("shows it to its owner with the message and its event", async () => {
    const thread = await aliceThread();
    const posted = await service.postMessage(alice, thread, { content: "hello" });
    expect(posted).toMatchObject({ ok: true, value: { role: "user", authorId: alice.userId } });

    expect(await service.listMessages(alice, thread, {})).toMatchObject({
      ok: true,
      value: [{ content: "hello" }],
    });
    expect(await service.listEvents(alice, thread, {})).toEqual({
      ok: true,
      value: [
        {
          seq: 1,
          type: "message.created",
          payload: { messageId: posted.ok ? posted.value.id : "", role: "user" },
          actor: { kind: "human", id: alice.userId },
          occurredAt: NOW,
        },
      ],
    });
  });
});

describe("share", () => {
  it("lets a chosen member read and write, and no one else", async () => {
    const thread = await aliceThread();
    const shared = await service.share(alice, thread, {
      kind: "members",
      memberIds: [bob.userId, alice.userId],
    });
    expect(shared).toMatchObject({
      ok: true,
      value: { visibility: { kind: "members", memberIds: [bob.userId] } },
    });

    expect(await service.get(bob, thread)).toMatchObject({ ok: true });
    expect(await service.postMessage(bob, thread, { content: "hi" })).toMatchObject({ ok: true });
    expect(await service.get(carol, thread)).toMatchObject({ ok: false });
  });

  it("shows a workspace thread to every member of the tenant, viewers included", async () => {
    const thread = await aliceThread();
    await service.share(alice, thread, { kind: "workspace" });
    expect(await service.get(carol, thread)).toMatchObject({ ok: true });
    expect(await service.list(carol, {})).toMatchObject({ ok: true, value: [{ id: thread }] });
    expect(await service.get(mallory, thread)).toMatchObject({ ok: false });
  });

  it("hides the thread again once it is personal", async () => {
    const thread = await aliceThread();
    await service.share(alice, thread, { kind: "members", memberIds: [bob.userId] });
    await service.share(alice, thread, { kind: "personal" });
    expect(await service.get(bob, thread)).toMatchObject({ ok: false });
  });

  it("is for the owner only", async () => {
    const thread = await aliceThread();
    await service.share(alice, thread, { kind: "workspace" });
    expect(await service.share(bob, thread, { kind: "personal" })).toEqual({
      ok: false,
      error: { kind: "NotOwner", resource: "thread" },
    });
  });

  it("rejects someone who is not a member of the tenant", async () => {
    const thread = await aliceThread();
    expect(
      await service.share(alice, thread, { kind: "members", memberIds: [mallory.userId] }),
    ).toMatchObject({ ok: false, error: { kind: "Invalid", field: "memberIds" } });
  });
});

describe("limits", () => {
  it.each([0, 101, 1.5])("rejects a list limit of %s", async (limit) => {
    expect(await service.list(alice, { limit })).toMatchObject({
      ok: false,
      error: { field: "limit" },
    });
  });

  it("rejects a negative cursor", async () => {
    const thread = await aliceThread();
    expect(await service.listEvents(alice, thread, { afterSeq: -1 })).toMatchObject({
      ok: false,
      error: { field: "after" },
    });
  });

  it("rejects an empty message", async () => {
    const thread = await aliceThread();
    expect(await service.postMessage(alice, thread, { content: "  " })).toMatchObject({
      ok: false,
      error: { kind: "Invalid", field: "content" },
    });
  });
});
