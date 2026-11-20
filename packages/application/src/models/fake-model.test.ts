import { describe, expect, it } from "vitest";
import { fakeModel } from "./fake-model.ts";
import { modelPortContract, type ModelScenario } from "./model-port-contract.ts";
import { ModelCallError, type ModelStreamEvent } from "./model-port.ts";

const finish = (stopReason: "end_turn" | "refusal" | "max_tokens" | "tool_use") =>
  ({
    type: "finished",
    stopReason,
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "fake-echo",
  }) as const;

const SCRIPTS: Record<ModelScenario, () => readonly ModelStreamEvent[]> = {
  replies: () => [
    { type: "text_delta", text: "Hello, " },
    { type: "text_delta", text: "world" },
    finish("end_turn"),
  ],
  "calls-tool": () => [
    { type: "tool_call", id: "call_1", name: "lookup", input: { q: "signup" } },
    finish("tool_use"),
  ],
  refuses: () => [finish("refusal")],
  "hits-max-tokens": () => [{ type: "text_delta", text: "Partial" }, finish("max_tokens")],
  hangs: () => [{ type: "text_delta", text: "never" }],
  overloaded: () => {
    throw new ModelCallError("overloaded", { retryable: true });
  },
  rejects: () => {
    throw new ModelCallError("invalid request", { retryable: false });
  },
};

modelPortContract("fakeModel", () => {
  let scenario: ModelScenario = "replies";
  return {
    port: fakeModel({
      script: () => SCRIPTS[scenario](),
      delayMs: () => (scenario === "hangs" ? 60_000 : 0),
    }),
    arrange(next) {
      scenario = next;
    },
  };
});

describe("fakeModel", () => {
  it("echoes the last user message by default", async () => {
    let text = "";
    for await (const event of fakeModel().stream(
      { messages: [{ role: "user", content: "Why did signups drop?" }] },
      new AbortController().signal,
    )) {
      if (event.type === "text_delta") text += event.text;
    }
    expect(text).toBe("Fake reply to: Why did signups drop?");
  });
});
