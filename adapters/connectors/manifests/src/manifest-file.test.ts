import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConnectorManifests, ManifestError, parseConnectorManifest } from "./manifest-file.ts";

const REPO_CONNECTORS = join(import.meta.dirname, "../../../../connectors");
const strict = { allowHttp: false };

const valid = {
  id: "analytics",
  name: "Analytics",
  description: "Funnels",
  servers: [{ id: "us", label: "US", url: "https://mcp.example.com/mcp" }],
  auth: { type: "oauth2", registration: "dynamic", scopes: ["read"] },
  tools: [{ name: "query", class: "read" }],
  egressHosts: ["mcp.example.com"],
  sources: [{ claim: "endpoint", url: "https://example.com/docs", checkedOn: "2026-11-15" }],
};

const problemsOf = (json: unknown): readonly string[] => {
  try {
    parseConnectorManifest(json, "test", strict);
  } catch (error) {
    if (error instanceof ManifestError) return error.problems;
    throw error;
  }
  return [];
};

describe("the manifests in this repository", () => {
  it("are valid", async () => {
    const manifests = await loadConnectorManifests(REPO_CONNECTORS, strict);
    expect(manifests.map((m) => m.id)).toContain("amplitude");
  });

  it("Amplitude asks only for read scopes and allows only read tools", async () => {
    const [amplitude] = (await loadConnectorManifests(REPO_CONNECTORS, strict)).filter(
      (m) => m.id === "amplitude",
    );
    expect(amplitude?.auth.scopes).toEqual(["all:read", "offline_access"]);
    expect(amplitude?.tools.every((t) => t.class === "read")).toBe(true);
  });
});

describe("parseConnectorManifest", () => {
  it("accepts a valid manifest", () => {
    expect(problemsOf(valid)).toEqual([]);
  });

  it("rejects unknown keys, so a misspelt restriction cannot be dropped", () => {
    expect(problemsOf({ ...valid, egresHosts: ["evil.test"] })).toEqual([
      '(root): Unrecognized key: "egresHosts"',
    ]);
  });

  it("rejects an unknown tool class", () => {
    expect(problemsOf({ ...valid, tools: [{ name: "query", class: "admin" }] })).toHaveLength(1);
  });

  it("applies the rules across fields", () => {
    expect(problemsOf({ ...valid, egressHosts: ["other.example.com"] })).toEqual([
      "server us: host mcp.example.com is not in egressHosts",
    ]);
  });
});

describe("loadConnectorManifests", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aep-manifests-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const put = async (name: string, content: string) => {
    await mkdir(join(dir, name));
    await writeFile(join(dir, name, "manifest.json"), content);
  };

  it("requires the directory name to match the id", async () => {
    await put("other", JSON.stringify(valid));
    await expect(loadConnectorManifests(dir, strict)).rejects.toThrow(
      "id analytics does not match the directory other",
    );
  });

  it("fails the whole load when one file is not JSON", async () => {
    await put("analytics", JSON.stringify(valid));
    await put("broken", "{");
    await expect(loadConnectorManifests(dir, strict)).rejects.toBeInstanceOf(ManifestError);
  });
});
