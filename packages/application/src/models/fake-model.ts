import type { ModelPort, ModelRequest, ModelStreamEvent } from "./model-port.ts";

// A ModelPort that answers in process, for tests, CI and local demos (provider `fake`). By default
// it echoes the last user message; tests pass `script` to return scripted events instead.
// A message `/tool <name> [JSON input]` makes it call the offered tool whose name is <name> or ends
// with `__<name>` (a connector tool), and the turn after a tool result quotes the result's start.

export type FakeModelOptions = {
  /** Events for a request; `finished` is appended when the script leaves it out. */
  readonly script?: (request: ModelRequest) => readonly ModelStreamEvent[];
  /** Pause before each event, so a reader sees the reply arrive in pieces. */
  readonly delayMs?: number | ((request: ModelRequest) => number);
};

function lastUserText(request: ModelRequest): string {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    const text = message.content.find((block) => block.type === "text");
    if (text?.type === "text") return text.text;
  }
  return "";
}

const words = (text: string): readonly ModelStreamEvent[] =>
  text.split(/(?<= )/).map((piece) => ({ type: "text_delta", text: piece }) as const);

/** The tool results of the last message, when it carries them. */
function lastToolResults(request: ModelRequest): string[] | undefined {
  const last = request.messages.at(-1);
  if (last?.role !== "user" || typeof last.content === "string") return undefined;
  const results = last.content.flatMap((block) =>
    block.type === "tool_result" ? [block.content] : [],
  );
  return results.length === 0 ? undefined : results;
}

function toolCall(request: ModelRequest, text: string): ModelStreamEvent | undefined {
  const match = /^\/tool\s+(\S+)\s*(.*)$/s.exec(text.trim());
  if (match === null) return undefined;
  const [, wanted = "", raw = ""] = match;
  const tool = request.tools?.find((t) => t.name === wanted || t.name.endsWith(`__${wanted}`));
  if (tool === undefined) return undefined;
  let input: unknown;
  try {
    input = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    input = {};
  }
  return { type: "tool_call", id: "fake-call-1", name: tool.name, input };
}

/** "Fake reply to: <text>", split into a few deltas; or a tool call or a tool result's start. */
export function echoReply(request: ModelRequest): readonly ModelStreamEvent[] {
  const results = lastToolResults(request);
  if (results !== undefined) {
    return words(`Fake reply from the tool result: ${results.join(" ").slice(0, 300)}`);
  }
  const text = lastUserText(request);
  const call = toolCall(request, text);
  return call === undefined ? words(`Fake reply to: ${text}`) : [call];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

export function fakeModel(options: FakeModelOptions = {}): ModelPort {
  return {
    provider: "fake",
    model: "fake-echo",
    async *stream(request, signal) {
      const events = [...(options.script ?? echoReply)(request)];
      if (!events.some((event) => event.type === "finished")) {
        const output = events.reduce(
          (sum, event) => sum + (event.type === "text_delta" ? event.text.length : 0),
          0,
        );
        events.push({
          type: "finished",
          stopReason: events.some((event) => event.type === "tool_call") ? "tool_use" : "end_turn",
          usage: { inputTokens: 0, outputTokens: output },
          model: "fake-echo",
        });
      }
      const delay =
        typeof options.delayMs === "function" ? options.delayMs(request) : (options.delayMs ?? 0);
      for (const event of events) {
        signal.throwIfAborted();
        if (delay > 0) await sleep(delay, signal);
        yield event;
      }
    },
  };
}
