import type { MissionId, Result, TenantId } from "@aep/domain";

// Provider contract from docs/02_ARCHITECTURE_ADR.md §5. Every adapter must pass
// agentPortContract (./agent-port-contract.ts), which encodes the ADR §10 quality gate:
// streaming, cancellation, timeout, tool approval (as capability negotiation), error mapping
// and credential leaks.

export const AGENT_CAPABILITIES = [
  "streaming",
  "resume",
  "tool-approval",
  "structured-output",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export type AgentTask = {
  readonly prompt: string;
  /** Absolute path of the checkout the agent may read and write. */
  readonly workdir: string;
  /** start() rejects the task if the adapter lacks any of these (PRD FR-03). */
  readonly requires: ReadonlySet<AgentCapability>;
  readonly limits: {
    /** The adapter ends the session with outcome `timed_out` after this long. */
    readonly wallClockMs: number;
    readonly maxBudgetUsd: number;
  };
};

/** Who the work is for. Adapters must not use it to pick credentials of another tenant. */
export type ExecutionContext = {
  readonly tenantId: TenantId;
  readonly missionId: MissionId;
};

/** Opaque handle. `id` means nothing outside the adapter that issued it (ADR §5). */
export type AgentSession = { readonly provider: string; readonly id: string };

export type AgentUsage = {
  /** Includes cached input tokens. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Provider-side estimate when available; billing data stays authoritative. */
  readonly costUsd: number | null;
};

export type AgentFailure =
  "auth" | "rate_limited" | "budget_exceeded" | "turn_limit" | "provider_error";

export type AgentOutcome =
  | { readonly kind: "succeeded"; readonly summary: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timed_out" }
  | { readonly kind: "failed"; readonly reason: AgentFailure; readonly detail: string };

/**
 * A session's stream starts with `started` and ends with exactly one `finished`, which is always
 * the last event, whatever happens to the provider. No event carries a credential.
 */
export type AgentEvent =
  | { readonly type: "started"; readonly model: string | null }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call"; readonly tool: string }
  | {
      readonly type: "finished";
      readonly outcome: AgentOutcome;
      readonly usage: AgentUsage | null;
    };

export type AgentStartError = {
  readonly kind: "UnsupportedCapability";
  readonly missing: readonly AgentCapability[];
};

export interface AgentPort {
  capabilities(): Promise<ReadonlySet<AgentCapability>>;
  start(task: AgentTask, context: ExecutionContext): Promise<Result<AgentSession, AgentStartError>>;
  /** Single consumer: a second call for the same session, or an unknown session, rejects. */
  events(session: AgentSession): AsyncIterable<AgentEvent>;
  /** Idempotent; a no-op once the session has finished. */
  cancel(session: AgentSession): Promise<void>;
}

/** Capabilities a task needs that the adapter does not offer, in canonical order. */
export function missingCapabilities(
  offered: ReadonlySet<AgentCapability>,
  required: ReadonlySet<AgentCapability>,
): AgentCapability[] {
  return AGENT_CAPABILITIES.filter((c) => required.has(c) && !offered.has(c));
}
