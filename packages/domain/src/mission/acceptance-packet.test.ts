import { describe, expect, it } from "vitest";
import type { MissionId, TenantId, UserId } from "../ids.ts";
import { buildAcceptancePacket, planSection, type PacketInput } from "./acceptance-packet.ts";

const PLAN = [
  "## Summary",
  "Add slugify.",
  "",
  "## Acceptance criteria",
  "- `node --test` passes",
  "- README mentions slugify",
  "",
  "## Risks and assumptions",
  "- ASCII only",
].join("\n");

const input: PacketInput = {
  tenantId: "0a000000-0000-4000-8000-000000000001" as TenantId,
  missionId: "0a000000-0000-4000-8000-00000000a001" as MissionId,
  version: 1,
  createdAt: new Date("2026-11-14T10:00:00Z"),
  title: "Slugify",
  source: { kind: "github_issue", owner: "acme", repo: "shop", issueNumber: 4, baseBranch: "main" },
  plan: { version: 2, checksumSha256: "a".repeat(64), body: PLAN },
  decisions: [
    {
      planVersion: 1,
      decision: "rejected",
      decidedBy: "0a000000-0000-4000-8000-0000000000aa" as UserId,
      decidedAt: new Date("2026-11-14T09:00:00Z"),
      comment: "add tests",
    },
    {
      planVersion: 2,
      decision: "approved",
      decidedBy: "0a000000-0000-4000-8000-0000000000aa" as UserId,
      decidedAt: new Date("2026-11-14T09:30:00Z"),
      comment: null,
    },
  ],
  pullRequest: {
    number: 5,
    url: "https://github.com/acme/shop/pull/5",
    branch: "aep/m",
    commitSha: "b".repeat(40),
  },
  files: {
    files: [
      { path: "src/slugify.js", additions: 8, deletions: 0 },
      { path: "README.md", additions: 8, deletions: 2 },
    ],
    truncated: false,
  },
  checks: [{ name: "node-test", state: "success", url: "https://ci/1" }],
  costUsd: 0.1,
};

describe("planSection", () => {
  it("returns a section's body up to the next heading", () => {
    expect(planSection(PLAN, "Acceptance criteria")).toBe(
      "- `node --test` passes\n- README mentions slugify",
    );
    expect(planSection(PLAN, "risks and assumptions")).toBe("- ASCII only");
    expect(planSection(PLAN, "Changes")).toBeNull();
    expect(planSection("## Changes\n\n## Summary\nx", "Changes")).toBeNull();
  });

  it("keeps deeper headings inside the section", () => {
    expect(planSection("## Changes\n### a.js\nedit\n## Next", "Changes")).toBe("### a.js\nedit");
  });
});

describe("buildAcceptancePacket", () => {
  it("gathers the plan, approvals, pull request, diff, CI and cost", () => {
    const packet = buildAcceptancePacket(input);
    expect(packet.content).toEqual({
      schemaVersion: 1,
      mission: { id: input.missionId, title: "Slugify" },
      source: input.source,
      plan: {
        version: 2,
        checksumSha256: "a".repeat(64),
        acceptanceCriteria: "- `node --test` passes\n- README mentions slugify",
        risks: "- ASCII only",
      },
      approvals: [
        {
          subject: "plan",
          version: 1,
          decision: "rejected",
          decidedBy: "0a000000-0000-4000-8000-0000000000aa",
          decidedAt: "2026-11-14T09:00:00.000Z",
          comment: "add tests",
        },
        {
          subject: "plan",
          version: 2,
          decision: "approved",
          decidedBy: "0a000000-0000-4000-8000-0000000000aa",
          decidedAt: "2026-11-14T09:30:00.000Z",
          comment: null,
        },
      ],
      pullRequest: input.pullRequest,
      diff: { files: input.files.files, additions: 16, deletions: 2, truncated: false },
      ci: { state: "success", checks: input.checks },
      costUsd: 0.1,
      residualRisks: [
        "The plan's acceptance criteria have not been checked against the change automatically.",
      ],
    });
    expect(packet).toMatchObject({ version: 1, createdAt: input.createdAt });
  });

  it("says when no CI ran, checks were skipped, criteria are missing or the diff is cut", () => {
    const packet = buildAcceptancePacket({
      ...input,
      checks: [],
      plan: { ...input.plan, body: "## Summary\nx" },
      files: { ...input.files, truncated: true },
    });
    expect(packet.content.ci).toEqual({ state: "none", checks: [] });
    expect(packet.content.residualRisks).toEqual([
      "No CI result was reported for the pull request's commit, so no tests ran on it.",
      "The approved plan has no acceptance criteria.",
      "The pull request changes more files than the 2 listed.",
    ]);
    const skipped = buildAcceptancePacket({
      ...input,
      checks: [...input.checks, { name: "docs", state: "neutral", url: null }],
    });
    expect(skipped.content.residualRisks[0]).toBe(
      "These checks finished without passing (skipped or neutral): docs.",
    );
  });

  it.each(["pending", "failure"] as const)("refuses %s CI", (state) => {
    expect(() =>
      buildAcceptancePacket({ ...input, checks: [{ name: "node-test", state, url: null }] }),
    ).toThrow(/needs passing CI/);
  });
});
