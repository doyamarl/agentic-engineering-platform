import {
  ModelCallError,
  type ModelContent,
  type ModelMessage,
  type ModelPort,
  type ModelRequest,
  type ModelStopReason,
  type ModelStreamEvent,
} from "@aep/application";
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaStopReason,
  BetaTool,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

// ModelPort on the Anthropic Messages API (ADR-012), with @anthropic-ai/sdk 1.8.0. Each reply is
// one streamed request on the beta endpoint, which carries server-side fallbacks.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicModelConfig = {
  readonly apiKey: string;
  /** Model ID, e.g. `claude-sonnet-5-5`. */
  readonly model: string;
  /** Checked against the allowlist by the caller (modelEndpointProblem). */
  readonly baseUrl?: string;
  /** Depth of thinking; the API default applies when omitted. */
  readonly effort?: Effort;
  /** Output cap per reply. Defaults to 64,000, which needs streaming. */
  readonly maxTokens?: number;
  /** Replaces global fetch, for tests. */
  readonly fetch?: typeof fetch;
  /** SDK retries per request before the job's own retries. Defaults to 2. */
  readonly maxRetries?: number;
};

/**
 * Models that accept `fallbacks: "default"`: a decline by a safety classifier is retried on a
 * fallback model in the same call. Other models run without it.
 */
const SERVER_FALLBACK_MODELS = new Set([
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
]);
const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

function toBlock(content: ModelContent): BetaContentBlockParam {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "tool_call":
      return { type: "tool_use", id: content.id, name: content.name, input: content.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: content.callId,
        content: content.content,
        ...(content.isError === true ? { is_error: true } : {}),
      };
  }
}

const toMessage = (message: ModelMessage): BetaMessageParam => ({
  role: message.role,
  content: typeof message.content === "string" ? message.content : message.content.map(toBlock),
});

const toTool = (tool: NonNullable<ModelRequest["tools"]>[number]): BetaTool => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
  // Tool input streams as it is written; the caller validates it against the schema.
  eager_input_streaming: true,
});

function stopReason(reason: BetaStopReason | null): ModelStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "refusal";
    case "pause_turn":
    case "compaction":
    case null:
      return "other";
  }
}

/** Rate limits, overload, timeouts and lost connections are worth another attempt. */
function callError(error: InstanceType<typeof Anthropic.APIError>): ModelCallError {
  const status = error.status;
  const retryable =
    error instanceof Anthropic.APIConnectionError ||
    status === undefined ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500;
  return new ModelCallError(
    `Anthropic API ${status === undefined ? "stream" : String(status)} error`,
    { retryable, cause: error },
  );
}

export function anthropicModel(config: AnthropicModelConfig): ModelPort {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    maxRetries: config.maxRetries ?? 2,
  });
  return {
    provider: "anthropic",
    model: config.model,
    async *stream(request, signal): AsyncIterable<ModelStreamEvent> {
      const model = request.model ?? config.model;
      const fallback = SERVER_FALLBACK_MODELS.has(model);
      const effort = request.effort ?? config.effort;
      const params: BetaMessageStreamParams = {
        model,
        max_tokens: config.maxTokens ?? 64_000,
        messages: request.messages.map(toMessage),
        ...(request.system === undefined ? {} : { system: request.system }),
        ...(request.tools === undefined || request.tools.length === 0
          ? {}
          : { tools: request.tools.map(toTool) }),
        ...(effort === undefined ? {} : { output_config: { effort } }),
        ...(fallback ? { betas: [SERVER_FALLBACK_BETA], fallbacks: "default" } : {}),
      };
      try {
        const stream = client.beta.messages.stream(params, { signal });
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          }
        }
        const message = await stream.finalMessage();
        for (const block of message.content) {
          if (block.type === "tool_use") {
            yield { type: "tool_call", id: block.id, name: block.name, input: block.input };
          }
        }
        yield {
          type: "finished",
          stopReason: stopReason(message.stop_reason),
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
          },
          model: message.model,
        };
      } catch (error) {
        // An abort stays an abort, so the caller can tell it from a failed call.
        if (error instanceof Anthropic.APIUserAbortError || signal.aborted) throw error;
        if (error instanceof Anthropic.APIError) {
          throw callError(error as InstanceType<typeof Anthropic.APIError>);
        }
        throw error;
      }
    },
  };
}
