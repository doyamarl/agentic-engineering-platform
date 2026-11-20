import { z } from "zod";

// Public HTTP contract for GET /v1/workspaces: the caller's tenant's workspaces, by name.

export const WorkspaceDto = z.object({ id: z.uuid(), name: z.string() });
export type WorkspaceDto = z.infer<typeof WorkspaceDto>;

export const WorkspaceListDto = z.object({ items: z.array(WorkspaceDto) });
export type WorkspaceListDto = z.infer<typeof WorkspaceListDto>;

// GET /v1/workspaces/:id/repositories, PUT and DELETE /v1/workspaces/:id/repositories/:owner/:name:
// the GitHub repositories the workspace's chat may read (#52). Changing them needs
// settings:manage. PUT answers 201 when it added the repository, 200 when it was already there.

export const WorkspaceRepositoryDto = z.object({
  owner: z.string(),
  name: z.string(),
  addedBy: z.uuid(),
  addedAt: z.iso.datetime(),
});
export type WorkspaceRepositoryDto = z.infer<typeof WorkspaceRepositoryDto>;

export const WorkspaceRepositoryListDto = z.object({ items: z.array(WorkspaceRepositoryDto) });
export type WorkspaceRepositoryListDto = z.infer<typeof WorkspaceRepositoryListDto>;
