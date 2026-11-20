import {
  ErrorDto,
  PersonListDto,
  MessageDto,
  MessageListDto,
  ThreadDto,
  ThreadEventListDto,
  ThreadListDto,
} from "@aep/contracts";
import { issueApiToken } from "@aep/postgres";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
  WORKSPACE_A,
  WORKSPACE_B,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "@aep/postgres/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { postgresDependencies } from "./dependencies.ts";

// Personal threads over HTTP (ADR-014, PRD scenario G). Alice and Anna are members of tenant A;
// Bob is in tenant B.

const USER_A2 = "0a000000-0000-4000-8000-0000000000ab";

let db: TestDatabase;
let app: FastifyInstance;
let alice: string;
let anna: string;
let bob: string;

beforeAll(async () => {
  db = await startDatabase();
  app = buildApp(postgresDependencies(db.app), { logger: false });
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
  await db.admin.insertInto("users").values({ id: USER_A2, display_name: "Anna" }).execute();
  await db.admin
    .insertInto("memberships")
    .values({ tenant_id: TENANT_A, user_id: USER_A2, role: "engineer" })
    .execute();
  alice = await issueApiToken(db.admin, { tenantId: TENANT_A, userId: USER_A, name: "a" });
  anna = await issueApiToken(db.admin, { tenantId: TENANT_A, userId: USER_A2, name: "a2" });
  bob = await issueApiToken(db.admin, { tenantId: TENANT_B, userId: USER_B, name: "b" });
});

const call = (method: "GET" | "POST" | "PUT", url: string, token: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });

async function aliceThread(): Promise<string> {
  const created = await call("POST", "/v1/threads", alice, {
    workspaceId: WORKSPACE_A,
    title: "Signup conversion",
  });
  expect(created.statusCode).toBe(201);
  const thread = ThreadDto.parse(created.json());
  const posted = await call("POST", `/v1/threads/${thread.id}/messages`, alice, {
    content: "Why did signups drop last week?",
  });
  expect(posted.statusCode).toBe(201);
  return thread.id;
}

/** Every way to read a thread: by id, in the list, its messages and its events. */
async function whatCanRead(token: string, id: string) {
  const [byId, list, messages, events] = await Promise.all([
    call("GET", `/v1/threads/${id}`, token),
    call("GET", "/v1/threads", token),
    call("GET", `/v1/threads/${id}/messages`, token),
    call("GET", `/v1/threads/${id}/events`, token),
  ]);
  return {
    byId: byId.statusCode,
    listed: ThreadListDto.parse(list.json()).items.some((thread) => thread.id === id),
    messages: messages.statusCode,
    events: events.statusCode,
  };
}

const HIDDEN = { byId: 404, listed: false, messages: 404, events: 404 };
const VISIBLE = { byId: 200, listed: true, messages: 200, events: 200 };

describe("a personal thread", () => {
  it("is created personal, owned by the caller", async () => {
    const created = await call("POST", "/v1/threads", alice, {
      workspaceId: WORKSPACE_A,
      title: "  Signup  ",
    });
    expect(created.statusCode).toBe(201);
    expect(ThreadDto.parse(created.json())).toMatchObject({
      workspaceId: WORKSPACE_A,
      ownerId: USER_A,
      title: "Signup",
      visibility: { kind: "personal" },
    });
  });

  it("is readable by its owner with the message and its event", async () => {
    const id = await aliceThread();
    expect(await whatCanRead(alice, id)).toEqual(VISIBLE);

    const messages = MessageListDto.parse(
      (await call("GET", `/v1/threads/${id}/messages`, alice)).json(),
    );
    expect(messages.items).toMatchObject([
      { role: "user", authorId: USER_A, content: "Why did signups drop last week?" },
    ]);
    const events = ThreadEventListDto.parse(
      (await call("GET", `/v1/threads/${id}/events?after=0`, alice)).json(),
    );
    expect(events.items).toMatchObject([
      {
        seq: 1,
        type: "message.created",
        payload: { messageId: messages.items[0]?.id, role: "user" },
      },
    ]);
  });

  it("is not readable by another member of the tenant in any way", async () => {
    const id = await aliceThread();
    expect(await whatCanRead(anna, id)).toEqual(HIDDEN);
    const posted = await call("POST", `/v1/threads/${id}/messages`, anna, { content: "hi" });
    expect(posted.statusCode).toBe(404);
  });

  it("is not readable from another tenant", async () => {
    const id = await aliceThread();
    expect(await whatCanRead(bob, id)).toEqual(HIDDEN);
  });

  it("cannot be created in another tenant's workspace", async () => {
    const created = await call("POST", "/v1/threads", alice, {
      workspaceId: WORKSPACE_B,
      title: "x",
    });
    expect(created.statusCode).toBe(404);
  });
});

describe("sharing", () => {
  const share = (token: string, id: string, payload: object) =>
    call("PUT", `/v1/threads/${id}/visibility`, token, payload);

  it("lets a chosen member read and write until the thread is personal again", async () => {
    const id = await aliceThread();
    const shared = await share(alice, id, { kind: "members", memberIds: [USER_A2] });
    expect(shared.statusCode).toBe(200);
    expect(ThreadDto.parse(shared.json()).visibility).toEqual({
      kind: "members",
      memberIds: [USER_A2],
    });

    expect(await whatCanRead(anna, id)).toEqual(VISIBLE);
    const posted = await call("POST", `/v1/threads/${id}/messages`, anna, { content: "Looking" });
    expect(posted.statusCode).toBe(201);
    expect(MessageDto.parse(posted.json()).authorId).toBe(USER_A2);
    expect(await whatCanRead(bob, id)).toEqual(HIDDEN);

    expect((await share(alice, id, { kind: "personal" })).statusCode).toBe(200);
    expect(await whatCanRead(anna, id)).toEqual(HIDDEN);
  });

  it("shows a workspace thread to every member of the tenant", async () => {
    const id = await aliceThread();
    expect((await share(alice, id, { kind: "workspace" })).statusCode).toBe(200);
    expect(await whatCanRead(anna, id)).toEqual(VISIBLE);
    expect(await whatCanRead(bob, id)).toEqual(HIDDEN);
  });

  it("is for the owner only", async () => {
    const id = await aliceThread();
    await share(alice, id, { kind: "workspace" });
    const refused = await share(anna, id, { kind: "personal" });
    expect(refused.statusCode).toBe(403);
    expect(ErrorDto.parse(refused.json()).error.code).toBe("forbidden");
  });

  it("answers 404 to someone who cannot read the thread", async () => {
    const id = await aliceThread();
    expect((await share(anna, id, { kind: "workspace" })).statusCode).toBe(404);
  });

  it("rejects a member of another tenant", async () => {
    const id = await aliceThread();
    const refused = await share(alice, id, { kind: "members", memberIds: [USER_B] });
    expect(refused.statusCode).toBe(400);
    expect(await whatCanRead(bob, id)).toEqual(HIDDEN);
  });

  it.each([
    ["an unknown kind", { kind: "tenant" }],
    ["members without ids", { kind: "members" }],
    ["a malformed id", { kind: "members", memberIds: ["nope"] }],
  ])("rejects %s", async (_, payload) => {
    const id = await aliceThread();
    expect((await share(alice, id, payload)).statusCode).toBe(400);
  });
});

describe("requests", () => {
  it("answers 404 for a malformed thread id", async () => {
    expect((await call("GET", "/v1/threads/not-a-uuid", alice)).statusCode).toBe(404);
  });

  it("rejects an empty message and a tenantId in the body", async () => {
    const id = await aliceThread();
    expect(
      (await call("POST", `/v1/threads/${id}/messages`, alice, { content: " " })).statusCode,
    ).toBe(400);
    expect(
      (
        await call("POST", "/v1/threads", alice, {
          workspaceId: WORKSPACE_A,
          title: "x",
          tenantId: TENANT_B,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("refuses a viewer who starts a thread", async () => {
    await db.admin
      .updateTable("memberships")
      .set({ role: "viewer" })
      .where("user_id", "=", USER_A2)
      .execute();
    const refused = await call("POST", "/v1/threads", anna, {
      workspaceId: WORKSPACE_A,
      title: "x",
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe("effort and people", () => {
  it("records the effort chosen for the reply on the message", async () => {
    const id = await aliceThread();
    const posted = await call("POST", `/v1/threads/${id}/messages`, alice, {
      content: "Plan it",
      effort: "high",
    });
    expect(posted.statusCode).toBe(201);
    expect(MessageDto.parse(posted.json()).effort).toBe("high");
    const unknown = await call("POST", `/v1/threads/${id}/messages`, alice, {
      content: "x",
      effort: "max",
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("enqueues one reply job per message", async () => {
    const id = await aliceThread();
    const jobs = await db.admin
      .selectFrom("jobs")
      .select(["kind", "tenant_id"])
      .where("kind", "=", "thread.reply")
      .execute();
    expect(jobs).toEqual([{ kind: "thread.reply", tenant_id: TENANT_A }]);
    expect(id).toBeTypeOf("string");
  });

  it("lists the active members of the caller's tenant by name only", async () => {
    await db.admin
      .insertInto("users")
      .values({
        id: "0a000000-0000-4000-8000-0000000000ac",
        display_name: "Gone",
        disabled_at: new Date(),
      })
      .execute();
    await db.admin
      .insertInto("memberships")
      .values({
        tenant_id: TENANT_A,
        user_id: "0a000000-0000-4000-8000-0000000000ac",
        role: "viewer",
      })
      .execute();
    const people = await call("GET", "/v1/people", anna);
    expect(people.statusCode).toBe(200);
    expect(PersonListDto.parse(people.json()).items).toEqual([
      { userId: USER_A, displayName: "Alice" },
      { userId: USER_A2, displayName: "Anna" },
    ]);
    expect(Object.keys(PersonListDto.parse(people.json()).items[0] ?? {})).toEqual([
      "userId",
      "displayName",
    ]);
    const other = PersonListDto.parse((await call("GET", "/v1/people", bob)).json());
    expect(other.items).toEqual([{ userId: USER_B, displayName: "Bob" }]);
  });
});
