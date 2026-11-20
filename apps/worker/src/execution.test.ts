import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryMissions } from "@aep/application/testing";
import { describe, expect, it } from "vitest";
import { executionSetup } from "./execution.ts";

const missions = new InMemoryMissions(new Map());
const jobs = { enqueue: () => Promise.resolve({ id: "j", created: true }) };

function keyFile(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const path = join(mkdtempSync(join(tmpdir(), "aep-worker-test-")), "app.pem");
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }));
  return path;
}

describe("executionSetup", () => {
  it("stays disabled and names what is missing", () => {
    expect(executionSetup({ AEP_GITHUB_APP_ID: "1" }, missions, jobs)).toEqual({
      enabled: false,
      missing: ["ANTHROPIC_API_KEY", "AEP_GITHUB_PRIVATE_KEY_PATH"],
    });
  });

  it("registers the mission job handlers and their onDead hooks when configured", () => {
    const setup = executionSetup(
      {
        ANTHROPIC_API_KEY: "sk-ant-test",
        AEP_GITHUB_APP_ID: "1",
        AEP_GITHUB_PRIVATE_KEY_PATH: keyFile(),
      },
      missions,
      jobs,
    );
    const kinds = ["mission.plan", "mission.execute", "mission.verify"];
    expect(setup.enabled && Object.keys(setup.handlers)).toEqual(kinds);
    expect(setup.enabled && Object.keys(setup.onDead)).toEqual(kinds);
  });

  it("rejects nonsense limits", () => {
    expect(() =>
      executionSetup(
        {
          ANTHROPIC_API_KEY: "sk-ant-test",
          AEP_GITHUB_APP_ID: "1",
          AEP_GITHUB_PRIVATE_KEY_PATH: keyFile(),
          AEP_AGENT_MAX_BUDGET_USD: "-1",
        },
        missions,
        jobs,
      ),
    ).toThrow(/AEP_AGENT_MAX_BUDGET_USD/);
  });
});
