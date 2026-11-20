import type { MissionId, TenantId, UserId, WorkspaceId } from "../ids.ts";
import { err, ok, type Result } from "../result.ts";
import { initialMissionState, type MissionState } from "./state-machine.ts";

/** Where the work comes from. Sprint 2 supports GitHub issues only. */
export type MissionSource = {
  readonly kind: "github_issue";
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  /** Branch the work starts from and the pull request targets. */
  readonly baseBranch: string;
};

export type Mission = {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
  readonly id: MissionId;
  readonly title: string;
  readonly source?: MissionSource;
  readonly state: MissionState;
  /** Optimistic-concurrency version; incremented by every persisted state change. */
  readonly version: number;
  readonly createdBy: UserId;
  readonly createdAt: Date;
};

export type InvalidMission = {
  readonly kind: "InvalidMission";
  readonly field: "title" | "source";
  readonly reason: string;
};

export const MAX_TITLE_LENGTH = 200;

const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** A GitHub owner or repository name, safe to put in an API path. */
export const isGitHubName = (name: string): boolean =>
  GITHUB_NAME.test(name) && name !== "." && name !== "..";

function sourceProblem(source: MissionSource): string | undefined {
  for (const name of [source.owner, source.repo]) {
    if (!isGitHubName(name)) {
      return "owner and repo must be GitHub names";
    }
  }
  if (!Number.isSafeInteger(source.issueNumber) || source.issueNumber < 1) {
    return "issueNumber must be a positive integer";
  }
  const branch = source.baseBranch;
  if (branch.length === 0 || branch.length > 255 || branch.startsWith("-") || /\s/.test(branch)) {
    return "baseBranch must be a branch name";
  }
  return undefined;
}

export function draftMission(input: {
  tenantId: TenantId;
  workspaceId: WorkspaceId;
  id: MissionId;
  title: string;
  source?: MissionSource;
  createdBy: UserId;
  createdAt: Date;
}): Result<Mission, InvalidMission> {
  const title = input.title.trim();
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    return err({ kind: "InvalidMission", field: "title", reason: "must be 1-200 characters" });
  }
  if (input.source !== undefined) {
    const reason = sourceProblem(input.source);
    if (reason !== undefined) return err({ kind: "InvalidMission", field: "source", reason });
  }
  return ok({ ...input, title, state: initialMissionState(), version: 1 });
}
