import { randomUUID } from "node:crypto";
import {
  APPROVAL_EXPIRY_JOB,
  expireApprovals,
  failReplyOfDeadJob,
  fakeModel,
  modelEndpointProblem,
  REPLY_JOB,
  replyToMessage,
  type CodeTools,
  type ConnectorGateway,
  type DeadJobHandler,
  type ToolApprovalRepository,
  type JobHandler,
  type ModelPort,
  type TenantSettings,
  type ThreadRepository,
} from "@aep/application";
import type { MessageId } from "@aep/domain";
import { anthropicModel, type Effort } from "@aep/model-anthropic";

// Builds the reply job (thread.reply) from the environment (ADR-012).
//
// AEP_MODEL_PROVIDER: `anthropic` (default) or `fake` (in-process echo, for tests and demos).
// AEP_MODEL_BASE_URL: optional; must be on the allowlist of no-training endpoints (PRD FR-15).
// AEP_CHAT_MODEL (default claude-sonnet-5-5), AEP_CHAT_EFFORT (default low), ANTHROPIC_API_KEY.
// AEP_FAKE_MODEL_DELAY_MS: pause between the fake model's pieces.
//
// A provider or endpoint off the allowlist, or an unknown effort, throws: the worker refuses to
// start. A missing API key only leaves chat disabled, as missing GitHub settings do for missions.

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export type ChatHandlers = {
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly onDead: Readonly<Record<string, DeadJobHandler>>;
};

const value = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
};

/**
 * The model chat replies use, or what is missing to build it. Call before connecting anything:
 * it throws for a configuration the worker must not start with.
 */
export function chatModel(
  env: NodeJS.ProcessEnv,
): ModelPort | { readonly missing: readonly string[] } {
  const provider = value(env, "AEP_MODEL_PROVIDER") ?? "anthropic";
  const baseUrl = value(env, "AEP_MODEL_BASE_URL");
  const problem = modelEndpointProblem({ provider, ...(baseUrl === undefined ? {} : { baseUrl }) });
  if (problem !== undefined) throw new Error(problem);

  if (provider === "fake") {
    const delay = Number(value(env, "AEP_FAKE_MODEL_DELAY_MS") ?? "0");
    if (!Number.isInteger(delay) || delay < 0) {
      throw new Error("AEP_FAKE_MODEL_DELAY_MS must be a non-negative integer");
    }
    return fakeModel({ delayMs: delay });
  }

  const effort = value(env, "AEP_CHAT_EFFORT") ?? "low";
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`AEP_CHAT_EFFORT must be one of ${EFFORTS.join(", ")}`);
  }
  const apiKey = value(env, "ANTHROPIC_API_KEY");
  if (apiKey === undefined) return { missing: ["ANTHROPIC_API_KEY"] };
  return anthropicModel({
    apiKey,
    model: value(env, "AEP_CHAT_MODEL") ?? "claude-sonnet-5-5",
    effort: effort as Effort,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
}

export function chatHandlers(
  model: ModelPort,
  threads: ThreadRepository,
  settings: TenantSettings,
  /** Connector tools (ADR-013), when connectors are on. */
  connectors?: {
    readonly gateway: ConnectorGateway;
    readonly approvals: ToolApprovalRepository;
  },
  /** Tools over the workspace's code (#52 scope 7), when the GitHub App is configured. */
  code?: CodeTools,
): ChatHandlers {
  const now = () => new Date();
  return {
    handlers: {
      [REPLY_JOB]: replyToMessage({
        threads,
        model,
        newMessageId: () => randomUUID() as MessageId,
        now,
        ...(connectors === undefined
          ? {}
          : { gateway: connectors.gateway, approvals: connectors.approvals }),
        ...(code === undefined ? {} : { code }),
        // The tenant admin's choice applies to Anthropic models only; the fake model ignores it.
        ...(model.provider === "anthropic"
          ? { tenantModel: async (tenantId) => (await settings.chat(tenantId)).model }
          : {}),
      }),
      // Write calls nobody decided in time (#52 decision 2).
      ...(connectors === undefined
        ? {}
        : { [APPROVAL_EXPIRY_JOB]: expireApprovals({ approvals: connectors.approvals, now }) }),
    },
    onDead: { [REPLY_JOB]: failReplyOfDeadJob({ threads, now }) },
  };
}
