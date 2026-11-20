// Role-based permissions within one tenant. Tenant membership is checked separately: a principal
// can only ever act on its own tenant, whatever its role.

export const ROLES = ["admin", "planner", "engineer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  "mission:create",
  "mission:read",
  "mission:plan",
  "mission:cancel",
  "mission:retry",
  "plan:approve",
  "release:approve",
  "member:manage",
  "token:issue",
  "thread:read",
  "thread:write",
  "settings:manage",
  "connector:use",
  "connector:manage",
] as const;
export type Action = (typeof ACTIONS)[number];

const OPERATE: readonly Action[] = [
  "mission:create",
  "mission:read",
  "mission:plan",
  "mission:cancel",
  "mission:retry",
  "thread:read",
  "thread:write",
  // Personal connections to outside tools (ADR-013); viewers neither post nor call tools.
  "connector:use",
];
const APPROVE: readonly Action[] = ["plan:approve", "release:approve"];
const ADMINISTER: readonly Action[] = [
  "member:manage",
  "token:issue",
  "settings:manage",
  // See who is connected to what (never a token) and disconnect anyone.
  "connector:manage",
];

const GRANTS: ReadonlyMap<Role, ReadonlySet<Action>> = new Map([
  ["admin", new Set([...OPERATE, ...APPROVE, ...ADMINISTER])],
  ["planner", new Set([...OPERATE, ...APPROVE])],
  ["engineer", new Set(OPERATE)],
  ["viewer", new Set<Action>(["mission:read", "thread:read"])],
]);

export const can = (role: Role, action: Action): boolean => GRANTS.get(role)?.has(action) ?? false;

export const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);
