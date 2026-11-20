import type { AgentCapability, AgentPort } from "./agent-port.ts";
import type { AgentPortHarness, AgentScenario } from "./agent-port-contract.ts";
import { createAgentPort, type ProviderEvent } from "./create-agent-port.ts";

const USAGE = { inputTokens: 100, outputTokens: 10, costUsd: 0.001 };

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else
      signal.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted"));
        },
        { once: true },
      );
  });
}

async function* script(
  scenario: AgentScenario,
  credential: string,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  switch (scenario) {
    case "succeeds":
      yield { type: "text", text: "Editing README." };
      yield { type: "tool_call", tool: "Edit" };
      yield { type: "result", outcome: { kind: "succeeded", summary: "Done." }, usage: USAGE };
      return;
    case "hangs":
      yield { type: "text", text: "Thinking." };
      await waitForAbort(signal);
      return;
    case "echoes-credential":
      yield { type: "text", text: `The key is ${credential}.` };
      yield {
        type: "result",
        outcome: { kind: "succeeded", summary: `Used ${credential}` },
        usage: USAGE,
      };
      return;
    case "fails-auth":
      yield {
        type: "result",
        outcome: { kind: "failed", reason: "auth", detail: "invalid credential" },
        usage: null,
      };
      return;
    case "exceeds-budget":
      yield { type: "text", text: "Working." };
      yield {
        type: "result",
        outcome: { kind: "failed", reason: "budget_exceeded", detail: "budget reached" },
        usage: USAGE,
      };
      return;
    case "crashes":
      yield { type: "text", text: "Working." };
      throw new Error("provider process exited with code 1");
  }
}

/**
 * In-memory AgentPort that plays a scripted scenario per session. It is the reference
 * implementation of the contract and a test double for code that drives agents.
 */
export function scriptedAgent(
  options: { readonly capabilities?: ReadonlySet<AgentCapability> } = {},
): AgentPortHarness & { readonly port: AgentPort } {
  const credential = "scripted-agent-credential-6f1c";
  const queue: AgentScenario[] = [];
  const port = createAgentPort({
    provider: "scripted",
    capabilities: options.capabilities ?? new Set(["streaming"]),
    model: "scripted-model",
    secrets: [credential],
    launch: (_task, _context, signal) => script(queue.shift() ?? "succeeds", credential, signal),
  });
  return {
    port,
    credential,
    arrange: (scenario) => {
      queue.push(scenario);
    },
  };
}
