import type { Role, TenantId, UserId, WorkspaceId } from "@aep/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "../principal.ts";
import { InMemoryWorkspaceRepositories } from "./in-memory-workspace-repositories.ts";
import {
  MAX_WORKSPACE_REPOSITORIES,
  workspaceRepositoryService,
} from "./workspace-repositories.ts";

const TENANT_A = "0a000000-0000-4000-8000-000000000001" as TenantId;
const TENANT_B = "0b000000-0000-4000-8000-000000000001" as TenantId;
const WORKSPACE = "0a000000-0000-4000-8000-0000000000a1" as WorkspaceId;
const NOW = new Date("2026-11-17T00:00:00Z");
const principal = (role: Role, tenantId = TENANT_A): Principal => ({
  tenantId,
  userId: "0a000000-0000-4000-8000-0000000000aa" as UserId,
  role,
});
const shop = { owner: "acme", name: "shop" };

let repositories: InMemoryWorkspaceRepositories;
let service: ReturnType<typeof workspaceRepositoryService>;

beforeEach(() => {
  repositories = new InMemoryWorkspaceRepositories().seed(TENANT_A, WORKSPACE);
  service = workspaceRepositoryService({ repositories, now: () => NOW });
});

describe("workspaceRepositoryService", () => {
  it("lets an admin add a repository once, and audits it", async () => {
    expect(await service.add(principal("admin"), WORKSPACE, shop)).toEqual({
      ok: true,
      value: {
        added: true,
        repository: { ...shop, addedBy: principal("admin").userId, addedAt: NOW },
      },
    });
    const again = await service.add(principal("admin"), WORKSPACE, { owner: "ACME", name: "Shop" });
    expect(again).toMatchObject({ ok: true, value: { added: false, repository: shop } });
    expect(repositories.audit).toEqual([
      {
        type: "workspace.repository_added",
        actorId: principal("admin").userId,
        subjectId: null,
        payload: { workspaceId: WORKSPACE, repository: "acme/shop" },
      },
    ]);
  });

  it.each<Role>(["planner", "engineer", "viewer"])(
    "does not let a %s change them",
    async (role) => {
      expect(await service.add(principal(role), WORKSPACE, shop)).toEqual({
        ok: false,
        error: { kind: "Forbidden", action: "settings:manage" },
      });
      expect(await service.remove(principal(role), WORKSPACE, shop)).toMatchObject({ ok: false });
    },
  );

  it.each<Role>(["admin", "planner", "engineer", "viewer"])("lists them to a %s", async (role) => {
    await service.add(principal("admin"), WORKSPACE, shop);
    expect(await service.list(principal(role), WORKSPACE)).toMatchObject({
      ok: true,
      value: [shop],
    });
  });

  it.each([
    { owner: "acme", name: ".." },
    { owner: "a/b", name: "shop" },
    { owner: "acme", name: "" },
    { owner: "acme", name: "sh op" },
  ])("refuses the name %j", async (repository) => {
    expect(await service.add(principal("admin"), WORKSPACE, repository)).toMatchObject({
      ok: false,
      error: { kind: "Invalid", field: "repository" },
    });
  });

  it("answers NotFound for a workspace of another tenant", async () => {
    expect(await service.add(principal("admin", TENANT_B), WORKSPACE, shop)).toEqual({
      ok: false,
      error: { kind: "NotFound", resource: "workspace" },
    });
    expect(await service.list(principal("viewer", TENANT_B), WORKSPACE)).toMatchObject({
      ok: false,
      error: { kind: "NotFound", resource: "workspace" },
    });
  });

  it("removes a repository whatever the case, and audits it", async () => {
    await service.add(principal("admin"), WORKSPACE, shop);
    expect(
      await service.remove(principal("admin"), WORKSPACE, { owner: "Acme", name: "SHOP" }),
    ).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await service.remove(principal("admin"), WORKSPACE, shop)).toEqual({
      ok: false,
      error: { kind: "NotFound", resource: "workspace repository" },
    });
    expect(repositories.audit.map((a) => a.type)).toEqual([
      "workspace.repository_added",
      "workspace.repository_removed",
    ]);
  });

  it(`holds at most ${String(MAX_WORKSPACE_REPOSITORIES)} repositories`, async () => {
    for (let i = 0; i < MAX_WORKSPACE_REPOSITORIES; i++) {
      await service.add(principal("admin"), WORKSPACE, { owner: "acme", name: `r${String(i)}` });
    }
    expect(await service.add(principal("admin"), WORKSPACE, shop)).toMatchObject({
      ok: false,
      error: { kind: "Conflict" },
    });
  });
});
