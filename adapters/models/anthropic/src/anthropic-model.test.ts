import { modelPortContract, type ModelScenario } from "@aep/application/testing";
import { describe, expect, it } from "vitest";
import { anthropicModel } from "./anthropic-model.ts";

// The adapter against a fake Messages API: the SDK's fetch returns server-sent events shaped like
// the API's, so no request leaves the process.

type Recorded = { url: string; headers: Headers; body: Record<string, unknown> };

const sse = (events: readonly object[]): string =>
  events
    .map(
      (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");

const start = (model = "claude-sonnet-5-5") => ({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 0 },
  },
});

const textBlock = (index: number, parts: readonly string[]) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...parts.map((text) => ({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  })),
  { type: "content_block_stop", index },
];

const end = (stop_reason: string) => [
  {
    type: "message_delta",
    delta: { stop_reason, stop_sequence: null },
    usage: { output_tokens: 7 },
  },
  { type: "message_stop" },
];

const BODIES: Record<Exclude<ModelScenario, "hangs" | "overloaded" | "rejects">, string> = {
  replies: sse([start(), ...textBlock(0, ["Hello, ", "world"]), ...end("end_turn")]),
  "calls-tool": sse([
    start(),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"q": "sign' },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: 'up"}' },
    },
    { type: "content_block_stop", index: 0 },
    ...end("tool_use"),
  ]),
  refuses: sse([start(), ...end("refusal")]),
  "hits-max-tokens": sse([start(), ...textBlock(0, ["Partial"]), ...end("max_tokens")]),
};

const errorResponse = (status: number, type: string) =>
  new Response(JSON.stringify({ type: "error", error: { type, message: type } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A stream that sends message_start and then waits until the request is aborted. */
function hanging(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse([start()])));
      signal?.addEventListener("abort", () => {
        controller.error(new DOMException("aborted", "AbortError"));
      });
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function harness(model = "claude-sonnet-5-5", effort?: "low") {
  let scenario: ModelScenario = "replies";
  const requests: Recorded[] = [];
  const fakeFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >,
    });
    switch (scenario) {
      case "hangs":
        return Promise.resolve(hanging(init?.signal));
      case "overloaded":
        return Promise.resolve(errorResponse(529, "overloaded_error"));
      case "rejects":
        return Promise.resolve(errorResponse(400, "invalid_request_error"));
      case "replies":
      case "calls-tool":
      case "refuses":
      case "hits-max-tokens":
        return Promise.resolve(
          new Response(BODIES[scenario], { headers: { "content-type": "text/event-stream" } }),
        );
    }
  };
  const port = anthropicModel({
    apiKey: "sk-ant-test",
    model,
    ...(effort === undefined ? {} : { effort }),
    fetch: fakeFetch,
    maxRetries: 0,
  });
  return {
    port,
    requests,
    arrange(next: ModelScenario) {
      scenario = next;
    },
  };
}

modelPortContract("anthropicModel (fake Messages API)", () => harness());

async function drain(port: ReturnType<typeof harness>["port"]) {
  for await (const event of port.stream(
    {
      system: "Be brief.",
      messages: [
        { role: "user", content: "Say hello" },
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "toolu_0", name: "lookup", input: { q: "x" } }],
        },
        { role: "user", content: [{ type: "tool_result", callId: "toolu_0", content: "found" }] },
      ],
      tools: [
        {
          name: "lookup",
          description: "Looks a term up.",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
    },
    new AbortController().signal,
  )) {
    expect(event.type).toBeTypeOf("string");
  }
}

describe("anthropicModel requests", () => {
  it("streams on the beta endpoint with server-side fallbacks for claude-sonnet-5-5", async () => {
    const { port, requests } = harness("claude-sonnet-5-5", "low");
    await drain(port);
    const [request] = requests;
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(request?.body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 64_000,
      stream: true,
      system: "Be brief.",
      fallbacks: "default",
      output_config: { effort: "low" },
      tools: [{ name: "lookup", eager_input_streaming: true }],
      messages: [
        { role: "user", content: "Say hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_0", name: "lookup", input: { q: "x" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "found" }],
        },
      ],
    });
  });

  it("leaves fallbacks out for a model that does not take them", async () => {
    const { port, requests } = harness("claude-haiku-5-5");
    await drain(port);
    expect(requests[0]?.body).not.toHaveProperty("fallbacks");
    expect(requests[0]?.body).not.toHaveProperty("output_config");
    expect(requests[0]?.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
  });

  it.each(["overloaded", "rejects"] as const)(
    "keeps the API key out of the error when the API %s",
    async (scenario) => {
      const fake = harness();
      fake.arrange(scenario);
      const error = await drain(fake.port).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      const seen = [String(error), String((error as Error).cause), JSON.stringify(error)].join(
        "\n",
      );
      expect(seen).not.toContain("sk-ant-test");
    },
  );

  it("uses the effort of the request over the configured one", async () => {
    const { port, requests } = harness("claude-sonnet-5-5", "low");
    for await (const event of port.stream(
      { effort: "high", messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    )) {
      expect(event.type).toBeTypeOf("string");
    }
    expect(requests[0]?.body).toMatchObject({ output_config: { effort: "high" } });
  });

  it("uses the model of the request, with fallbacks only where that model takes them", async () => {
    const { port, requests } = harness("claude-sonnet-5-5");
    for (const model of ["claude-opus-5-5", "claude-haiku-5-5"]) {
      for await (const event of port.stream(
        { model, messages: [{ role: "user", content: "hi" }] },
        new AbortController().signal,
      )) {
        expect(event.type).toBeTypeOf("string");
      }
    }
    expect(requests[0]?.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default" });
    expect(requests[1]?.body).toMatchObject({ model: "claude-haiku-5-5" });
    expect(requests[1]?.body).not.toHaveProperty("fallbacks");
  });

  it("reports the model that answered", async () => {
    const { port } = harness();
    let model = "";
    for await (const event of port.stream(
      { messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    )) {
      if (event.type === "finished") model = event.model;
    }
    expect(model).toBe("claude-sonnet-5-5");
  });
});
