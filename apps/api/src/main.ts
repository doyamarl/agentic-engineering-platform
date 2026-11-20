import { readFileSync } from "node:fs";
import { loadConnectorManifests } from "@aep/connector-manifests";
import { mcpOAuth } from "@aep/connector-mcp";
import { OpenIdProvider } from "@aep/identity-oidc";
import { buildApp } from "./app.ts";
import { connectDatabase, requireEnv } from "./database.ts";
import { postgresDependencies, type AuthOptions, type ConnectorOptions } from "./dependencies.ts";

/**
 * AEP_AUTH_METHODS lists the login methods for people (ADR-011): "password", "oidc" or both.
 * Either needs AEP_ACCESS_TOKEN_SECRET_FILE, a file of at least 32 bytes (for example
 * `openssl rand -base64 48`). "oidc" also needs AEP_OIDC_ISSUER, AEP_OIDC_CLIENT_ID,
 * AEP_OIDC_CLIENT_SECRET_FILE and AEP_OIDC_REDIRECT_URI (the web UI's /login/oidc/callback,
 * registered at the provider); AEP_OIDC_NAME labels the button, and AEP_OIDC_ALLOW_HTTP=true
 * permits an http:// issuer for local tests. Unset: only API tokens authenticate.
 */
function authOptions(): AuthOptions {
  const methods = (process.env["AEP_AUTH_METHODS"] ?? "")
    .split(",")
    .map((method) => method.trim())
    .filter((method) => method !== "");
  const unknown = methods.filter((method) => method !== "password" && method !== "oidc");
  if (unknown.length > 0) {
    console.error(`unsupported AEP_AUTH_METHODS: ${unknown.join(", ")}`);
    process.exit(1);
  }
  if (methods.length === 0) return {};
  const readSecret = (name: string) => readFileSync(requireEnv(name), "utf8").trim();
  return {
    accessTokenSecret: new TextEncoder().encode(readSecret("AEP_ACCESS_TOKEN_SECRET_FILE")),
    password: methods.includes("password"),
    ...(methods.includes("oidc")
      ? {
          oidc: {
            provider: new OpenIdProvider({
              issuer: new URL(requireEnv("AEP_OIDC_ISSUER")),
              clientId: requireEnv("AEP_OIDC_CLIENT_ID"),
              clientSecret: readSecret("AEP_OIDC_CLIENT_SECRET_FILE"),
              redirectUri: new URL(requireEnv("AEP_OIDC_REDIRECT_URI")),
              name: process.env["AEP_OIDC_NAME"] ?? "シングルサインオン",
              allowHttp: process.env["AEP_OIDC_ALLOW_HTTP"] === "true",
            }),
            redirectUri: new URL(requireEnv("AEP_OIDC_REDIRECT_URI")),
          },
        }
      : {}),
  };
}

/**
 * Connectors (ADR-013): AEP_CONNECTORS_DIR holds `<id>/manifest.json` files (the image ships
 * `connectors/`), and AEP_CONNECTOR_REDIRECT_URI is the web UI's /connections/oauth/callback.
 * AEP_CONNECTORS_ALLOW_HTTP=true permits http:// servers, for the mock server in tests only.
 * Unset directory: no connector is offered. An invalid manifest stops the API.
 */
async function connectorOptions(): Promise<ConnectorOptions | undefined> {
  const dir = process.env["AEP_CONNECTORS_DIR"]?.trim();
  if (dir === undefined || dir === "") return undefined;
  const egress = { allowHttp: process.env["AEP_CONNECTORS_ALLOW_HTTP"] === "true" };
  try {
    return {
      catalog: {
        manifests: await loadConnectorManifests(dir, egress),
        redirectUri: new URL(requireEnv("AEP_CONNECTOR_REDIRECT_URI")).toString(),
      },
      oauth: mcpOAuth(egress),
    };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const connectors = await connectorOptions();
const db = connectDatabase(requireEnv("DATABASE_URL"));
const app = buildApp(postgresDependencies(db, authOptions(), connectors), { logger: true });

const port = Number(process.env["PORT"] ?? "3000");
await app.listen({ host: process.env["HOST"] ?? "0.0.0.0", port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => db.destroy());
  });
}
