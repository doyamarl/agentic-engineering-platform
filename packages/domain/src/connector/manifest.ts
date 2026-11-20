import { err, ok, type Result } from "../result.ts";

// Connector manifests (ADR-013, PRD FR-16). A manifest declares an MCP server, how a person
// connects to it, the tools the platform may call and the hosts it may reach. The gateway refuses
// any call outside it. The file format is validated by `@aep/connector-manifests`; the rules here
// are the ones a schema cannot express, and the decisions the gateway makes per call.

/**
 * `read` tools only read. `write` covers write, delete and send, and every call needs a person's
 * approval. A tool that does both, depending on its arguments, is `write`.
 */
export type ToolClass = "read" | "write";

export type ConnectorTool = {
  readonly name: string;
  readonly class: ToolClass;
};

/** One endpoint of the MCP server, e.g. a data region. The first is the default. */
export type ConnectorServer = {
  readonly id: string;
  readonly label: string;
  /** Streamable HTTP endpoint. */
  readonly url: string;
};

export type ConnectorAuth = {
  readonly type: "oauth2";
  /**
   * `dynamic`: the platform registers itself with the authorization server (RFC 7591) once per
   * instance and connector. `manual`: an admin registers a client at the provider and enters it.
   */
  readonly registration: "dynamic" | "manual";
  readonly scopes: readonly string[];
};

/** Where a statement in the manifest was checked, so a reviewer can check it again. */
export type ManifestSource = {
  readonly claim: string;
  readonly url: string;
  /** YYYY-MM-DD. */
  readonly checkedOn: string;
};

export type ConnectorManifest = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly servers: readonly ConnectorServer[];
  readonly auth: ConnectorAuth;
  readonly tools: readonly ConnectorTool[];
  /** Hostnames the gateway may reach for this connector. Every server URL must be on one. */
  readonly egressHosts: readonly string[];
  readonly sources: readonly ManifestSource[];
};

export const CONNECTOR_ID = /^[a-z][a-z0-9-]{1,62}$/;

export type EgressOptions = {
  /** Plain HTTP is allowed only for local tests (mock servers); never in a deployment. */
  readonly allowHttp: boolean;
};

/** Rules across fields. An empty list means the manifest is consistent. */
export function manifestProblems(manifest: ConnectorManifest, options: EgressOptions): string[] {
  const problems: string[] = [];
  if (!CONNECTOR_ID.test(manifest.id)) problems.push(`id ${manifest.id} is not a connector id`);
  const egress = new Set(manifest.egressHosts);
  if (egress.size !== manifest.egressHosts.length) problems.push("egressHosts repeat a host");
  for (const host of manifest.egressHosts) {
    if (host !== host.toLowerCase()) problems.push(`egress host ${host} is not lowercase`);
  }
  const serverIds = new Set<string>();
  for (const server of manifest.servers) {
    if (serverIds.has(server.id)) problems.push(`server id ${server.id} repeats`);
    serverIds.add(server.id);
    const checked = checkEgress(manifest, server.url, options);
    if (!checked.ok) problems.push(`server ${server.id}: ${checked.error.reason}`);
  }
  const toolNames = new Set<string>();
  for (const tool of manifest.tools) {
    if (toolNames.has(tool.name)) problems.push(`tool ${tool.name} repeats`);
    toolNames.add(tool.name);
  }
  return problems;
}

export type ToolRefused = {
  readonly kind: "ToolRefused";
  readonly connectorId: string;
  readonly tool: string;
};

/** The tool as the manifest declares it, or refused when the manifest does not list it. */
export function checkToolCall(
  manifest: ConnectorManifest,
  tool: string,
): Result<ConnectorTool, ToolRefused> {
  const declared = manifest.tools.find((t) => t.name === tool);
  return declared === undefined
    ? err({ kind: "ToolRefused", connectorId: manifest.id, tool })
    : ok(declared);
}

export type EgressRefused = {
  readonly kind: "EgressRefused";
  readonly connectorId: string;
  readonly reason: string;
};

/** The URL when the gateway may reach it for this connector, else refused. */
export function checkEgress(
  manifest: ConnectorManifest,
  raw: string,
  options: EgressOptions,
): Result<URL, EgressRefused> {
  const refuse = (reason: string) =>
    err<EgressRefused>({ kind: "EgressRefused", connectorId: manifest.id, reason });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("not a URL");
  }
  if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) {
    return refuse(`${url.protocol} is not allowed`);
  }
  if (url.username !== "" || url.password !== "") return refuse("URL carries credentials");
  if (!manifest.egressHosts.includes(url.hostname)) {
    return refuse(`host ${url.hostname} is not in egressHosts`);
  }
  return ok(url);
}
