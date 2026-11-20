import { describe, expect, it } from "vitest";
import { ModelCallError, type ModelPort, type ModelStreamEvent } from "./model-port.ts";

// Behaviour every ModelPort adapter must show (ADR §10: ports have contract tests across all
// adapters). Each harness fakes its provider and arranges one scenario per call.

export type ModelScenario =
  /** Replies "Hello, world" in more than one delta. */
  | "replies"
  /** Calls the tool `lookup` with input {"q": "signup"}. */
  | "calls-tool"
  /** Declines the request. */
  | "refuses"
  /** Stops at the output limit after "Partial". */
  | "hits-max-tokens"
  /** Never finishes on its own. */
  | "hangs"
  /** Answers that it is overloaded. */
  | "overloaded"
  /** Rejects the request as invalid. */
  | "rejects";

export type ModelPortHarness = {
  readonly port: ModelPort;
  arrange(scenario: ModelScenario): void;
};

const request = {
  system: "Be brief.",
  messages: [{ role: "user", content: "Say hello" }],
  tools: [
    {
      name: "lookup",
      description: "Looks a term up.",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    },
  ],
} as const;

async function collect(port: ModelPort, signal = new AbortController().signal) {
  const events: ModelStreamEvent[] = [];
  for await (const event of port.stream(request, signal)) events.push(event);
  return events;
}

function finished(events: readonly ModelStreamEvent[]) {
  expect(events.filter((event) => event.type === "finished")).toHaveLength(1);
  const last = events.at(-1);
  if (last?.type !== "finished") throw new Error(`last event is ${String(last?.type)}`);
  return last;
}

const text = (events: readonly ModelStreamEvent[]) =>
  events.map((event) => (event.type === "text_delta" ? event.text : "")).join("");

export function modelPortContract(name: string, makeHarness: () => ModelPortHarness): void {
  describe(`${name} satisfies the ModelPort contract`, () => {
    it("streams text in deltas and finishes last, once", async () => {
      const harness = makeHarness();
      const { port } = harness;
      const arrange = (scenario: ModelScenario) => {
        harness.arrange(scenario);
      };
      arrange("replies");
      const events = await collect(port);
      expect(events.filter((event) => event.type === "text_delta").length).toBeGreaterThan(1);
      expect(text(events)).toBe("Hello, world");
      const end = finished(events);
      expect(end.stopReason).toBe("end_turn");
      expect(end.model).not.toBe("");
      expect(end.usage.outputTokens).toBeGreaterThanOrEqual(0);
    });

    it("reports a complete tool call and stops for it", async () => {
      const harness = makeHarness();
      const { port } = harness;
      const arrange = (scenario: ModelScenario) => {
        harness.arrange(scenario);
      };
      arrange("calls-tool");
      const events = await collect(port);
      expect(events.filter((event) => event.type === "tool_call")).toEqual([
        {
          type: "tool_call",
          id: expect.any(String) as string,
          name: "lookup",
          input: { q: "signup" },
        },
      ]);
      expect(finished(events).stopReason).toBe("tool_use");
    });

    it("reports a refusal as a stop reason, not an error", async () => {
      const harness = makeHarness();
      const { port } = harness;
      const arrange = (scenario: ModelScenario) => {
        harness.arrange(scenario);
      };
      arrange("refuses");
      expect(finished(await collect(port)).stopReason).toBe("refusal");
    });

    it("keeps the text when it stops at the output limit", async () => {
      const harness = makeHarness();
      const { port } = harness;
      const arrange = (scenario: ModelScenario) => {
        harness.arrange(scenario);
      };
      arrange("hits-max-tokens");
      const events = await collect(port);
      expect(text(events)).toBe("Partial");
      expect(finished(events).stopReason).toBe("max_tokens");
    });

    it("ends with an error when aborted", async () => {
      const harness = makeHarness();
      const { port } = harness;
      const arrange = (scenario: ModelScenario) => {
        harness.arrange(scenario);
      };
      arrange("hangs");
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 20);
      await expect(collect(port, controller.signal)).rejects.toThrow();
    });

    it("throws a retryable ModelCallError when the provider is overloaded", async () => {
      const harness = makeHarness();
      const { port } = harness;
      const arrange = (scenario: ModelScenario) => {
        harness.arrange(scenario);
      };
      arrange("overloaded");
      const error = await collect(port).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ModelCallError);
      expect((error as ModelCallError).retryable).toBe(true);
    });

    it("throws a non-retryable ModelCallError for a rejected request", async () => {
      const harness = makeHarness();
      const { port } = harness;
      const arrange = (scenario: ModelScenario) => {
        harness.arrange(scenario);
      };
      arrange("rejects");
      const error = await collect(port).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ModelCallError);
      expect((error as ModelCallError).retryable).toBe(false);
    });
  });
}
