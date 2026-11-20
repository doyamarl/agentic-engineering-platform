import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SandboxHandle, SandboxPort } from "@aep/application";
import type { MissionId, TenantId } from "@aep/domain";
import { dockerSandbox } from "@aep/sandbox-docker";
import { beforeAll, describe, expect, it } from "vitest";
import { claudeAgent } from "./claude-agent.ts";

// Runs the SDK's real Claude Code binary in a real Docker sandbox, against the real API with a
// key that is not valid. The API's refusal proves the binary started in the sandbox and reached
// api.anthropic.com through the egress proxy, without spending anything. Needs Docker and
// internet access (true on CI runners).

const IMAGE = "node:24-bookworm-slim";
const FAKE_KEY = "sk-ant-api03-aep-sandbox-test-not-a-real-key";

const context = {
  tenantId: "0a000000-0000-4000-8000-000000000001" as TenantId,
  missionId: "0a000000-0000-4000-8000-0000000000c1" as MissionId,
};

beforeAll(() => {
  if (spawnSync("docker", ["image", "inspect", IMAGE]).status !== 0) {
    const pull = spawnSync("docker", ["pull", "--quiet", IMAGE], { encoding: "utf8" });
    if (pull.status !== 0) throw new Error(`docker pull ${IMAGE} failed: ${pull.stderr}`);
  }
}, 300_000);

describe("claudeAgent in a Docker sandbox", () => {
  it("starts Claude Code in the sandbox, reaches the API through the proxy, and cleans up", async () => {
    const docker = dockerSandbox();
    const handles: SandboxHandle[] = [];
    const port: SandboxPort = {
      create: async (spec, ctx) => {
        const h = await docker.create(spec, ctx);
        handles.push(h);
        return h;
      },
      spawn: (h, command) => docker.spawn(h, command),
      destroy: (h) => docker.destroy(h),
    };
    const agent = claudeAgent({
      apiKey: FAKE_KEY,
      model: "claude-haiku-5-5",
      sandbox: { port, image: IMAGE, limits: { memoryMb: 1024, cpus: 1, pids: 256 } },
    });
    const started = await agent.start(
      {
        prompt: "Say hi.",
        workdir: mkdtempSync(join(tmpdir(), "aep-claude-sbx-")),
        requires: new Set(),
        limits: { wallClockMs: 90_000, maxBudgetUsd: 0.01 },
      },
      context,
    );
    if (!started.ok) throw new Error("start failed");
    const events: AgentEvent[] = [];
    for await (const e of agent.events(started.value)) events.push(e);

    expect(events.at(-1)).toMatchObject({
      type: "finished",
      outcome: { kind: "failed", reason: "auth" },
    });
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY);
    expect(handles).toHaveLength(1);
    const id = handles[0]?.id ?? "";
    const left = spawnSync("docker", ["ps", "-a", "--filter", `name=${id}`, "-q"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(left).toBe("");
  }, 120_000);
});
