import type { Role, TenantId, UserId, WorkspaceId } from "@aep/domain";
import { describe, expect, it } from "vitest";
import type { Principal } from "../principal.ts";
import { workspaceService, type Workspace, type WorkspaceDirectory } from "./workspace-service.ts";

const TENANT_A = "0a000000-0000-4000-8000-000000000001" as TenantId;
const TENANT_B = "0b000000-0000-4000-8000-000000000001" as TenantId;
const GROWTH = { id: "0a000000-0000-4000-8000-0000000000a1" as WorkspaceId, name: "Growth" };
const OTHER = { id: "0b000000-0000-4000-8000-0000000000b1" as WorkspaceId, name: "Other" };

const directory: WorkspaceDirectory = {
  list: (tenantId) => Promise.resolve(tenantId === TENANT_A ? [GROWTH] : [OTHER]),
};
const principal = (role: Role, tenantId = TENANT_A): Principal => ({
  tenantId,
  userId: "0a000000-0000-4000-8000-0000000000aa" as UserId,
  role,
});

describe("workspaceService.list", () => {
  const service = workspaceService({ workspaces: directory });

  it.each<Role>(["admin", "planner", "engineer", "viewer"])(
    "lists the tenant's workspaces to a %s",
    async (role) => {
      expect(await service.list(principal(role))).toEqual({
        ok: true,
        value: [GROWTH] satisfies Workspace[],
      });
    },
  );

  it("asks for the principal's own tenant only", async () => {
    expect(await service.list(principal("viewer", TENANT_B))).toEqual({ ok: true, value: [OTHER] });
  });
});
