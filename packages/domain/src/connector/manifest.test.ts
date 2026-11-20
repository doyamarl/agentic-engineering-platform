import { describe, expect, it } from "vitest";
import {
  checkEgress,
  checkToolCall,
  type ConnectorManifest,
  manifestProblems,
} from "./manifest.ts";

const manifest: ConnectorManifest = {
  id: "analytics",
  name: "Analytics",
  description: "Funnels",
  servers: [
    { id: "us", label: "US", url: "https://mcp.example.com/mcp" },
    { id: "eu", label: "EU", url: "https://mcp.eu.example.com/mcp" },
  ],
  auth: { type: "oauth2", registration: "dynamic", scopes: ["read"] },
  tools: [
    { name: "query", class: "read" },
    { name: "save_chart", class: "write" },
  ],
  egressHosts: ["mcp.example.com", "mcp.eu.example.com"],
  sources: [{ claim: "endpoints", url: "https://example.com/docs", checkedOn: "2026-11-15" }],
};

const strict = { allowHttp: false };
const US = { id: "us", label: "US", url: "https://mcp.example.com/mcp" };

describe("manifestProblems", () => {
  it("accepts a consistent manifest", () => {
    expect(manifestProblems(manifest, strict)).toEqual([]);
  });

  it("requires every server to be on an egress host", () => {
    const problems = manifestProblems({ ...manifest, egressHosts: ["mcp.example.com"] }, strict);
    expect(problems).toEqual(["server eu: host mcp.eu.example.com is not in egressHosts"]);
  });

  it("rejects repeated tools, servers and hosts, and a bad id", () => {
    const problems = manifestProblems(
      {
        ...manifest,
        id: "Analytics",
        servers: [US, US],
        tools: [...manifest.tools, { name: "query", class: "write" }],
        egressHosts: [...manifest.egressHosts, "mcp.example.com", "MCP.example.org"],
      },
      strict,
    );
    expect(problems).toEqual([
      "id Analytics is not a connector id",
      "egressHosts repeat a host",
      "egress host MCP.example.org is not lowercase",
      "server id us repeats",
      "tool query repeats",
    ]);
  });

  it("rejects a plain HTTP server unless HTTP is allowed for tests", () => {
    const local = {
      ...manifest,
      servers: [{ id: "local", label: "Local", url: "http://mock-mcp:8080/mcp" }],
      egressHosts: ["mock-mcp"],
    };
    expect(manifestProblems(local, strict)).toEqual(["server local: http: is not allowed"]);
    expect(manifestProblems(local, { allowHttp: true })).toEqual([]);
  });
});

describe("checkToolCall", () => {
  it("returns the declared tool with its class", () => {
    expect(checkToolCall(manifest, "save_chart")).toEqual({
      ok: true,
      value: { name: "save_chart", class: "write" },
    });
  });

  it("refuses a tool the manifest does not list", () => {
    expect(checkToolCall(manifest, "delete_project")).toEqual({
      ok: false,
      error: { kind: "ToolRefused", connectorId: "analytics", tool: "delete_project" },
    });
  });
});

describe("checkEgress", () => {
  it.each([
    ["https://mcp.example.com/mcp", undefined],
    [
      "https://mcp.example.com.attacker.test/mcp",
      "host mcp.example.com.attacker.test is not in egressHosts",
    ],
    ["https://user:pass@mcp.example.com/mcp", "URL carries credentials"],
    ["ftp://mcp.example.com/", "ftp: is not allowed"],
    ["not a url", "not a URL"],
  ])("%s", (url, reason) => {
    const result = checkEgress(manifest, url, strict);
    if (reason === undefined) expect(result.ok).toBe(true);
    else
      expect(result).toEqual({
        ok: false,
        error: { kind: "EgressRefused", connectorId: "analytics", reason },
      });
  });
});
