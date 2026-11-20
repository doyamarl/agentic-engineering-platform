import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectorSetup } from "./connections.ts";

const CONNECTORS = fileURLToPath(new URL("../../../connectors", import.meta.url));
const REDIRECT = "https://aep.example.com/connections/oauth/callback";

let dir: string;
let keyFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aep-worker-connectors-"));
  keyFile = join(dir, "master.key");
  await writeFile(keyFile, randomBytes(32).toString("base64"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("connectorSetup", () => {
  it("is off without a connectors directory", async () => {
    expect(await connectorSetup({})).toBeUndefined();
  });

  it("loads the repository's manifests with the key", async () => {
    const setup = await connectorSetup({
      AEP_CONNECTORS_DIR: CONNECTORS,
      AEP_CONNECTOR_REDIRECT_URI: REDIRECT,
      AEP_MASTER_KEY_FILE: keyFile,
    });
    expect(setup?.catalog.manifests.map((m) => m.id)).toContain("amplitude");
    expect(setup?.key).toHaveLength(32);
  });

  it.each([
    [{ AEP_CONNECTOR_REDIRECT_URI: REDIRECT }, "AEP_MASTER_KEY_FILE is required"],
    [{ AEP_MASTER_KEY_FILE: "/nonexistent/master.key" }, "AEP_CONNECTOR_REDIRECT_URI is required"],
  ])("refuses %j", async (env, reason) => {
    await expect(connectorSetup({ AEP_CONNECTORS_DIR: CONNECTORS, ...env })).rejects.toThrow(
      reason,
    );
  });
});

describe("the worker process", () => {
  it("refuses to start with connectors on and no readable master key", async () => {
    const main = fileURLToPath(new URL("./main.ts", import.meta.url));
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [main],
        {
          env: {
            PATH: process.env["PATH"] ?? "",
            AEP_MODEL_PROVIDER: "fake",
            AEP_CONNECTORS_DIR: CONNECTORS,
            AEP_CONNECTOR_REDIRECT_URI: REDIRECT,
            AEP_MASTER_KEY_FILE: join(dir, "missing.key"),
            // Unreachable on purpose: the check must come before any connection.
            DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
          },
          timeout: 20_000,
        },
        (error, _stdout, stderr) => {
          resolve({ code: error === null ? 0 : (error.code as number | null), stderr });
        },
      );
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot be read");
  }, 30_000);
});
