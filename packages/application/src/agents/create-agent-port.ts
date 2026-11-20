import { randomUUID } from "node:crypto";
import { err, ok } from "@aep/domain";
import {
  missingCapabilities,
  type AgentCapability,
  type AgentEvent,
  type AgentOutcome,
  type AgentPort,
  type AgentSession,
  type AgentTask,
  type AgentUsage,
  type ExecutionContext,
} from "./agent-port.ts";

/** What a provider produces between `started` and `finished`, plus its own final verdict. */
export type ProviderEvent =
  | Extract<AgentEvent, { type: "text" | "tool_call" }>
  | { readonly type: "result"; readonly outcome: AgentOutcome; readonly usage: AgentUsage | null };

export type ProviderLaunch = (
  task: AgentTask,
  context: ExecutionContext,
  signal: AbortSignal,
) => AsyncIterable<ProviderEvent>;

export type AgentPortOptions = {
  readonly provider: string;
  readonly capabilities: ReadonlySet<AgentCapability>;
  /** Called once per session when its events are first consumed. Must stop when `signal` aborts. */
  readonly launch: ProviderLaunch;
  /** Values replaced with [REDACTED] in every event, e.g. the API key. */
  readonly secrets: readonly string[];
  /** Model reported in `started`. */
  readonly model: string | null;
};

type Entry = {
  readonly task: AgentTask;
  readonly context: ExecutionContext;
  readonly controller: AbortController;
  consumed: boolean;
  done: boolean;
  stop: "cancelled" | "timed_out" | null;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const REDACTED = "[REDACTED]";

const describeError = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : "provider stream failed";

function redactor(secrets: readonly string[]): (s: string) => string {
  const nonEmpty = secrets.filter((s) => s.length > 0);
  return (s) => nonEmpty.reduce((acc, secret) => acc.split(secret).join(REDACTED), s);
}

function redactEvent(event: AgentEvent, redact: (s: string) => string): AgentEvent {
  switch (event.type) {
    case "started":
      return { ...event, model: event.model === null ? null : redact(event.model) };
    case "text":
      return { ...event, text: redact(event.text) };
    case "tool_call":
      return { ...event, tool: redact(event.tool) };
    case "finished": {
      const o = event.outcome;
      const outcome: AgentOutcome =
        o.kind === "succeeded"
          ? { ...o, summary: redact(o.summary) }
          : o.kind === "failed"
            ? { ...o, detail: redact(o.detail) }
            : o;
      return { ...event, outcome };
    }
  }
}

/**
 * Builds an AgentPort from a provider launch function. It owns the parts of the contract that do
 * not depend on the provider: capability checks, the session registry, the single consumer, the
 * started/finished framing, cancellation, the wall-clock limit and credential redaction.
 */
export function createAgentPort(options: AgentPortOptions): AgentPort {
  const sessions = new Map<string, Entry>();
  const redact = redactor(options.secrets);

  const stopSession = (entry: Entry, reason: "cancelled" | "timed_out") => {
    if (entry.done || entry.stop !== null) return;
    entry.stop = reason;
    entry.controller.abort(new Error(`agent session ${reason}`));
  };

  async function* stream(entry: Entry): AsyncGenerator<AgentEvent> {
    yield redactEvent({ type: "started", model: options.model }, redact);
    let result: Extract<ProviderEvent, { type: "result" }> | undefined;
    let thrown: unknown;
    const signal = entry.controller.signal;
    // Resolves on abort, so a provider that ignores the signal cannot keep the session open.
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal.aborted) resolve("aborted");
      else
        signal.addEventListener(
          "abort",
          () => {
            resolve("aborted");
          },
          { once: true },
        );
    });
    let iterator: AsyncIterator<ProviderEvent> | undefined;
    // "open" until the provider is exhausted, threw, or was abandoned after an abort.
    let providerState: "open" | "ended" | "abandoned" = "open";
    try {
      if (!signal.aborted) {
        iterator = options.launch(entry.task, entry.context, signal)[Symbol.asyncIterator]();
        for (;;) {
          const pending = iterator.next();
          pending.catch(() => undefined); // its rejection after an abort is expected
          const next = await Promise.race([pending, aborted]);
          if (next === "aborted") {
            // The provider may be stuck mid-await, so ask it to close but do not wait.
            providerState = "abandoned";
            iterator.return?.().catch(() => undefined);
            break;
          }
          if (next.done === true) {
            providerState = "ended";
            break;
          }
          const event = next.value;
          if (event.type === "result") {
            result = event;
            break;
          }
          yield redactEvent(event, redact);
        }
      }
    } catch (error) {
      providerState = "ended";
      thrown = error;
    } finally {
      clearTimeout(entry.timer);
      // After a result, or when the consumer stops early, the provider is paused at a yield:
      // close it so its own cleanup (finally blocks) runs before `finished`.
      if (iterator !== undefined && providerState === "open") {
        await iterator.return?.().catch(() => undefined);
      }
    }
    const outcome: AgentOutcome =
      entry.stop !== null
        ? { kind: entry.stop }
        : (result?.outcome ??
          (thrown === undefined
            ? {
                kind: "failed",
                reason: "provider_error",
                detail: "provider ended without a result",
              }
            : { kind: "failed", reason: "provider_error", detail: describeError(thrown) }));
    entry.done = true;
    yield redactEvent({ type: "finished", outcome, usage: result?.usage ?? null }, redact);
  }

  return {
    capabilities: () => Promise.resolve(options.capabilities),

    start(task, context) {
      const missing = missingCapabilities(options.capabilities, task.requires);
      if (missing.length > 0)
        return Promise.resolve(err({ kind: "UnsupportedCapability", missing }));
      const id = randomUUID();
      const entry: Entry = {
        task,
        context,
        controller: new AbortController(),
        consumed: false,
        done: false,
        stop: null,
        timer: undefined,
      };
      entry.timer = setTimeout(() => {
        stopSession(entry, "timed_out");
      }, task.limits.wallClockMs);
      sessions.set(id, entry);
      return Promise.resolve(ok({ provider: options.provider, id } satisfies AgentSession));
    },

    events(session) {
      const entry = session.provider === options.provider ? sessions.get(session.id) : undefined;
      return {
        [Symbol.asyncIterator]() {
          if (entry === undefined) throw new Error("unknown agent session");
          if (entry.consumed) throw new Error("agent session events are already being consumed");
          entry.consumed = true;
          return stream(entry);
        },
      };
    },

    cancel(session) {
      const entry = session.provider === options.provider ? sessions.get(session.id) : undefined;
      if (entry !== undefined) stopSession(entry, "cancelled");
      return Promise.resolve();
    },
  };
}
