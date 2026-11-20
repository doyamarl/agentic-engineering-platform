import {
  can,
  err,
  isGitHubName,
  ok,
  type Result,
  type TenantId,
  type UserId,
  type WorkspaceId,
} from "@aep/domain";
import type { AppError } from "../errors.ts";
import type { RepositoryRef } from "../git/git-port.ts";
import type { AuditEventInput } from "../members/member-ports.ts";
import type { Principal } from "../principal.ts";

// The GitHub repositories of a workspace (#52, owner decision 2026-11-17). Chat replies in the
// workspace's threads may read these repositories through the instance's GitHub App, and no
// others. Admins register them (permission settings:manage); every change is audited.

/** A workspace offers at most this many repositories to the model. */
export const MAX_WORKSPACE_REPOSITORIES = 100;

export type WorkspaceRepository = RepositoryRef & {
  readonly addedBy: UserId;
  readonly addedAt: Date;
};

/** `owner/name`. */
export const repositoryKey = (repository: RepositoryRef): string =>
  `${repository.owner}/${repository.name}`;

/** GitHub names are case-insensitive; so is the match against the registered list. */
export const sameRepository = (a: RepositoryRef, b: RepositoryRef): boolean =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

/** Every method takes tenantId; implementations scope reads and writes to it. */
export interface WorkspaceRepositories {
  /** The workspace's repositories by name, or undefined when the tenant has no such workspace. */
  list(
    tenantId: TenantId,
    workspaceId: WorkspaceId,
  ): Promise<readonly WorkspaceRepository[] | undefined>;
  /** Adds the repository and writes `audit` with it; `exists` writes nothing. */
  add(
    tenantId: TenantId,
    workspaceId: WorkspaceId,
    repository: WorkspaceRepository,
    audit: AuditEventInput,
  ): Promise<Result<"added" | "exists", { readonly kind: "WorkspaceNotFound" }>>;
  /** Removes the repository (matched case-insensitively) and writes `audit`; false if absent. */
  remove(
    tenantId: TenantId,
    workspaceId: WorkspaceId,
    repository: RepositoryRef,
    audit: AuditEventInput,
  ): Promise<boolean>;
}

const notFound = err({ kind: "NotFound", resource: "workspace" } as const);

export function workspaceRepositoryService({
  repositories,
  now,
}: {
  readonly repositories: WorkspaceRepositories;
  readonly now: () => Date;
}) {
  const invalid = (repository: RepositoryRef): AppError | undefined =>
    isGitHubName(repository.owner) && isGitHubName(repository.name)
      ? undefined
      : { kind: "Invalid", field: "repository", reason: "owner and name must be GitHub names" };
  const auditOf = (
    principal: Principal,
    type: "workspace.repository_added" | "workspace.repository_removed",
    workspaceId: WorkspaceId,
    repository: RepositoryRef,
  ): AuditEventInput => ({
    type,
    actorId: principal.userId,
    subjectId: null,
    payload: { workspaceId, repository: repositoryKey(repository) },
  });

  return {
    /** Anyone who may read missions may see which repositories the workspace's chat can read. */
    async list(
      principal: Principal,
      workspaceId: WorkspaceId,
    ): Promise<Result<readonly WorkspaceRepository[], AppError>> {
      if (!can(principal.role, "mission:read")) {
        return err({ kind: "Forbidden", action: "mission:read" });
      }
      const listed = await repositories.list(principal.tenantId, workspaceId);
      return listed === undefined ? notFound : ok(listed);
    },

    async add(
      principal: Principal,
      workspaceId: WorkspaceId,
      repository: RepositoryRef,
    ): Promise<
      Result<{ readonly added: boolean; readonly repository: WorkspaceRepository }, AppError>
    > {
      if (!can(principal.role, "settings:manage")) {
        return err({ kind: "Forbidden", action: "settings:manage" });
      }
      const problem = invalid(repository);
      if (problem !== undefined) return err(problem);
      const listed = await repositories.list(principal.tenantId, workspaceId);
      if (listed === undefined) return notFound;
      const existing = listed.find((r) => sameRepository(r, repository));
      if (existing !== undefined) return ok({ added: false, repository: existing });
      if (listed.length >= MAX_WORKSPACE_REPOSITORIES) {
        return err({
          kind: "Conflict",
          reason: `a workspace has at most ${String(MAX_WORKSPACE_REPOSITORIES)} repositories`,
        });
      }
      const row: WorkspaceRepository = {
        owner: repository.owner,
        name: repository.name,
        addedBy: principal.userId,
        addedAt: now(),
      };
      const added = await repositories.add(
        principal.tenantId,
        workspaceId,
        row,
        auditOf(principal, "workspace.repository_added", workspaceId, row),
      );
      if (!added.ok) return notFound;
      if (added.value === "added") return ok({ added: true, repository: row });
      // Added concurrently by someone else.
      const again = await repositories.list(principal.tenantId, workspaceId);
      const stored = again?.find((r) => sameRepository(r, repository)) ?? row;
      return ok({ added: false, repository: stored });
    },

    async remove(
      principal: Principal,
      workspaceId: WorkspaceId,
      repository: RepositoryRef,
    ): Promise<Result<void, AppError>> {
      if (!can(principal.role, "settings:manage")) {
        return err({ kind: "Forbidden", action: "settings:manage" });
      }
      const problem = invalid(repository);
      if (problem !== undefined) return err(problem);
      const removed = await repositories.remove(
        principal.tenantId,
        workspaceId,
        repository,
        auditOf(principal, "workspace.repository_removed", workspaceId, repository),
      );
      return removed ? ok(undefined) : err({ kind: "NotFound", resource: "workspace repository" });
    },
  };
}

export type WorkspaceRepositoryService = ReturnType<typeof workspaceRepositoryService>;
