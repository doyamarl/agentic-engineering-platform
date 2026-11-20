import { describe, expect, it } from "vitest";
import type { MissionId, TenantId, UserId, WorkspaceId } from "../ids.ts";
import { draftMission } from "./mission.ts";

const base = {
  tenantId: "0a000000-0000-4000-8000-000000000001" as TenantId,
  workspaceId: "0a000000-0000-4000-8000-0000000000a1" as WorkspaceId,
  id: "0a000000-0000-4000-8000-00000000a001" as MissionId,
  createdBy: "0a000000-0000-4000-8000-0000000000aa" as UserId,
  createdAt: new Date("2026-11-13T00:00:00Z"),
};

describe("draftMission", () => {
  it("starts in DRAFT at version 1 with a trimmed title", () => {
    expect(draftMission({ ...base, title: "  Improve signup  " })).toEqual({
      ok: true,
      value: { ...base, title: "Improve signup", state: { status: "DRAFT" }, version: 1 },
    });
  });

  it.each(["", "   ", "x".repeat(201)])("rejects title %j", (title) => {
    expect(draftMission({ ...base, title })).toEqual({
      ok: false,
      error: { kind: "InvalidMission", field: "title", reason: "must be 1-200 characters" },
    });
  });

  const source = {
    kind: "github_issue" as const,
    owner: "acme",
    repo: "shop",
    issueNumber: 12,
    baseBranch: "main",
  };

  it("keeps a valid GitHub issue source", () => {
    const drafted = draftMission({ ...base, title: "Fix", source });
    expect(drafted.ok && drafted.value.source).toEqual(source);
  });

  it.each([
    { owner: "../x" },
    { repo: "" },
    { issueNumber: 0 },
    { issueNumber: 1.5 },
    { baseBranch: "" },
    { baseBranch: "--upload-pack=x" },
    { baseBranch: "a b" },
  ])("rejects source %j", (bad) => {
    const drafted = draftMission({ ...base, title: "Fix", source: { ...source, ...bad } });
    expect(drafted.ok ? undefined : drafted.error.field).toBe("source");
  });
});
