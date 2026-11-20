import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cruise, type IConfiguration, type IViolation } from "dependency-cruiser";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const config = require("../.dependency-cruiser.cjs") as IConfiguration;

async function violationsIn(fixture: "violations" | "allowed"): Promise<IViolation[]> {
  const baseDir = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url));
  const { tsConfig: _ignored, ...options } = config.options ?? {};
  const result = await cruise(["."], {
    ...options,
    exclude: { path: "(^|/)node_modules/" },
    baseDir,
    validate: true,
    ruleSet: { forbidden: config.forbidden ?? [] },
  });
  if (typeof result.output === "string") {
    throw new Error("expected a structured cruise result");
  }
  return result.output.summary.violations;
}

const pairs = (violations: IViolation[]): string[] =>
  violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`).sort();

describe("module boundary rules (.dependency-cruiser.cjs)", () => {
  it("rejects every forbidden dependency in the violations fixture", async () => {
    const found = pairs(await violationsIn("violations"));

    expect(found).toEqual(
      expect.arrayContaining([
        "domain-is-pure: packages/domain/imports-framework.ts -> fastify",
        "domain-is-pure: packages/domain/imports-application.ts -> packages/application/service.ts",
        "no-circular: packages/domain/cycle-a.ts -> packages/domain/cycle-b.ts",
        "application-uses-ports: packages/application/service.ts -> adapters/agents/fake/agent.ts",
        "adapters-do-not-depend-on-apps: adapters/agents/fake/agent.ts -> apps/api/server.ts",
        "web-uses-contracts-only: apps/web/page.ts -> packages/domain/value.ts",
        "not-to-unresolvable: packages/domain/imports-framework.ts -> fastify",
        "chat-never-reaches-a-sandbox: packages/application/src/threads/reply.ts -> packages/application/src/sandboxes/sandbox-port.ts",
        "worker-chat-never-reaches-a-sandbox: apps/worker/src/chat.ts -> adapters/sandboxes/fake/sandbox.ts",
      ]),
    );
  });

  it("covers every configured rule with at least one violating fixture", async () => {
    const violated = new Set((await violationsIn("violations")).map((v) => v.rule.name));
    const configured = (config.forbidden ?? []).map((rule) => rule.name);

    expect(configured.filter((name) => name !== undefined && !violated.has(name))).toEqual([]);
  });

  it("accepts the layering the architecture allows", async () => {
    expect(pairs(await violationsIn("allowed"))).toEqual([]);
  });
});
