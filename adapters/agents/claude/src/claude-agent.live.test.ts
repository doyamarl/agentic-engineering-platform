import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentPort, AgentTask } from "@aep/application";
import type { MissionId, TenantId } from "@aep/domain";
import { dockerSandbox } from "@aep/sandbox-docker";
import { describe, expect, it } from "vitest";
import { claudeAgent } from "./claude-agent.ts";

// Calls the real Claude API and costs money (about USD 0.10 per full run: each test runs once on
// the host and once in a Docker sandbox). Skipped unless the operator opts in from their own
// terminal:
//
//   AEP_LIVE_CLAUDE=1 ANTHROPIC_API_KEY=... mise exec -- pnpm exec vitest run \
//     adapters/agents/claude/src/claude-agent.live.test.ts
//
// AEP_LIVE_CLAUDE_MODEL overrides the model (default claude-sonnet-5-5).

const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";
const enabled = process.env["AEP_LIVE_CLAUDE"] === "1" && apiKey !== "";
const model = process.env["AEP_LIVE_CLAUDE_MODEL"] ?? "claude-sonnet-5-5";

const context = {
  tenantId: "0a000000-0000-4000-8000-000000000001" as TenantId,
  missionId: "0a000000-0000-4000-8000-0000000000c1" as MissionId,
};

type Placement = "host" | "sandbox";

function setup(placement: Placement): { port: AgentPort; workdir: string } {
  const root = mkdtempSync(join(tmpdir(), "aep-claude-live-"));
  const workdir = mkdtempSync(join(root, "work-"));
  const sandbox =
    placement === "sandbox"
      ? {
          sandbox: {
            port: dockerSandbox(),
            image: "node:24-bookworm-slim",
            limits: { memoryMb: 2048, cpus: 2, pids: 256 },
          },
        }
      : { configRoot: root };
  return { port: claudeAgent({ apiKey, model, ...sandbox }), workdir };
}

async function run(port: AgentPort, task: AgentTask) {
  const started = await port.start(task, context);
  if (!started.ok) throw new Error("start failed");
  const events: AgentEvent[] = [];
  for await (const e of port.events(started.value)) {
    events.push(e);
  }
  return events;
}

describe.skipIf(!enabled).each<Placement>(["host", "sandbox"])(
  "claudeAgent on the %s against the real API",
  (placement) => {
    it("writes a file in the checkout and reports success with usage", async () => {
      const { port, workdir } = setup(placement);
      const events = await run(port, {
        prompt: "Create a file named hello.txt whose entire content is the word hi. Then stop.",
        workdir,
        requires: new Set(),
        limits: { wallClockMs: 180_000, maxBudgetUsd: 0.5 },
      });
      const finished = events.at(-1);
      expect(finished).toMatchObject({ type: "finished", outcome: { kind: "succeeded" } });
      expect(finished?.type === "finished" && finished.usage?.costUsd).toBeGreaterThan(0);
      expect(events.some((e) => e.type === "tool_call")).toBe(true);
      expect(readFileSync(join(workdir, "hello.txt"), "utf8").trim()).toBe("hi");
      expect(JSON.stringify(events)).not.toContain(apiKey);
    }, 200_000);

    it("stops a running session when cancelled at its first tool call", async () => {
      const { port, workdir } = setup(placement);
      const started = await port.start(
        {
          prompt: "Run the Bash command `sleep 60`, then create a file named done.txt.",
          workdir,
          requires: new Set(),
          limits: { wallClockMs: 180_000, maxBudgetUsd: 0.5 },
        },
        context,
      );
      if (!started.ok) throw new Error("start failed");
      const events: AgentEvent[] = [];
      let cancelledAt: number | undefined;
      for await (const e of port.events(started.value)) {
        events.push(e);
        if (e.type === "tool_call" && cancelledAt === undefined) {
          cancelledAt = Date.now();
          await port.cancel(started.value);
        }
      }
      expect(cancelledAt).toBeDefined();
      expect(events.at(-1)).toMatchObject({ type: "finished", outcome: { kind: "cancelled" } });
      expect(Date.now() - (cancelledAt ?? 0)).toBeLessThan(10_000);
    }, 200_000);
  },
);
