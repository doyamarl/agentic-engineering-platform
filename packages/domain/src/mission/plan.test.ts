import { describe, expect, it } from "vitest";
import type { MissionId, TenantId } from "../ids.ts";
import { draftPlan, MAX_PLAN_LENGTH } from "./plan.ts";

const base = {
  tenantId: "0a000000-0000-4000-8000-000000000001" as TenantId,
  missionId: "0a000000-0000-4000-8000-00000000a001" as MissionId,
  version: 1,
  author: { kind: "agent", id: "claude" } as const,
  createdAt: new Date("2026-11-14T00:00:00Z"),
};

describe("draftPlan", () => {
  it("keeps a trimmed body", () => {
    expect(draftPlan({ ...base, body: "\n## Steps\n1. Add greet\n\n" })).toEqual({
      ok: true,
      value: { ...base, body: "## Steps\n1. Add greet" },
    });
  });

  it.each(["", "  \n ", "x".repeat(MAX_PLAN_LENGTH + 1)])("rejects body of length %#", (body) => {
    expect(draftPlan({ ...base, body })).toEqual({
      ok: false,
      error: { kind: "InvalidPlan", field: "body", reason: "must be 1-32000 characters" },
    });
  });

  it.each([0, -1, 1.5])("rejects version %j", (version) => {
    expect(draftPlan({ ...base, version, body: "x" })).toMatchObject({
      ok: false,
      error: { field: "version" },
    });
  });
});
