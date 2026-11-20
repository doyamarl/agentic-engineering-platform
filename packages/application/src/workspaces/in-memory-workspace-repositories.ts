import { err, ok, type TenantId, type WorkspaceId } from "@aep/domain";
import type { AuditEventInput } from "../members/member-ports.ts";
import {
  sameRepository,
  type WorkspaceRepositories,
  type WorkspaceRepository,
} from "./workspace-repositories.ts";

// In-memory WorkspaceRepositories for tests. Same rules as the Postgres adapter: a workspace of
// another tenant does not exist.

export class InMemoryWorkspaceRepositories implements WorkspaceRepositories {
  readonly #rows = new Map<string, WorkspaceRepository[]>();
  readonly audit: AuditEventInput[] = [];

  /** Makes the workspace exist, with these repositories. */
  seed(
    tenantId: TenantId,
    workspaceId: WorkspaceId,
    repositories: readonly WorkspaceRepository[] = [],
  ): this {
    this.#rows.set(`${tenantId}/${workspaceId}`, [...repositories]);
    return this;
  }

  list(tenantId: TenantId, workspaceId: WorkspaceId) {
    const rows = this.#rows.get(`${tenantId}/${workspaceId}`);
    return Promise.resolve(rows === undefined ? undefined : [...rows]);
  }

  add(
    tenantId: TenantId,
    workspaceId: WorkspaceId,
    repository: WorkspaceRepository,
    audit: AuditEventInput,
  ) {
    const rows = this.#rows.get(`${tenantId}/${workspaceId}`);
    if (rows === undefined) return Promise.resolve(err({ kind: "WorkspaceNotFound" } as const));
    if (rows.some((r) => sameRepository(r, repository)))
      return Promise.resolve(ok("exists" as const));
    rows.push(repository);
    this.audit.push(audit);
    return Promise.resolve(ok("added" as const));
  }

  remove(
    tenantId: TenantId,
    workspaceId: WorkspaceId,
    repository: { readonly owner: string; readonly name: string },
    audit: AuditEventInput,
  ) {
    const rows = this.#rows.get(`${tenantId}/${workspaceId}`);
    const at = rows?.findIndex((r) => sameRepository(r, repository)) ?? -1;
    if (rows === undefined || at < 0) return Promise.resolve(false);
    rows.splice(at, 1);
    this.audit.push(audit);
    return Promise.resolve(true);
  }
}
