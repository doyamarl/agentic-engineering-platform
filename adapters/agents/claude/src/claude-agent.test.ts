import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentEvent,
  AgentTask,
  SandboxCommand,
  SandboxPort,
  SandboxProcess,
  SandboxSpec,
} from "@aep/application";
import { agentPortContract, type AgentScenario } from "@aep/application/testing";
import type { MissionId, TenantId } from "@aep/domain";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeAgent, sdkClaudeExecutable, type ClaudeQuery } from "./claude-agent.ts";

const API_KEY = "sk-ant-test-0000-not-a-real-key";
const MODEL = "claude-sonnet-5-5";

// SDK messages carry many fields the adapter ignores; tests build only what it reads.
const msg = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage;
const init = msg({
  type: "system",
  subtype: "init",
  model: MODEL,
  apiKeySource: "ANTHROPIC_API_KEY",
});
const assistant = (content: unknown[], error?: string) =>
  msg({ type: "assistant", message: { content }, parent_tool_use_id: null, error });
const result = (fields: Record<string, unknown>) =>
  msg({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    errors: [],
    total_cost_usd: 0.0123,
    modelUsage: {
      [MODEL]: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 4,
        costUSD: 0.0123,
      },
    },
    ...fields,
  });

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        reject(new Error("Claude Code process aborted by user"));
      },
      { once: true },
    );
  });
}

async function* play(scenario: AgentScenario, options: Options): AsyncGenerator<SDKMessage> {
  await Promise.resolve();
  yield init;
  switch (scenario) {
    case "succeeds":
      yield assistant([
        { type: "text", text: "Editing README." },
        { type: "tool_use", id: "t1", name: "Edit", input: {} },
      ]);
      yield result({});
      return;
    case "hangs":
      yield assistant([{ type: "text", text: "Thinking." }]);
      await waitForAbort(options.abortController?.signal);
      return;
    case "echoes-credential": {
      // The key reaches the agent process through env; a prompt-injected agent could print it.
      const key = options.env?.["ANTHROPIC_API_KEY"] ?? "";
      yield assistant([{ type: "text", text: `export ANTHROPIC_API_KEY=${key}` }]);
      yield result({ result: `Found ${key}` });
      return;
    }
    case "fails-auth":
      yield assistant([{ type: "text", text: "Invalid API key" }], "authentication_failed");
      yield result({ is_error: true, result: "Invalid API key · Fix external API key" });
      return;
    case "exceeds-budget":
      yield result({ subtype: "error_max_budget_usd", errors: ["Reached maximum budget"] });
      return;
    case "crashes":
      throw new Error("Claude Code process exited with code 1");
  }
}

/** Records what the adapter asks of the sandbox; spawned processes are inert stand-ins. */
function fakeSandbox() {
  const log = {
    created: [] as SandboxSpec[],
    spawned: [] as SandboxCommand[],
    destroyed: [] as string[],
    killed: [] as string[],
  };
  const port: SandboxPort = {
    create(spec) {
      log.created.push(spec);
      return Promise.resolve({ id: `sbx-${String(log.created.length)}` });
    },
    spawn(_handle, command) {
      log.spawned.push(command);
      return {
        kill: (signal: string) => {
          log.killed.push(signal);
          return true;
        },
      } as unknown as SandboxProcess;
    },
    destroy(handle) {
      log.destroyed.push(handle.id);
      return Promise.resolve();
    },
  };
  return { port, log };
}

function harness(overrides: { hostEnv?: Record<string, string>; sandbox?: SandboxPort } = {}) {
  const configRoot = mkdtempSync(join(tmpdir(), "aep-claude-test-"));
  const queue: AgentScenario[] = [];
  const calls: { prompt: string; options: Options }[] = [];
  const query: ClaudeQuery = (params) => {
    calls.push(params);
    return play(queue.shift() ?? "succeeds", params.options);
  };
  const port = claudeAgent({
    apiKey: API_KEY,
    model: MODEL,
    configRoot,
    query,
    ...(overrides.hostEnv ? { hostEnv: overrides.hostEnv } : {}),
    ...(overrides.sandbox
      ? {
          sandbox: {
            port: overrides.sandbox,
            image: "node:24-bookworm-slim",
            limits: { memoryMb: 2048, cpus: 2, pids: 256 },
            allowHosts: ["registry.npmjs.org"],
            executable: "/host/sdk/claude",
          },
        }
      : {}),
  });
  return {
    port,
    credential: API_KEY,
    calls,
    configRoot,
    arrange: (s: AgentScenario) => {
      queue.push(s);
    },
  };
}

agentPortContract("claudeAgent (fake SDK)", harness);
agentPortContract("claudeAgent in a sandbox (fake SDK and sandbox)", () =>
  harness({ sandbox: fakeSandbox().port }),
);

const context = {
  tenantId: "0a000000-0000-4000-8000-000000000001" as TenantId,
  missionId: "0a000000-0000-4000-8000-0000000000c1" as MissionId,
};
const task: AgentTask = {
  prompt: "Add a README line.",
  workdir: "/repo/checkout",
  requires: new Set(),
  limits: { wallClockMs: 10_000, maxBudgetUsd: 2.5 },
};

async function runWith(h: ReturnType<typeof harness>, scenario?: AgentScenario) {
  if (scenario) h.arrange(scenario);
  const started = await h.port.start(task, context);
  if (!started.ok) throw new Error("start failed");
  const events: AgentEvent[] = [];
  for await (const e of h.port.events(started.value)) events.push(e);
  return events;
}

describe("claudeAgent", () => {
  it("runs the SDK headless in the task's checkout with isolated settings and the spend limit", async () => {
    const h = harness();
    await runWith(h);
    const { prompt, options } = h.calls[0] ?? { prompt: "", options: {} };
    expect(prompt).toBe(task.prompt);
    expect(options).toMatchObject({
      cwd: "/repo/checkout",
      model: MODEL,
      settingSources: [],
      permissionMode: "dontAsk",
      maxBudgetUsd: 2.5,
      disallowedTools: ["WebFetch", "WebSearch"],
    });
    expect(options.allowedTools).not.toContain("WebFetch");
  });

  it("passes the API key and only allow-listed host variables to the agent process", async () => {
    const h = harness({
      hostEnv: { PATH: "/usr/bin", DATABASE_URL: "postgres://secret", AWS_SECRET_ACCESS_KEY: "x" },
    });
    await runWith(h);
    const env = h.calls[0]?.options.env ?? {};
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "PATH"]);
    expect(env["ANTHROPIC_API_KEY"]).toBe(API_KEY);
  });

  it("gives each session a fresh config dir and removes it afterwards", async () => {
    const h = harness();
    await runWith(h);
    await runWith(h);
    const dirs = h.calls.map((c) => c.options.env?.["CLAUDE_CONFIG_DIR"] ?? "");
    expect(new Set(dirs).size).toBe(2);
    for (const d of dirs) {
      expect(d.startsWith(h.configRoot)).toBe(true);
      expect(existsSync(d)).toBe(false);
    }
    expect(readdirSync(h.configRoot)).toEqual([]);
  });

  it("reports usage including cached input tokens, and the SDK cost estimate", async () => {
    const finished = (await runWith(harness())).at(-1);
    expect(finished).toMatchObject({
      type: "finished",
      outcome: { kind: "succeeded", summary: "Done." },
      usage: { inputTokens: 314, outputTokens: 20, costUsd: 0.0123 },
    });
  });

  it.each([
    ["error_max_turns", undefined, "turn_limit"],
    ["error_during_execution", "rate_limit", "rate_limited"],
    ["error_during_execution", "overloaded", "rate_limited"],
    ["error_during_execution", "authentication_failed", "auth"],
    ["error_during_execution", undefined, "provider_error"],
  ] as const)("maps result %s after assistant error %s to %s", async (subtype, error, reason) => {
    const h = harness();
    const port = claudeAgent({
      apiKey: API_KEY,
      model: MODEL,
      configRoot: h.configRoot,
      query: async function* () {
        await Promise.resolve();
        yield assistant([{ type: "text", text: "x" }], error);
        yield result({ subtype, errors: ["boom"] });
      },
    });
    const started = await port.start(task, context);
    if (!started.ok) throw new Error("start failed");
    const events: AgentEvent[] = [];
    for await (const e of port.events(started.value)) events.push(e);
    expect(events.at(-1)).toMatchObject({ outcome: { kind: "failed", reason, detail: "boom" } });
  });
});

describe("claudeAgent in a sandbox", () => {
  it("creates a sandbox for the checkout with the binary mounted and only the API reachable", async () => {
    const sb = fakeSandbox();
    await runWith(harness({ sandbox: sb.port }));
    expect(sb.log.created).toEqual([
      {
        image: "node:24-bookworm-slim",
        workdir: "/repo/checkout",
        readOnlyMounts: [{ source: "/host/sdk/claude", target: "/opt/aep/claude" }],
        network: { kind: "allowlist", hosts: ["api.anthropic.com", "registry.npmjs.org"] },
        limits: { memoryMb: 2048, cpus: 2, pids: 256, ttlMs: 70_000 },
      },
    ]);
  });

  it("runs Claude Code in /workspace with a fixed environment and no host values", async () => {
    const sb = fakeSandbox();
    const h = harness({ sandbox: sb.port, hostEnv: { PATH: "/host/bin", DATABASE_URL: "x" } });
    await runWith(h);
    const options = h.calls[0]?.options ?? {};
    expect(options.cwd).toBe("/workspace");
    expect(options.env).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/sandbox",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
      CLAUDE_CONFIG_DIR: "/home/sandbox/.claude",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_API_KEY: API_KEY,
    });
    expect(readdirSync(h.configRoot)).toEqual([]);
  });

  it("spawns the SDK's command as the mounted binary inside the sandbox", async () => {
    const sb = fakeSandbox();
    const h = harness({ sandbox: sb.port });
    await runWith(h);
    const spawn = h.calls[0]?.options.spawnClaudeCodeProcess;
    const abort = new AbortController();
    spawn?.({
      command: "/host/sdk/claude",
      args: ["--output-format", "stream-json"],
      cwd: "/workspace",
      env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts", UNSET: undefined },
      signal: abort.signal,
    });
    expect(sb.log.spawned).toEqual([
      {
        command: "/opt/aep/claude",
        args: ["--output-format", "stream-json"],
        env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
        cwd: "/workspace",
      },
    ]);
    abort.abort();
    expect(sb.log.killed).toEqual(["SIGKILL"]);
  });

  it.each(["succeeds", "hangs", "crashes"] as const)(
    "destroys the sandbox when a session %s",
    async (scenario) => {
      const sb = fakeSandbox();
      const h = harness({ sandbox: sb.port });
      h.arrange(scenario);
      const started = await h.port.start(task, context);
      if (!started.ok) throw new Error("start failed");
      for await (const e of h.port.events(started.value)) {
        if (scenario === "hangs" && e.type === "text") await h.port.cancel(started.value);
      }
      expect(sb.log.destroyed).toEqual(["sbx-1"]);
    },
  );

  it("needs a configRoot only without a sandbox", () => {
    expect(() => claudeAgent({ apiKey: API_KEY, model: MODEL })).toThrow(/configRoot/);
  });

  it("finds the SDK's native binary for this platform", () => {
    expect(existsSync(sdkClaudeExecutable())).toBe(true);
  });
});
