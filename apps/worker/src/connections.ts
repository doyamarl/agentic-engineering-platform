import {
  connectionHandlers,
  connectorGateway,
  type ConnectorCatalog,
  type ConnectorGateway,
  type ToolApprovalRepository,
} from "@aep/application";
import { loadConnectorManifests } from "@aep/connector-manifests";
import { mcpOAuth, mcpTools } from "@aep/connector-mcp";
import {
  PostgresAuditLog,
  PostgresConnections,
  PostgresConnectorClients,
  PostgresToolApprovals,
  type Database,
} from "@aep/postgres";
import { aesGcmSecretBox, loadMasterKey } from "@aep/secrets-local";
import type { Kysely } from "kysely";
import type { ChatHandlers } from "./chat.ts";

// Connector jobs (ADR-013, #52): exchanging a code for tokens and revoking them on disconnect.
//
// AEP_CONNECTORS_DIR: `<id>/manifest.json` files; unset, connectors are off.
// AEP_CONNECTOR_REDIRECT_URI: the web UI's /connections/oauth/callback, as the API has it.
// AEP_MASTER_KEY_FILE: 32 bytes in base64 (`openssl rand -base64 32`). Only the worker reads it.
// AEP_CONNECTORS_ALLOW_HTTP=true: http:// servers, for the mock server in tests only.
//
// With connectors on, an invalid manifest or a missing or malformed key throws: the worker
// refuses to start rather than run without the means to protect tokens.

export type ConnectorSetup = { readonly catalog: ConnectorCatalog; readonly key: Buffer };

export async function connectorSetup(env: NodeJS.ProcessEnv): Promise<ConnectorSetup | undefined> {
  const dir = env["AEP_CONNECTORS_DIR"]?.trim();
  if (dir === undefined || dir === "") return undefined;
  const redirect = env["AEP_CONNECTOR_REDIRECT_URI"]?.trim();
  if (redirect === undefined || redirect === "") {
    throw new Error("AEP_CONNECTOR_REDIRECT_URI is required with AEP_CONNECTORS_DIR");
  }
  const keyFile = env["AEP_MASTER_KEY_FILE"]?.trim();
  if (keyFile === undefined || keyFile === "") {
    throw new Error("AEP_MASTER_KEY_FILE is required with AEP_CONNECTORS_DIR");
  }
  const key = loadMasterKey(keyFile);
  const manifests = await loadConnectorManifests(dir, {
    allowHttp: env["AEP_CONNECTORS_ALLOW_HTTP"] === "true",
  });
  return { catalog: { manifests, redirectUri: new URL(redirect).toString() }, key };
}

export function connectorHandlers(
  setup: ConnectorSetup,
  db: Kysely<Database>,
  env: NodeJS.ProcessEnv,
): ChatHandlers {
  return connectionHandlers({
    catalog: setup.catalog,
    connections: new PostgresConnections(db),
    clients: new PostgresConnectorClients(db),
    oauth: mcpOAuth({ allowHttp: env["AEP_CONNECTORS_ALLOW_HTTP"] === "true" }),
    box: aesGcmSecretBox(setup.key),
    now: () => new Date(),
  });
}

/** The gateway thread replies call connector tools through; only the worker holds the key. */
export function connectorGatewayFor(
  setup: ConnectorSetup,
  db: Kysely<Database>,
  env: NodeJS.ProcessEnv,
): { readonly gateway: ConnectorGateway; readonly approvals: ToolApprovalRepository } {
  const approvals = new PostgresToolApprovals(db);
  const egress = { allowHttp: env["AEP_CONNECTORS_ALLOW_HTTP"] === "true" };
  const gateway = connectorGateway({
    catalog: setup.catalog,
    connections: new PostgresConnections(db),
    clients: new PostgresConnectorClients(db),
    oauth: mcpOAuth(egress),
    mcp: mcpTools(egress),
    box: aesGcmSecretBox(setup.key),
    audit: new PostgresAuditLog(db),
    // Write tools run only under an approval given in the thread (#52 decision 2).
    approvals,
    now: () => new Date(),
  });
  return { gateway, approvals };
}
