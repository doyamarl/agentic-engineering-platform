import type { MissionId, TenantId } from "@aep/domain";
import { describe, expect, it } from "vitest";
import {
  AGENT_CAPABILITIES,
  type AgentCapability,
  type AgentEvent,
  type AgentPort,
  type AgentTask,
  type ExecutionContext,
} from "./agent-port.ts";

/** Provider behaviours every adapter must translate into the AgentPort contract. */
export type AgentScenario =
  /** Streams text and a tool call, then completes. */
  | "succeeds"
  /** Never completes on its own. */
  | "hangs"
  /** Streams text that contains the adapter's credential, then completes. */
  | "echoes-credential"
  /** Rejects the credential. */
  | "fails-auth"
  /** Stops because the spend limit was reached. */
  | "exceeds-budget"
  /** The provider stream throws midway. */
  | "crashes";

export type AgentPortHarness = {
  readonly port: AgentPort;
  /** The secret the adapter authenticates with; no event may contain it. */
  readonly credential: string;
  /** Makes the next session started on `port` behave as described. */
  arrange(scenario: AgentScenario): void;
};

const context: ExecutionContext = {
  tenantId: "0a000000-0000-4000-8000-000000000001" as TenantId,
  missionId: "0a000000-0000-4000-8000-0000000000c1" as MissionId,
};

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  prompt: "Add a README line.",
  workdir: "/nonexistent/aep-contract",
  requires: new Set(),
  limits: { wallClockMs: 10_000, maxBudgetUsd: 1 },
  ...overrides,
});

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function expectWellFormed(
  events: readonly AgentEvent[],
): Extract<AgentEvent, { type: "finished" }> {
  expect(events[0]?.type).toBe("started");
  expect(events.filter((e) => e.type === "finished")).toHaveLength(1);
  const last = events.at(-1);
  if (last?.type !== "finished") throw new Error(`last event is ${String(last?.type)}`);
  return last;
}

/** Registers the AgentPort contract tests for one adapter. `name` labels the suite. */
export function agentPortContract(name: string, makeHarness: () => AgentPortHarness): void {
  describe(`AgentPort contract: ${name}`, () => {
    async function run(scenario: AgentScenario, overrides: Partial<AgentTask> = {}) {
      const h = makeHarness();
      h.arrange(scenario);
      const started = await h.port.start(task(overrides), context);
      if (!started.ok) throw new Error(`start failed: ${JSON.stringify(started.error)}`);
      return { h, session: started.value, events: collect(h.port.events(started.value)) };
    }

    it("offers only known capabilities", async () => {
      const offered = await makeHarness().port.capabilities();
      for (const c of offered) expect(AGENT_CAPABILITIES).toContain(c);
    });

    it("rejects a task that needs a capability it does not offer", async () => {
      const { port } = makeHarness();
      const offered = await port.capabilities();
      const absent = AGENT_CAPABILITIES.filter((c) => !offered.has(c));
      for (const c of absent) {
        const result = await port.start(task({ requires: new Set<AgentCapability>([c]) }), context);
        expect(result).toEqual({
          ok: false,
          error: { kind: "UnsupportedCapability", missing: [c] },
        });
      }
    });

    it("streams started, text and tool calls, then exactly one final success with usage", async () => {
      const events = await (await run("succeeds")).events;
      const finished = expectWellFormed(events);
      expect(events.some((e) => e.type === "text")).toBe(true);
      expect(events.some((e) => e.type === "tool_call")).toBe(true);
      expect(finished.outcome.kind).toBe("succeeded");
      expect(finished.usage).not.toBeNull();
    });

    it("ends a running session as cancelled, and cancel is idempotent", async () => {
      const { h, session, events } = await run("hangs");
      await h.port.cancel(session);
      await h.port.cancel(session);
      expect(expectWellFormed(await events).outcome).toEqual({ kind: "cancelled" });
      await h.port.cancel(session);
    });

    it("ends a session that exceeds its wall-clock limit as timed_out", async () => {
      const { events } = await run("hangs", { limits: { wallClockMs: 50, maxBudgetUsd: 1 } });
      expect(expectWellFormed(await events).outcome).toEqual({ kind: "timed_out" });
    });

    it.each([
      ["fails-auth", "auth"],
      ["exceeds-budget", "budget_exceeded"],
      ["crashes", "provider_error"],
    ] as const)("maps %s to a final failed/%s event", async (scenario, reason) => {
      const finished = expectWellFormed(await (await run(scenario)).events);
      expect(finished.outcome).toMatchObject({ kind: "failed", reason });
    });

    it("never emits its credential", async () => {
      const { h, events } = await run("echoes-credential");
      const all = await events;
      expectWellFormed(all);
      expect(JSON.stringify(all)).not.toContain(h.credential);
    });

    it("allows one consumer per session and rejects unknown sessions", async () => {
      const { h, session, events } = await run("succeeds");
      await expect(collect(h.port.events(session))).rejects.toThrow();
      await events;
      await expect(collect(h.port.events({ ...session, id: "unknown" }))).rejects.toThrow();
    });
  });
}
