// Prompts are copied verbatim from docs/04_AGENT_BENCHMARK.md §3.
// tasks.test.ts fails if the two drift apart.

export const TASK_IDS = ["B1", "B2", "B3", "B4", "B5"] as const;
export type TaskId = (typeof TASK_IDS)[number];

export const COMMON_SUFFIX =
  "Work only inside this repository. Do not modify `.github/`, `docs/`, `mise.toml`, root tooling config (`eslint.config.js`, `.prettierrc.json`, `tsconfig*.json`, `.dependency-cruiser.cjs`), or existing migrations. Adding dependencies to a package is allowed. Add new migrations if you need schema changes. Write tests first. Finish only when `pnpm verify` passes, then summarize what you changed.";

const PROMPTS: Record<TaskId, string> = {
  B1: "Add `POST /v1/missions/:id/cancel`. It applies the `Cancel` command of the mission state machine (`packages/domain/src/mission/state-machine.ts`) as the authenticated principal, persists the new state with optimistic concurrency (`missions.version` must match and increments by 1), and returns the updated mission. Callers need the `mission:cancel` permission.",
  B2: "Add `GET /v1/workspaces` that lists the workspaces of the principal's tenant, with its request/response schema in `packages/contracts`. Every member role may call it.",
  B3: 'When a mission is created, append a `MissionCreated` event to `mission_events` in the same database transaction as the mission row: `seq` 1, `actor_kind` `human`, `actor_id` the creating user, payload `{ "title": <title> }`.',
  B4: 'On the web home page (`apps/web/app/page.tsx`), show the API health check\'s response time in milliseconds next to the reachability status. A request slower than 2 seconds shows "timeout". Add unit tests for `fetchApiStatus` covering success, a non-200 response and a timeout, using a stubbed `fetch`.',
  B5: "`MissionDto.status` in `packages/contracts` is `z.string()`. Make it an enum of exactly the mission statuses of the domain state machine, and add a test that fails if the domain and the contract ever disagree.",
};

export function taskPrompt(id: TaskId): string {
  return PROMPTS[id];
}

export function buildPrompt(id: TaskId): string {
  return `${PROMPTS[id]}\n\n${COMMON_SUFFIX}`;
}

export function isTaskId(value: string): value is TaskId {
  return (TASK_IDS as readonly string[]).includes(value);
}
