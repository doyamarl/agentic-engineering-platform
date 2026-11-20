import type { MissionId, TenantId } from "@aep/domain";
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentPort, AgentTask } from "./agent-port.ts";
import { agentPortContract } from "./agent-port-contract.ts";
import { createAgentPort, type ProviderEvent } from "./create-agent-port.ts";
import { scriptedAgent } from "./scripted-agent.ts";

agentPortContract("scriptedAgent", () => scriptedAgent());

const context = {
  tenantId: "0a000000-0000-4000-8000-000000000001" as TenantId,
  missionId: "0a000000-0000-4000-8000-0000000000c1" as MissionId,
};
const task: AgentTask = {
  prompt: "p",
  workdir: "/w",
  requires: new Set(),
  limits: { wallClockMs: 10_000, maxBudgetUsd: 1 },
};

async function runOnce(port: AgentPort): Promise<AgentEvent[]> {
  const started = await port.start(task, context);
  if (!started.ok) throw new Error("start failed");
  const events: AgentEvent[] = [];
  for await (const e of port.events(started.value)) events.push(e);
  return events;
}

describe("createAgentPort", () => {
  it("finishes a cancelled session even if the provider ignores the abort signal", async () => {
    let release: () => void = () => undefined;
    const port = createAgentPort({
      provider: "stubborn",
      capabilities: new Set(),
      model: null,
      secrets: [],
      async *launch(): AsyncGenerator<ProviderEvent> {
        yield { type: "text", text: "x" };
        await new Promise<void>((r) => (release = r)); // never looks at the signal
      },
    });
    const started = await port.start(task, context);
    if (!started.ok) throw new Error("start failed");
    const events: AgentEvent[] = [];
    for await (const e of port.events(started.value)) {
      events.push(e);
      if (e.type === "text") await port.cancel(started.value);
    }
    release();
    expect(events.at(-1)).toEqual({
      type: "finished",
      outcome: { kind: "cancelled" },
      usage: null,
    });
  });

  it("closes the provider stream after its result, before finishing", async () => {
    let cleanedUp = false;
    const port = createAgentPort({
      provider: "tidy",
      capabilities: new Set(),
      model: null,
      secrets: [],
      async *launch(): AsyncGenerator<ProviderEvent> {
        try {
          await Promise.resolve();
          yield { type: "result", outcome: { kind: "succeeded", summary: "" }, usage: null };
          yield { type: "text", text: "never consumed" };
        } finally {
          cleanedUp = true;
        }
      },
    });
    const events = await runOnce(port);
    expect(cleanedUp).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["started", "finished"]);
  });

  it("reports a provider that ends without a result as a provider error", async () => {
    const port = createAgentPort({
      provider: "silent",
      capabilities: new Set(),
      model: null,
      secrets: [],
      async *launch(): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield { type: "text", text: "x" };
      },
    });
    expect((await runOnce(port)).at(-1)).toMatchObject({
      type: "finished",
      outcome: {
        kind: "failed",
        reason: "provider_error",
        detail: "provider ended without a result",
      },
    });
  });

  it("redacts secrets in failure details and ignores empty secrets", async () => {
    const port = createAgentPort({
      provider: "leaky",
      capabilities: new Set(),
      model: null,
      secrets: ["", "s3cret"],
      async *launch(): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield { type: "text", text: "plain" };
        throw new Error("bad key s3cret");
      },
    });
    const events = await runOnce(port);
    expect(events[1]).toEqual({ type: "text", text: "plain" });
    expect(events.at(-1)).toMatchObject({
      outcome: { kind: "failed", detail: "Error: bad key [REDACTED]" },
    });
  });
});
