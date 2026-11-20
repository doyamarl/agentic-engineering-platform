import type { ThreadScope } from "@aep/application";
import type { MessageId, TenantId, ThreadId, UserId, WorkspaceId } from "@aep/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenantUser } from "./tenant-session.ts";
import { PostgresThreadRepository } from "./thread-repository.ts";
import { PostgresToolApprovals } from "./tool-approval-repository.ts";
import {
  TENANT_A,
  USER_A,
  WORKSPACE_A,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "./test-support.ts";

// Paused replies and write approvals (migration 0018): only the person who asked sees them or
// decides, the arguments are matched as JSON, and a continuation is enqueued with the last decision.

const USER_A2 = "0a000000-0000-4000-8000-0000000000ab";
const THREAD = "0a000000-0000-4000-8000-00000000c001" as ThreadId;
const MESSAGE = "0a000000-0000-4000-8000-00000000d001" as MessageId;
const PAUSE = "0a000000-0000-4000-8000-00000000e001";
const AP1 = "0a000000-0000-4000-8000-00000000f001";
const AP2 = "0a000000-0000-4000-8000-00000000f002";
const NOW = new Date("2026-11-16T00:00:00Z");

const alice: ThreadScope = { tenantId: TENANT_A as TenantId, userId: USER_A as UserId };
const anna: ThreadScope = { tenantId: TENANT_A as TenantId, userId: USER_A2 as UserId };

let db: TestDatabase;
let threads: PostgresThreadRepository;
let repo: PostgresToolApprovals;

beforeAll(async () => {
  db = await startDatabase();
  threads = new PostgresThreadRepository(db.app);
  repo = new PostgresToolApprovals(db.app);
}, 180_000);

afterAll(async () => {
  await db.stop();
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
  await db.admin.deleteFrom("jobs").execute();
  await db.admin.insertInto("users").values({ id: USER_A2, display_name: "Anna" }).execute();
  await db.admin
    .insertInto("memberships")
    .values({ tenant_id: TENANT_A, user_id: USER_A2, role: "engineer" })
    .execute();
  // Alice's thread, shared with the workspace so Anna can read it.
  await threads.insert({
    tenantId: TENANT_A as TenantId,
    workspaceId: WORKSPACE_A as WorkspaceId,
    id: THREAD,
    ownerId: USER_A as UserId,
    title: "Charts",
    visibility: { kind: "workspace" },
    createdAt: NOW,
  });
  await threads.appendMessage(
    alice,
    {
      tenantId: TENANT_A as TenantId,
      threadId: THREAD,
      id: MESSAGE,
      role: "user",
      authorId: USER_A as UserId,
      content: "Clean up",
      createdAt: NOW,
    },
    { type: "message.created", payload: { messageId: MESSAGE }, actor: { kind: "human" } },
  );
});

const pause = () =>
  repo.pause(
    alice,
    {
      id: PAUSE,
      threadId: THREAD,
      messageId: MESSAGE,
      requestedBy: alice.userId,
      snapshot: {
        turns: [{ role: "assistant", content: [{ type: "text", text: "secret funnel" }] }],
        callOrder: ["c1", "c2"],
        answered: [],
        text: "So far",
        round: 0,
        sources: ["analytics"],
      },
      approvals: [
        {
          id: AP1,
          pauseId: PAUSE,
          callId: "c1",
          connectorId: "analytics",
          tool: "manage",
          input: { action: "delete", entityId: "c1" },
          status: "pending",
        },
        {
          id: AP2,
          pauseId: PAUSE,
          callId: "c2",
          connectorId: "analytics",
          tool: "manage",
          input: { action: "rename" },
          status: "pending",
        },
      ],
    },
    [{ type: "tool.approval_requested", payload: { approvalId: AP1 }, actor: { kind: "agent" } }],
    NOW,
  );

const effects = {
  event: (a: { id: string }) => ({
    type: "tool.approval_decided",
    payload: { approvalId: a.id },
    actor: { kind: "human" as const },
  }),
  audit: (a: { id: string }) => ({
    type: "connector.tool_decided" as const,
    actorId: USER_A as UserId,
    subjectId: USER_A as UserId,
    payload: { approvalId: a.id },
  }),
  continuation: (p: { id: string }) => ({
    tenantId: TENANT_A as TenantId,
    kind: "thread.reply",
    idempotencyKey: `${MESSAGE}:${p.id}`,
    payload: { pauseId: p.id },
  }),
};

describe("PostgresToolApprovals", () => {
  it("keeps the pause for the person who asked only", async () => {
    expect((await pause()).ok).toBe(true);
    expect(await repo.hasOpenPause(alice, THREAD, MESSAGE)).toBe(true);
    expect(await repo.findPause(alice, PAUSE)).toMatchObject({
      snapshot: { text: "So far" },
      approvals: [{ status: "pending" }, { status: "pending" }],
    });
    // Anna reads the thread but not the pause, whatever the query asks for.
    expect(await repo.findPause(anna, PAUSE)).toBeUndefined();
    const rows = await withTenantUser(db.app, anna, async (trx) => [
      ...(await trx.selectFrom("reply_pauses").selectAll().execute()),
      ...(await trx.selectFrom("tool_approvals").selectAll().execute()),
    ]);
    expect(rows).toEqual([]);
    expect(await repo.decide(anna, THREAD, AP1, "approve", NOW, effects)).toEqual({
      ok: false,
      error: { kind: "NotFound" },
    });
  });

  it("enqueues the continuation with the last decision, in the same transaction", async () => {
    await pause();
    expect(await repo.decide(alice, THREAD, AP1, "approve", NOW, effects)).toEqual({
      ok: true,
      value: { complete: false },
    });
    expect(await db.admin.selectFrom("jobs").select("kind").execute()).toEqual([]);
    expect(await repo.decide(alice, THREAD, AP1, "reject", NOW, effects)).toEqual({
      ok: false,
      error: { kind: "Conflict" },
    });
    expect(await repo.decide(alice, THREAD, AP2, "reject", NOW, effects)).toEqual({
      ok: true,
      value: { complete: true },
    });
    expect(await db.admin.selectFrom("jobs").select(["kind", "payload"]).execute()).toEqual([
      { kind: "thread.reply", payload: { pauseId: PAUSE } },
    ]);
    const audit = await db.admin.selectFrom("audit_events").select("type").execute();
    expect(audit.filter((a) => a.type === "connector.tool_decided")).toHaveLength(2);
    const events = await db.admin
      .selectFrom("thread_events")
      .select("type")
      .orderBy("seq")
      .execute();
    expect(events.map((e) => e.type)).toEqual([
      "message.created",
      "tool.approval_requested",
      "tool.approval_decided",
      "tool.approval_decided",
    ]);
  });

  it("lets an approved call run once, with the approved arguments only", async () => {
    await pause();
    const call = { connectorId: "analytics", tool: "manage" };
    expect(
      await repo.claim(alice, AP1, { ...call, input: { action: "delete", entityId: "c1" } }),
    ).toBe(false);
    await repo.decide(alice, THREAD, AP1, "approve", NOW, effects);
    expect(
      await repo.claim(alice, AP1, { ...call, input: { action: "delete", entityId: "c2" } }),
    ).toBe(false);
    expect(
      await repo.claim(anna, AP1, { ...call, input: { action: "delete", entityId: "c1" } }),
    ).toBe(false);
    // Same JSON with the keys in another order.
    expect(
      await repo.claim(alice, AP1, { ...call, input: { entityId: "c1", action: "delete" } }),
    ).toBe(true);
    expect(
      await repo.claim(alice, AP1, { ...call, input: { action: "delete", entityId: "c1" } }),
    ).toBe(false);
    await repo.finish(alice, AP1, NOW);
    expect((await repo.findPause(alice, PAUSE))?.approvals[0]?.status).toBe("done");
  });

  it("expires the undecided calls only, and continues the reply", async () => {
    await pause();
    await repo.decide(alice, THREAD, AP1, "approve", NOW, effects);
    expect(await repo.expire(anna, PAUSE, NOW, effects)).toEqual({ expired: 0 });
    expect(await repo.expire(alice, PAUSE, NOW, effects)).toEqual({ expired: 1 });
    expect((await repo.findPause(alice, PAUSE))?.approvals.map((a) => a.status)).toEqual([
      "approved",
      "expired",
    ]);
    expect(await db.admin.selectFrom("jobs").select("kind").execute()).toEqual([
      { kind: "thread.reply" },
    ]);
    // Running the expiry again finds nothing left to expire.
    expect(await repo.expire(alice, PAUSE, NOW, effects)).toEqual({ expired: 0 });
  });

  it("enqueues the expiry with the pause, and expires nothing once it is closed", async () => {
    await repo.close(alice, PAUSE, NOW);
    await db.admin.deleteFrom("jobs").execute();
    await repo.pause(
      alice,
      {
        id: "0a000000-0000-4000-8000-00000000e002",
        threadId: THREAD,
        messageId: MESSAGE,
        requestedBy: alice.userId,
        snapshot: { turns: [], callOrder: [], answered: [], text: "", round: 0, sources: [] },
        approvals: [],
      },
      [],
      NOW,
      {
        tenantId: TENANT_A as TenantId,
        kind: "thread.approval_expiry",
        idempotencyKey: "e002",
        payload: {},
        runAfter: new Date(NOW.getTime() + 1000),
      },
    );
    const jobs = await db.admin.selectFrom("jobs").select(["kind", "run_after"]).execute();
    expect(jobs).toEqual([
      { kind: "thread.approval_expiry", run_after: new Date(NOW.getTime() + 1000) },
    ]);
    await pause();
    await repo.close(alice, PAUSE, NOW);
    expect(await repo.expire(alice, PAUSE, NOW, effects)).toEqual({ expired: 0 });
  });

  it("drops the snapshot when the pause closes", async () => {
    await pause();
    await repo.close(alice, PAUSE, NOW);
    expect(await repo.hasOpenPause(alice, THREAD, MESSAGE)).toBe(false);
    const row = await db.admin.selectFrom("reply_pauses").selectAll().executeTakeFirstOrThrow();
    expect(row.snapshot).toBeNull();
    expect(row.closed_at).not.toBeNull();
    expect(await repo.decide(alice, THREAD, AP1, "approve", NOW, effects)).toEqual({
      ok: false,
      error: { kind: "Conflict" },
    });
  });
});
