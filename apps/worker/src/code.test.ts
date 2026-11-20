import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorCatalog } from "@aep/application";
import type { ConnectorManifest } from "@aep/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeSetup } from "./code.ts";

let dir: string;
let keyPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aep-worker-code-"));
  keyPath = join(dir, "app.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const catalog = (ids: readonly string[]): ConnectorCatalog => ({
  manifests: ids.map((id) => ({ id }) as ConnectorManifest),
  redirectUri: "https://aep.example.com/connections/oauth/callback",
});

describe("codeSetup", () => {
  it("is off without the GitHub App", () => {
    expect(codeSetup({}, undefined)).toBeUndefined();
    expect(codeSetup({ AEP_GITHUB_APP_ID: "1" }, undefined)).toBeUndefined();
  });

  it("is on with the GitHub App, alongside other connectors", () => {
    const env = { AEP_GITHUB_APP_ID: "1", AEP_GITHUB_PRIVATE_KEY_PATH: keyPath };
    expect(codeSetup(env, catalog(["amplitude"]))).toBeDefined();
  });

  it("refuses a connector manifest that takes the code tools' id", () => {
    const env = { AEP_GITHUB_APP_ID: "1", AEP_GITHUB_PRIVATE_KEY_PATH: keyPath };
    expect(() => codeSetup(env, catalog(["github"]))).toThrow(/reserved/);
  });
});
