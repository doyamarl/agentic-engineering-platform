import { fakeModel, replyJob, replyToMessage, type Job, type ThreadScope } from "@aep/application";
import type { MessageId, TenantId, ThreadId, UserId, WorkspaceId } from "@aep/domain";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./schema.ts";
import { withTenant, withTenantUser } from "./tenant-session.ts";
import { PostgresThreadRepository } from "./thread-repository.ts";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
  WORKSPACE_A,
  WORKSPACE_B,
  connect,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "./test-support.ts";

// Threads are filtered by tenant and user (ADR-014, PRD scenario G). The first block queries the
// tables directly as the runtime role with no WHERE clause, so only row-level security decides.

/** A second member of tenant A. */
const USER_A2 = "0a000000-0000-4000-8000-0000000000ab";
const THREAD = "0a000000-0000-4000-8000-00000000c001";
const MESSAGE = "0a000000-0000-4000-8000-00000000d001";
const NOW = new Date("2026-11-15T00:00:00Z");

const alice: ThreadScope = { tenantId: TENANT_A as TenantId, userId: USER_A as UserId };
const anna: ThreadScope = { tenantId: TENANT_A as TenantId, userId: USER_A2 as UserId };
const bob: ThreadScope = { tenantId: TENANT_B as TenantId, userId: USER_B as UserId };

let db: TestDatabase;
let app: Kysely<Database>;
let threads: PostgresThreadRepository;

beforeAll(async () => {
  db = await startDatabase();
  app = db.app;
  threads = new PostgresThreadRepository(app);
}, 180_000);

afterAll(async () => {
  await db.stop();
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
  await db.admin.insertInto("users").values({ id: USER_A2, display_name: "Anna" }).execute();
  await db.admin
    .insertInto("memberships")
    .values({ tenant_id: TENANT_A, user_id: USER_A2, role: "engineer" })
    .execute();
});

async function aliceThreadWithMessage(): Promise<void> {
  const inserted = await threads.insert({
    tenantId: TENANT_A as TenantId,
    workspaceId: WORKSPACE_A as WorkspaceId,
    id: THREAD as ThreadId,
    ownerId: USER_A as UserId,
    title: "Signup",
    visibility: { kind: "personal" },
    createdAt: NOW,
  });
  expect(inserted.ok).toBe(true);
  const appended = await threads.appendMessage(
    alice,
    {
      tenantId: TENANT_A as TenantId,
      threadId: THREAD as ThreadId,
      id: MESSAGE as MessageId,
      role: "user",
      authorId: USER_A as UserId,
      content: "hello",
      createdAt: NOW,
    },
    {
      type: "message.created",
      payload: { messageId: MESSAGE, role: "user" },
      actor: { kind: "human", id: USER_A },
    },
  );
  expect(appended.ok).toBe(true);
}

/** What the runtime role sees of each thread table under `scope`, with RLS as the only filter. */
const seenBy = (scope: { tenantId: string; userId: string }) =>
  withTenantUser(app, scope, async (trx) => ({
    threads: (await trx.selectFrom("threads").select("id").execute()).length,
    members: (await trx.selectFrom("thread_members").select("user_id").execute()).length,
    messages: (await trx.selectFrom("thread_messages").select("id").execute()).length,
    events: (await trx.selectFrom("thread_events").select("seq").execute()).length,
  }));

const NOTHING = { threads: 0, members: 0, messages: 0, events: 0 };

describe("row-level security alone", () => {
  it("shows a personal thread, its messages and events to the owner only", async () => {
    await aliceThreadWithMessage();
    expect(await seenBy(alice)).toEqual({ threads: 1, members: 0, messages: 1, events: 1 });
    expect(await seenBy(anna)).toEqual(NOTHING);
    expect(await seenBy({ tenantId: TENANT_B, userId: USER_A })).toEqual(NOTHING);
  });

  it("shows nothing when only the tenant is set", async () => {
    await aliceThreadWithMessage();
    const seen = await withTenant(app, TENANT_A, async (trx) => ({
      threads: await trx.selectFrom("threads").select("id").execute(),
      messages: await trx.selectFrom("thread_messages").select("id").execute(),
    }));
    expect(seen).toEqual({ threads: [], messages: [] });
  });

  it("follows sharing to a chosen member and back to personal", async () => {
    await aliceThreadWithMessage();
    await threads.setVisibility(
      alice,
      THREAD as ThreadId,
      { kind: "members", memberIds: [USER_A2 as UserId] },
      NOW,
    );
    expect(await seenBy(anna)).toEqual({ threads: 1, members: 1, messages: 1, events: 1 });

    await threads.setVisibility(alice, THREAD as ThreadId, { kind: "personal" }, NOW);
    expect(await seenBy(anna)).toEqual(NOTHING);
  });

  it("shows a workspace thread to every member of the tenant and nobody else", async () => {
    await aliceThreadWithMessage();
    await threads.setVisibility(alice, THREAD as ThreadId, { kind: "workspace" }, NOW);
    expect(await seenBy(anna)).toMatchObject({ threads: 1, messages: 1, events: 1 });
    expect(await seenBy(bob)).toEqual(NOTHING);
  });

  it("refuses a message in a thread the user cannot read", async () => {
    await aliceThreadWithMessage();
    await expect(
      withTenantUser(app, anna, (trx) =>
        trx
          .insertInto("thread_messages")
          .values({
            tenant_id: TENANT_A,
            thread_id: THREAD,
            id: "0a000000-0000-4000-8000-00000000d002",
            role: "user",
            author_id: USER_A2,
            content: "sneaking in",
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a message written in someone else's name", async () => {
    await aliceThreadWithMessage();
    await threads.setVisibility(alice, THREAD as ThreadId, { kind: "workspace" }, NOW);
    await expect(
      withTenantUser(app, anna, (trx) =>
        trx
          .insertInto("thread_messages")
          .values({
            tenant_id: TENANT_A,
            thread_id: THREAD,
            id: "0a000000-0000-4000-8000-00000000d002",
            role: "user",
            author_id: USER_A,
            content: "as alice",
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("lets only the owner change who can read", async () => {
    await aliceThreadWithMessage();
    await threads.setVisibility(alice, THREAD as ThreadId, { kind: "workspace" }, NOW);
    const updated = await withTenantUser(app, anna, (trx) =>
      trx.updateTable("threads").set({ visibility: "personal" }).execute(),
    );
    expect(updated[0]?.numUpdatedRows).toBe(0n);
    await expect(
      withTenantUser(app, anna, (trx) =>
        trx
          .insertInto("thread_members")
          .values({ tenant_id: TENANT_A, thread_id: THREAD, owner_id: USER_A, user_id: USER_A2 })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses to hand a thread to another owner", async () => {
    await aliceThreadWithMessage();
    await expect(
      withTenantUser(app, alice, (trx) =>
        trx.updateTable("threads").set({ owner_id: USER_A2 }).execute(),
      ),
    ).rejects.toThrow();
  });

  it("keeps messages and events append-only", async () => {
    await aliceThreadWithMessage();
    await expect(sql`update thread_messages set content = 'x'`.execute(db.admin)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`delete from thread_events`.execute(db.admin)).rejects.toThrow(/append-only/);
  });
});

describe("PostgresThreadRepository", () => {
  it("finds and lists a personal thread for its owner only", async () => {
    await aliceThreadWithMessage();
    expect(await threads.findById(alice, THREAD as ThreadId)).toMatchObject({
      id: THREAD,
      visibility: { kind: "personal" },
    });
    expect(await threads.findById(anna, THREAD as ThreadId)).toBeUndefined();
    expect(await threads.list(anna, { limit: 10 })).toEqual([]);
    expect(await threads.listMessages(anna, THREAD as ThreadId, { limit: 10 })).toEqual([]);
    expect(await threads.listEvents(anna, THREAD as ThreadId, { limit: 10 })).toEqual([]);
  });

  it("lists the chosen members to the owner, and only themselves to a member", async () => {
    await aliceThreadWithMessage();
    const shared = await threads.setVisibility(
      alice,
      THREAD as ThreadId,
      { kind: "members", memberIds: [USER_A2 as UserId] },
      NOW,
    );
    expect(shared).toMatchObject({
      ok: true,
      value: { visibility: { kind: "members", memberIds: [USER_A2] } },
    });
    expect((await threads.findById(anna, THREAD as ThreadId))?.visibility).toEqual({
      kind: "members",
      memberIds: [USER_A2],
    });
  });

  it("answers MemberNotFound for someone outside the tenant and changes nothing", async () => {
    await aliceThreadWithMessage();
    expect(
      await threads.setVisibility(
        alice,
        THREAD as ThreadId,
        { kind: "members", memberIds: [USER_B as UserId] },
        NOW,
      ),
    ).toEqual({ ok: false, error: { kind: "MemberNotFound" } });
    expect((await threads.findById(alice, THREAD as ThreadId))?.visibility).toEqual({
      kind: "personal",
    });
  });

  it("answers NotFound when a non-owner changes the visibility", async () => {
    await aliceThreadWithMessage();
    await threads.setVisibility(alice, THREAD as ThreadId, { kind: "workspace" }, NOW);
    expect(
      await threads.setVisibility(anna, THREAD as ThreadId, { kind: "personal" }, NOW),
    ).toEqual({
      ok: false,
      error: { kind: "NotFound" },
    });
  });

  it("answers WorkspaceNotFound for another tenant's workspace", async () => {
    expect(
      await threads.insert({
        tenantId: TENANT_A as TenantId,
        workspaceId: WORKSPACE_B as WorkspaceId,
        id: THREAD as ThreadId,
        ownerId: USER_A as UserId,
        title: "x",
        visibility: { kind: "personal" },
        createdAt: NOW,
      }),
    ).toEqual({ ok: false, error: { kind: "WorkspaceNotFound" } });
  });

  it("numbers events per thread without gaps under concurrent appends", async () => {
    await aliceThreadWithMessage();
    await threads.setVisibility(alice, THREAD as ThreadId, { kind: "workspace" }, NOW);
    // The shared runtime connection is single; this pool lets the appends really overlap.
    const pool = connect(db.appUri, 6);
    const concurrent = new PostgresThreadRepository(pool);
    const writers = Array.from({ length: 6 }, (_, i) => {
      const scope = i % 2 === 0 ? alice : anna;
      const id = `0a000000-0000-4000-8000-0000000e${String(i).padStart(4, "0")}`;
      return concurrent.appendMessage(
        scope,
        {
          tenantId: TENANT_A as TenantId,
          threadId: THREAD as ThreadId,
          id: id as MessageId,
          role: "user",
          authorId: scope.userId,
          content: `message ${String(i)}`,
          createdAt: NOW,
        },
        {
          type: "message.created",
          payload: { messageId: id, role: "user" },
          actor: { kind: "human", id: scope.userId },
        },
      );
    });
    try {
      expect((await Promise.all(writers)).every((result) => result.ok)).toBe(true);
    } finally {
      await pool.destroy();
    }
    const events = await threads.listEvents(alice, THREAD as ThreadId, { limit: 100 });
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(
      await threads.listEvents(alice, THREAD as ThreadId, { afterSeq: 6, limit: 100 }),
    ).toHaveLength(1);
  });
});

describe("replies", () => {
  const reply = (id: string, content = "An answer", inReplyTo = MESSAGE) => ({
    tenantId: TENANT_A as TenantId,
    threadId: THREAD as ThreadId,
    id: id as MessageId,
    role: "assistant" as const,
    inReplyTo: inReplyTo as MessageId,
    content,
    createdAt: NOW,
  });
  const created = (messageId: string) => ({
    type: "message.created",
    payload: { messageId, role: "assistant" },
    actor: { kind: "agent" as const, id: "model" },
  });

  it("stores one reply per message and reports the second as existing", async () => {
    await aliceThreadWithMessage();
    const first = "0a000000-0000-4000-8000-00000000d101";
    const second = "0a000000-0000-4000-8000-00000000d102";
    expect(await threads.appendReply(alice, reply(first), created(first))).toEqual({
      ok: true,
      value: "stored",
    });
    expect(await threads.appendReply(alice, reply(second), created(second))).toEqual({
      ok: true,
      value: "exists",
    });
    expect(await threads.findReply(alice, THREAD as ThreadId, MESSAGE as MessageId)).toMatchObject({
      id: first,
      role: "assistant",
      inReplyTo: MESSAGE,
    });
    expect(await threads.findReply(anna, THREAD as ThreadId, MESSAGE as MessageId)).toBeUndefined();
  });

  it("enforces one reply per message and the reply columns in the database", async () => {
    await aliceThreadWithMessage();
    const row = (id: string, values: object) => ({
      tenant_id: TENANT_A,
      thread_id: THREAD,
      id,
      role: "assistant" as const,
      author_id: null,
      content: "x",
      in_reply_to: MESSAGE,
      ...values,
    });
    await db.admin
      .insertInto("thread_messages")
      .values(row("0a000000-0000-4000-8000-00000000d201", {}))
      .execute();
    await expect(
      db.admin
        .insertInto("thread_messages")
        .values(row("0a000000-0000-4000-8000-00000000d202", {}))
        .execute(),
    ).rejects.toThrow(/thread_messages_one_reply/);
    await expect(
      db.admin
        .insertInto("thread_messages")
        .values(row("0a000000-0000-4000-8000-00000000d203", { in_reply_to: null }))
        .execute(),
    ).rejects.toThrow(/thread_messages_reply_role/);
  });

  it("holds replies longer than a person's message, up to 400,000 characters", async () => {
    await aliceThreadWithMessage();
    const long = "0a000000-0000-4000-8000-00000000d301";
    expect(
      await threads.appendReply(alice, reply(long, "x".repeat(400_000)), created(long)),
    ).toMatchObject({ ok: true });
    await expect(
      withTenantUser(app, alice, (trx) =>
        trx
          .insertInto("thread_messages")
          .values({
            tenant_id: TENANT_A,
            thread_id: THREAD,
            id: "0a000000-0000-4000-8000-00000000d302",
            role: "user",
            author_id: USER_A,
            content: "x".repeat(32_001),
          })
          .execute(),
      ),
    ).rejects.toThrow(/thread_messages_content_check/);
  });

  it("enqueues a job only together with its message", async () => {
    await aliceThreadWithMessage();
    const id = "0a000000-0000-4000-8000-00000000d401";
    const job = replyJob({
      tenantId: TENANT_A as TenantId,
      threadId: THREAD as ThreadId,
      messageId: id as MessageId,
      requestedBy: USER_A2 as UserId,
    });
    const message = {
      tenantId: TENANT_A as TenantId,
      threadId: THREAD as ThreadId,
      id: id as MessageId,
      role: "user" as const,
      authorId: USER_A2 as UserId,
      content: "hi",
      createdAt: NOW,
    };
    const event = {
      type: "message.created",
      payload: { messageId: id },
      actor: { kind: "human" as const },
    };
    // Anna cannot read Alice's personal thread: neither the message nor the job is written.
    expect(await threads.appendMessage(anna, message, event, job)).toEqual({
      ok: false,
      error: { kind: "NotFound" },
    });
    expect(await db.admin.selectFrom("jobs").select("id").execute()).toEqual([]);

    await threads.setVisibility(alice, THREAD as ThreadId, { kind: "workspace" }, NOW);
    expect(await threads.appendMessage(anna, message, event, job)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await db.admin.selectFrom("jobs").select(["kind", "idempotency_key"]).execute()).toEqual(
      [{ kind: "thread.reply", idempotency_key: id }],
    );
  });

  it("lets the reply job write as the person who asked, under row-level security", async () => {
    await aliceThreadWithMessage();
    const handler = replyToMessage({
      threads,
      model: fakeModel(),
      newMessageId: () => "0a000000-0000-4000-8000-00000000d501" as MessageId,
      now: () => NOW,
    });
    const enqueued = replyJob({
      tenantId: TENANT_A as TenantId,
      threadId: THREAD as ThreadId,
      messageId: MESSAGE as MessageId,
      requestedBy: USER_A as UserId,
    });
    const job: Job = { ...enqueued, id: "1", attempt: 1, maxAttempts: 3, lastError: null };
    await handler(job, new AbortController().signal);

    const messages = await threads.listMessages(alice, THREAD as ThreadId, { limit: 10 });
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hello"],
      ["assistant", "Fake reply to: hello"],
    ]);
    const types = (await threads.listEvents(alice, THREAD as ThreadId, { limit: 100 })).map(
      (e) => e.type,
    );
    expect(types[0]).toBe("message.created");
    expect(types[1]).toBe("reply.started");
    expect(types.at(-1)).toBe("message.created");
    // Anna, in the same tenant, still sees none of it.
    expect(await seenBy(anna)).toEqual(NOTHING);
  });
});

describe("listMessages up to a message", () => {
  it("returns the latest messages up to and including it, oldest first", async () => {
    await aliceThreadWithMessage();
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const id = `0a000000-0000-4000-8000-00000000f00${String(i)}`;
      ids.push(id);
      const appended = await threads.appendMessage(
        alice,
        {
          tenantId: TENANT_A as TenantId,
          threadId: THREAD as ThreadId,
          id: id as MessageId,
          role: "user",
          authorId: USER_A as UserId,
          content: `m${String(i)}`,
          effort: "medium",
          createdAt: new Date(NOW.getTime() + i * 1000),
        },
        { type: "message.created", payload: { messageId: id }, actor: { kind: "human" } },
      );
      expect(appended.ok).toBe(true);
    }
    const page = await threads.listMessages(alice, THREAD as ThreadId, {
      limit: 2,
      upTo: ids[2] as MessageId,
    });
    expect(page.map((m) => [m.content, m.effort])).toEqual([
      ["m2", "medium"],
      ["m3", "medium"],
    ]);
    expect(
      await threads.listMessages(alice, THREAD as ThreadId, {
        limit: 2,
        upTo: "0a000000-0000-4000-8000-00000000ffff" as MessageId,
      }),
    ).toEqual([]);
  });

  it("stores the model on a reply, and refuses effort on one", async () => {
    await aliceThreadWithMessage();
    const id = "0a000000-0000-4000-8000-00000000f101";
    await threads.appendReply(
      alice,
      {
        tenantId: TENANT_A as TenantId,
        threadId: THREAD as ThreadId,
        id: id as MessageId,
        role: "assistant",
        inReplyTo: MESSAGE as MessageId,
        content: "answer",
        model: "claude-sonnet-5",
        createdAt: NOW,
      },
      {
        type: "message.created",
        payload: { messageId: id },
        actor: { kind: "agent", id: "model" },
      },
    );
    expect(await threads.findReply(alice, THREAD as ThreadId, MESSAGE as MessageId)).toMatchObject({
      model: "claude-sonnet-5",
    });
    await expect(
      sql`update thread_messages set effort = 'low' where id = ${id}`.execute(db.admin),
    ).rejects.toThrow();
    await expect(
      db.admin
        .insertInto("thread_messages")
        .values({
          tenant_id: TENANT_A,
          thread_id: THREAD,
          id: "0a000000-0000-4000-8000-00000000f102",
          role: "user",
          author_id: USER_A,
          content: "x",
          model: "claude-sonnet-5",
        })
        .execute(),
    ).rejects.toThrow(/thread_messages_model_role/);
  });
});
