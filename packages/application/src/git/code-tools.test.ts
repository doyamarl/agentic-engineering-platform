import type { TenantId, UserId, WorkspaceId } from "@aep/domain";
import { describe, expect, it } from "vitest";
import type { AuditEventInput } from "../members/member-ports.ts";
import { InMemoryWorkspaceRepositories } from "../workspaces/in-memory-workspace-repositories.ts";
import { CodeReadError, type CodeReader } from "./code-reader.ts";
import { workspaceCodeTools } from "./code-tools.ts";

const TENANT = "0a000000-0000-4000-8000-000000000001" as TenantId;
const WORKSPACE = "0a000000-0000-4000-8000-0000000000a1" as WorkspaceId;
const OTHER_WORKSPACE = "0a000000-0000-4000-8000-0000000000a2" as WorkspaceId;
const ALICE = "0a000000-0000-4000-8000-0000000000aa" as UserId;
const scope = { tenantId: TENANT, userId: ALICE };
const NOW = new Date("2026-11-17T00:00:00Z");

type Seen = { op: string; repository: string; arg: string; ref?: string };

function setup(
  reader: Partial<CodeReader> = {},
  limits?: { callMs?: number; resultChars?: number },
) {
  const seen: Seen[] = [];
  const audit: AuditEventInput[] = [];
  const repositories = new InMemoryWorkspaceRepositories()
    .seed(TENANT, WORKSPACE, [{ owner: "Acme", name: "Shop", addedBy: ALICE, addedAt: NOW }])
    .seed(TENANT, OTHER_WORKSPACE, [
      { owner: "acme", name: "payroll", addedBy: ALICE, addedAt: NOW },
    ]);
  const tools = workspaceCodeTools({
    repositories,
    reader: {
      readPath:
        reader.readPath ??
        ((repository, request) => {
          seen.push({
            op: "read",
            repository: `${repository.owner}/${repository.name}`,
            arg: request.path,
            ...(request.ref === undefined ? {} : { ref: request.ref }),
          });
          return Promise.resolve({ kind: "file", path: request.path, size: 5, text: "hello" });
        }),
      search:
        reader.search ??
        ((repository, query) => {
          seen.push({
            op: "search",
            repository: `${repository.owner}/${repository.name}`,
            arg: query,
          });
          return Promise.resolve({
            total: 1,
            items: [{ path: "src/signup.ts", fragments: ["const steps = 3"] }],
          });
        }),
    },
    audit: { record: (_tenant, event) => Promise.resolve(void audit.push(event)) },
    ...(limits === undefined ? {} : { limits }),
  });
  const call = (name: string, input: unknown, workspaceId = WORKSPACE) =>
    tools.call(scope, { workspaceId, threadId: "t1", name, input }, new AbortController().signal);
  return { tools, call, seen, audit };
}

describe("workspaceCodeTools.tools", () => {
  it("offers search and read over the workspace's repositories only", async () => {
    const { tools } = setup();
    const offered = await tools.tools(scope, WORKSPACE);
    expect(offered.map((t) => [t.name, t.toolClass])).toEqual([
      ["github__search_code", "read"],
      ["github__read_file", "read"],
    ]);
    expect(offered[1]?.inputSchema.properties?.["repository"]).toMatchObject({
      enum: ["Acme/Shop"],
    });
    expect(JSON.stringify(offered)).not.toContain("payroll");
  });

  it("offers nothing for a workspace without repositories or of another tenant", async () => {
    const { tools } = setup();
    const unknown = "0a000000-0000-4000-8000-0000000000ff" as WorkspaceId;
    expect(await tools.tools(scope, unknown)).toEqual([]);
    const other = { tenantId: "0b000000-0000-4000-8000-000000000001" as TenantId, userId: ALICE };
    expect(await tools.tools(other, WORKSPACE)).toEqual([]);
  });
});

describe("workspaceCodeTools.call", () => {
  it("reads a file, matching the repository name regardless of case, and audits the call", async () => {
    const { call, seen, audit } = setup();
    const result = await call("github__read_file", {
      repository: "acme/shop",
      path: "src/a.ts",
      ref: "release/1.2",
    });
    expect(result).toMatchObject({ outcome: "ok", repository: "Acme/Shop", truncated: false });
    expect(result.content).toContain("hello");
    expect(seen).toEqual([
      { op: "read", repository: "Acme/Shop", arg: "src/a.ts", ref: "release/1.2" },
    ]);
    expect(audit).toEqual([
      {
        type: "connector.tool_called",
        actorId: ALICE,
        subjectId: ALICE,
        payload: expect.objectContaining({
          connectorId: "github",
          tool: "read_file",
          class: "read",
          outcome: "ok",
          threadId: "t1",
          repository: "Acme/Shop",
          resultChars: expect.any(Number) as unknown,
        }) as unknown,
      },
    ]);
  });

  it("refuses a repository of another workspace and audits the refusal", async () => {
    const { call, seen, audit } = setup();
    const result = await call("github__read_file", { repository: "acme/payroll", path: "" });
    expect(result.outcome).toBe("refused");
    expect(seen).toEqual([]);
    expect(audit[0]?.payload).toMatchObject({ outcome: "refused", repository: "acme/payroll" });
  });

  it.each([
    ["../secrets", "`..`"],
    ["src/../../x", "`..`"],
    ["/etc/passwd", "relative"],
    ["a\\b", "relative"],
    ["a\nb", "relative"],
  ])("refuses the path %j without reading", async (path, reason) => {
    const { call, seen } = setup();
    const result = await call("github__read_file", { repository: "Acme/Shop", path });
    expect(result.outcome).toBe("tool_error");
    expect(result.content).toContain(reason);
    expect(seen).toEqual([]);
  });

  it.each(["-x", "a..b", "a b", "/main"])("refuses the ref %j", async (ref) => {
    const { call, seen } = setup();
    const result = await call("github__read_file", { repository: "Acme/Shop", path: "", ref });
    expect(result.outcome).toBe("tool_error");
    expect(seen).toEqual([]);
  });

  it("searches with plain terms and path qualifiers", async () => {
    const { call, seen } = setup();
    const result = await call("github__search_code", {
      repository: "Acme/Shop",
      query: "signup path:src",
    });
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("src/signup.ts");
    expect(result.content).toContain("const steps = 3");
    expect(seen).toEqual([{ op: "search", repository: "Acme/Shop", arg: "signup path:src" }]);
  });

  it.each([
    "x repo:acme/payroll",
    "x OR org:other",
    "-user:someone x",
    "(owner:x)",
    "x Enterprise:e",
  ])("refuses the query %j, which would search other repositories", async (query) => {
    const { call, seen } = setup();
    const result = await call("github__search_code", { repository: "Acme/Shop", query });
    expect(result.outcome).toBe("refused");
    expect(seen).toEqual([]);
  });

  it("cuts long results", async () => {
    const { call } = setup(
      {
        readPath: () =>
          Promise.resolve({ kind: "file", path: "big.txt", size: 500, text: "x".repeat(500) }),
      },
      { resultChars: 100 },
    );
    const result = await call("github__read_file", { repository: "Acme/Shop", path: "big.txt" });
    expect(result).toMatchObject({ outcome: "ok", truncated: true });
    expect(result.content).toHaveLength(100);
  });

  it("explains a missing installation, a rate limit, a timeout and a failure", async () => {
    const failing = (error: unknown) =>
      setup({ readPath: () => Promise.reject(error instanceof Error ? error : new Error("x")) });
    const notInstalled = await failing(new CodeReadError("not_installed", "404")).call(
      "github__read_file",
      { repository: "Acme/Shop", path: "" },
    );
    expect(notInstalled).toMatchObject({ outcome: "tool_error" });
    expect(notInstalled.content).toContain("not installed");
    const limited = await failing(new CodeReadError("rate_limited", "403")).call(
      "github__read_file",
      { repository: "Acme/Shop", path: "" },
    );
    expect(limited.content).toContain("rate limit");
    const failed = await failing(new Error("boom")).call("github__read_file", {
      repository: "Acme/Shop",
      path: "",
    });
    expect(failed).toMatchObject({ outcome: "failed" });
    expect(failed.content).not.toContain("boom");

    const slow = setup(
      {
        readPath: (_r, _q, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      },
      { callMs: 10 },
    );
    const timedOut = await slow.call("github__read_file", { repository: "Acme/Shop", path: "" });
    expect(timedOut.outcome).toBe("timeout");
  });

  it("refuses a name that is not one of its tools", async () => {
    const { call } = setup();
    expect((await call("github__delete_repo", { repository: "Acme/Shop" })).outcome).toBe(
      "refused",
    );
  });
});
