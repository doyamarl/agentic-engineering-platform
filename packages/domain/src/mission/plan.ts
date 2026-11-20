import type { MissionId, TenantId } from "../ids.ts";
import { err, ok, type Result } from "../result.ts";
import type { Actor } from "./state-machine.ts";

// A mission's plan (PRD FR-01, FR-07). Each submission is a new, immutable version; approval
// names the version it approves, so a later version needs its own approval.

/** Bounds what an agent can put in front of a reviewer and into the execution prompt. */
export const MAX_PLAN_LENGTH = 32_000;

export type Plan = {
  readonly tenantId: TenantId;
  readonly missionId: MissionId;
  /** 1, 2, ... per mission. */
  readonly version: number;
  /** Markdown. */
  readonly body: string;
  readonly author: Actor & { readonly id?: string };
  readonly createdAt: Date;
};

export type InvalidPlan = {
  readonly kind: "InvalidPlan";
  readonly field: "body" | "version";
  readonly reason: string;
};

export function draftPlan(input: Plan): Result<Plan, InvalidPlan> {
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    return err({ kind: "InvalidPlan", field: "version", reason: "must be a positive integer" });
  }
  const body = input.body.trim();
  if (body.length === 0 || body.length > MAX_PLAN_LENGTH) {
    return err({
      kind: "InvalidPlan",
      field: "body",
      reason: `must be 1-${String(MAX_PLAN_LENGTH)} characters`,
    });
  }
  return ok({ ...input, body });
}
