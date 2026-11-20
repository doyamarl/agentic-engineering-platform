import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  SANDBOX_HOME,
  SANDBOX_WORKDIR,
  createAgentPort,
  type AgentFailure,
  type AgentOutcome,
  type AgentPort,
  type AgentTask,
  type AgentUsage,
  type ExecutionContext,
  type ProviderEvent,
  type SandboxHandle,
  type SandboxPort,
  type SandboxSpec,
} from "@aep/application";
import {
  query as sdkQuery,
  type ModelUsage,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

// Claude adapter for AgentPort (ADR-009), on @anthropic-ai/claude-agent-sdk 0.3.323.
// Settings come from docs/benchmarks/2026-11-agent-selection.md ("Harness"), where they were
// exercised against the real API. Authentication is API-key only: Anthropic does not allow
// third-party products to use claude.ai subscription login.

export type ClaudeQuery = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/**
 * Runs each session's Claude Code process in its own sandbox instead of on the host. The sandbox
 * mounts the checkout, the SDK's native Claude Code binary (read-only) and nothing else, and can
 * reach api.anthropic.com plus `allowHosts` only.
 */
export type ClaudeSandboxConfig = {
  readonly port: SandboxPort;
  /** glibc-based image for the native binary, e.g. `node:24-bookworm-slim`; pin by digest. */
  readonly image: string;
  /** The sandbox TTL is the task's wall-clock limit plus a minute. */
  readonly limits: Omit<SandboxSpec["limits"], "ttlMs">;
  /** Hosts besides api.anthropic.com the agent may reach over HTTPS, e.g. registry.npmjs.org. */
  readonly allowHosts?: readonly string[];
  /** Host path of the Claude Code binary. Defaults to the SDK's own native binary. */
  readonly executable?: string;
};

export type ClaudeAgentConfig = {
  readonly apiKey: string;
  /** Model ID, e.g. `claude-sonnet-5-5`. */
  readonly model: string;
  /**
   * Host runs only (no `sandbox`): each session gets a fresh, empty CLAUDE_CONFIG_DIR under this
   * directory, removed afterwards. In a sandbox the config lives in the sandbox's tmpfs home.
   */
  readonly configRoot?: string;
  /** Run Claude Code in a sandbox. Without it the process runs on the host (development only). */
  readonly sandbox?: ClaudeSandboxConfig;
  readonly allowedTools?: readonly string[];
  /**
   * Host runs only: names of host environment variables the agent process may see. The SDK
   * replaces the subprocess environment with what we pass, so nothing else reaches it (no
   * DATABASE_URL, no cloud credentials). A sandbox gets a fixed environment instead.
   */
  readonly passEnv?: readonly string[];
  /** Source of the variables named in passEnv. Defaults to process.env. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  /** Replaces the SDK in tests. */
  readonly query?: ClaudeQuery;
};

export const DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite"];
export const DISALLOWED_TOOLS = ["WebFetch", "WebSearch"];
export const DEFAULT_PASS_ENV = ["PATH", "HOME", "LANG", "TMPDIR"];
export const ANTHROPIC_API_HOST = "api.anthropic.com";
/** Where the Claude Code binary is mounted inside a sandbox. */
export const SANDBOX_CLAUDE = "/opt/aep/claude";
/** Grace between the task's wall-clock limit and the sandbox removing itself. */
const SANDBOX_TTL_MARGIN_MS = 60_000;

/** The SDK's platform package for this host, e.g. @anthropic-ai/claude-agent-sdk-linux-x64. */
export function sdkClaudeExecutable(): string {
  const sdk = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  return sdk.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
}

/** Environment of Claude Code inside a sandbox; no host value is copied in. */
function sandboxEnv(apiKey: string): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: SANDBOX_HOME,
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
    CLAUDE_CONFIG_DIR: `${SANDBOX_HOME}/.claude`,
    // Telemetry, error reporting and update checks would need hosts outside the allowlist.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_API_KEY: apiKey,
  };
}

/** Starts the SDK's Claude Code command inside the sandbox instead of on the host. */
function spawnInSandbox(port: SandboxPort, handle: SandboxHandle) {
  return (options: SpawnOptions): SpawnedProcess => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env)) {
      if (value !== undefined) env[name] = value;
    }
    const child = port.spawn(handle, {
      command: SANDBOX_CLAUDE,
      args: options.args,
      env,
      cwd: options.cwd ?? SANDBOX_WORKDIR,
    });
    // The SDK aborts this only after closing stdin and a grace period; destroying the sandbox
    // afterwards stops anything the process left running.
    options.signal.addEventListener(
      "abort",
      () => {
        child.kill("SIGKILL");
      },
      { once: true },
    );
    return child;
  };
}

type AssistantError = Extract<SDKMessage, { type: "assistant" }>["error"];

/** Account and credential problems need operator action, so they all map to `auth`. */
function failureFor(error: AssistantError): AgentFailure {
  switch (error) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "cloud_credential_error":
    case "account_on_hold":
    case "verification_required":
    case "billing_error":
      return "auth";
    case "rate_limit":
    case "overloaded":
      return "rate_limited";
    case "invalid_request":
    case "max_output_tokens":
    case "model_not_found":
    case "server_error":
    case "unknown":
    case undefined:
      return "provider_error";
  }
}

function usageOf(result: SDKResultMessage): AgentUsage {
  const models: ModelUsage[] = Object.values(result.modelUsage);
  return {
    inputTokens: models.reduce(
      (n, m) => n + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens,
      0,
    ),
    outputTokens: models.reduce((n, m) => n + m.outputTokens, 0),
    costUsd: result.total_cost_usd,
  };
}

function outcomeOf(result: SDKResultMessage, lastError: AssistantError): AgentOutcome {
  if (result.subtype === "success") {
    if (!result.is_error) return { kind: "succeeded", summary: result.result };
    return { kind: "failed", reason: failureFor(lastError), detail: result.result };
  }
  const detail = result.errors.length > 0 ? result.errors.join("; ") : result.subtype;
  switch (result.subtype) {
    case "error_max_budget_usd":
      return { kind: "failed", reason: "budget_exceeded", detail };
    case "error_max_turns":
      return { kind: "failed", reason: "turn_limit", detail };
    case "error_during_execution":
    case "error_max_structured_output_retries":
      return { kind: "failed", reason: failureFor(lastError), detail };
  }
}

export function claudeAgent(config: ClaudeAgentConfig): AgentPort {
  const query = config.query ?? (sdkQuery as ClaudeQuery);
  const hostEnv = config.hostEnv ?? process.env;
  const { sandbox, configRoot } = config;
  if (sandbox === undefined && configRoot === undefined) {
    throw new Error("claudeAgent needs configRoot when it runs without a sandbox");
  }
  const executable =
    sandbox === undefined ? undefined : (sandbox.executable ?? sdkClaudeExecutable());

  /** Where the session runs: its cwd, environment and, in a sandbox, the spawn override. */
  type Placement = {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly spawn?: Options["spawnClaudeCodeProcess"];
    /** Idempotent. */
    readonly dispose: () => Promise<void>;
    /** Dispose as soon as the session is aborted, not only when the SDK stream ends. */
    readonly disposeOnAbort: boolean;
  };

  async function place(task: AgentTask, context: ExecutionContext): Promise<Placement> {
    if (sandbox === undefined || executable === undefined) {
      const configDir = await mkdtemp(join(configRoot ?? "", "claude-session-"));
      const env: Record<string, string> = {};
      for (const name of config.passEnv ?? DEFAULT_PASS_ENV) {
        const value = hostEnv[name];
        if (value !== undefined) env[name] = value;
      }
      env["ANTHROPIC_API_KEY"] = config.apiKey;
      env["CLAUDE_CONFIG_DIR"] = configDir;
      return {
        cwd: task.workdir,
        env,
        dispose: () => rm(configDir, { recursive: true, force: true }),
        // The host process may still write its config dir while it shuts down.
        disposeOnAbort: false,
      };
    }
    const handle = await sandbox.port.create(
      {
        image: sandbox.image,
        workdir: task.workdir,
        readOnlyMounts: [{ source: executable, target: SANDBOX_CLAUDE }],
        network: { kind: "allowlist", hosts: [ANTHROPIC_API_HOST, ...(sandbox.allowHosts ?? [])] },
        limits: { ...sandbox.limits, ttlMs: task.limits.wallClockMs + SANDBOX_TTL_MARGIN_MS },
      },
      context,
    );
    let destroyed: Promise<void> | undefined;
    return {
      cwd: SANDBOX_WORKDIR,
      env: sandboxEnv(config.apiKey),
      spawn: spawnInSandbox(sandbox.port, handle),
      dispose: () => (destroyed ??= sandbox.port.destroy(handle)),
      // AgentPort does not wait for a cancelled provider to wind down; removing the sandbox
      // right away stops the agent even if the SDK is stuck.
      disposeOnAbort: true,
    };
  }

  async function* launch(
    task: AgentTask,
    context: ExecutionContext,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    const placement = await place(task, context);
    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
      if (placement.disposeOnAbort) placement.dispose().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    let lastError: AssistantError = undefined;
    try {
      for await (const message of query({
        prompt: task.prompt,
        options: {
          cwd: placement.cwd,
          model: config.model,
          settingSources: [],
          systemPrompt: { type: "preset", preset: "claude_code" },
          permissionMode: "dontAsk",
          allowedTools: [...(config.allowedTools ?? DEFAULT_ALLOWED_TOOLS)],
          disallowedTools: DISALLOWED_TOOLS,
          maxBudgetUsd: task.limits.maxBudgetUsd,
          abortController: controller,
          env: placement.env,
          ...(placement.spawn === undefined ? {} : { spawnClaudeCodeProcess: placement.spawn }),
        },
      })) {
        if (message.type === "assistant") {
          if (message.error !== undefined) lastError = message.error;
          for (const block of message.message.content) {
            if (block.type === "text") yield { type: "text", text: block.text };
            else if (block.type === "tool_use") yield { type: "tool_call", tool: block.name };
          }
        } else if (message.type === "result") {
          yield { type: "result", outcome: outcomeOf(message, lastError), usage: usageOf(message) };
          return;
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      await placement.dispose();
    }
  }

  return createAgentPort({
    provider: "claude",
    capabilities: new Set(["streaming"]),
    model: config.model,
    secrets: [config.apiKey],
    launch,
  });
}
