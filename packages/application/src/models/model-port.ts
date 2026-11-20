// A model behind a chat turn (ADR-012). Kept apart from AgentPort, which drives a coding agent in
// a sandbox: a model call is one streamed request with messages and, optionally, tools.

/** JSON Schema of a tool's input, as the model receives it. */
export type ToolInputSchema = {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly [key: string]: unknown;
};

export type ModelTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
};

export type ModelContent =
  | { readonly type: "text"; readonly text: string }
  /** A call the model made; `input` has not been validated against the tool's schema. */
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly content: string;
      readonly isError?: boolean;
    };

export type ModelMessage = {
  readonly role: "user" | "assistant";
  readonly content: string | readonly ModelContent[];
};

export type ModelRequest = {
  /** Overrides the adapter's configured model for this request (a tenant's choice). */
  readonly model?: string;
  /** Overrides the adapter's configured effort for this request. */
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelTool[];
};

export type ModelStopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  /** The model or a safety classifier declined; any text before it is not an answer. */
  | "refusal"
  | "other";

export type ModelUsage = { readonly inputTokens: number; readonly outputTokens: number };

export type ModelStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      /** Parsed JSON, not yet checked against the tool's schema: the caller must validate it. */
      readonly input: unknown;
    }
  | {
      readonly type: "finished";
      readonly stopReason: ModelStopReason;
      readonly usage: ModelUsage;
      /** The model that produced the reply; may differ from the requested one after a fallback. */
      readonly model: string;
    };

/**
 * Thrown by a ModelPort when the call fails. `retryable` is true for rate limits, overload,
 * timeouts and lost connections; false for requests the provider will reject again.
 */
export class ModelCallError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { readonly retryable: boolean; readonly cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelCallError";
    this.retryable = options.retryable;
  }
}

export interface ModelPort {
  /** e.g. `anthropic`, `fake`. */
  readonly provider: string;
  /** The requested model ID. */
  readonly model: string;
  /**
   * Streams one reply. Text arrives as deltas, tool calls once complete, and `finished` last,
   * exactly once. Aborting `signal` ends the iteration with an AbortError.
   */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}
