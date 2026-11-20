import { describe, expect, it } from "vitest";
import { ACTIONS, ROLES, can, type Action, type Role } from "./permissions.ts";

// The full matrix is spelled out so any change to who-can-do-what shows up in review as a diff
// to this table. Personas: docs/01_PRD.md §3.
const EXPECTED: Record<Role, readonly Action[]> = {
  admin: [
    "mission:create",
    "mission:read",
    "mission:plan",
    "mission:cancel",
    "mission:retry",
    "thread:read",
    "thread:write",
    "connector:use",
    "plan:approve",
    "release:approve",
    "member:manage",
    "token:issue",
    "settings:manage",
    "connector:manage",
  ],
  planner: [
    "mission:create",
    "mission:read",
    "mission:plan",
    "mission:cancel",
    "mission:retry",
    "thread:read",
    "thread:write",
    "connector:use",
    "plan:approve",
    "release:approve",
  ],
  engineer: [
    "mission:create",
    "mission:read",
    "mission:plan",
    "mission:cancel",
    "mission:retry",
    "thread:read",
    "thread:write",
    "connector:use",
  ],
  viewer: ["mission:read", "thread:read"],
};

describe("permission matrix", () => {
  const cells = ROLES.flatMap((role) => ACTIONS.map((action) => [role, action] as const));

  it.each(cells)("%s → %s", (role, action) => {
    expect(can(role, action)).toBe(EXPECTED[role].includes(action));
  });

  it("denies roles and actions it does not know (deny by default)", () => {
    expect(can("owner" as Role, "mission:read")).toBe(false);
    expect(can("admin", "mission:delete" as Action)).toBe(false);
  });
});
