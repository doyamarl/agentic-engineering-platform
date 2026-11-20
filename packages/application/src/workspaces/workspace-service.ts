import { can, err, ok, type Result, type TenantId, type WorkspaceId } from "@aep/domain";
import type { AppError } from "../errors.ts";
import type { Principal } from "../principal.ts";

export type Workspace = { readonly id: WorkspaceId; readonly name: string };

/** Implementations must return only `tenantId`'s workspaces. */
export interface WorkspaceDirectory {
  list(tenantId: TenantId): Promise<readonly Workspace[]>;
}

export function workspaceService({ workspaces }: { readonly workspaces: WorkspaceDirectory }) {
  return {
    /** Anyone who may read missions may see where they live. */
    async list(principal: Principal): Promise<Result<readonly Workspace[], AppError>> {
      if (!can(principal.role, "mission:read")) {
        return err({ kind: "Forbidden", action: "mission:read" });
      }
      return ok(await workspaces.list(principal.tenantId));
    },
  };
}

export type WorkspaceService = ReturnType<typeof workspaceService>;
