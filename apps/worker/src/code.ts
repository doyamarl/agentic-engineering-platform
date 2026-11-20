import { readFileSync } from "node:fs";
import {
  CODE_CONNECTOR,
  workspaceCodeTools,
  type CodeTools,
  type ConnectorCatalog,
} from "@aep/application";
import { gitHubApp, gitHubCodeReader, type GitHubApp } from "@aep/git-github";
import { PostgresAuditLog, PostgresWorkspaceRepositories, type Database } from "@aep/postgres";
import type { Kysely } from "kysely";

// Chat tools over the code of a thread's workspace (#52 scope 7), read through the instance's
// GitHub App. On when AEP_GITHUB_APP_ID and AEP_GITHUB_PRIVATE_KEY_PATH are set, as for missions;
// a workspace offers them once an admin registers its repositories.
//
// The tools are named `github__*`, so a connector manifest with the id `github` would collide:
// the worker refuses to start with both.

export type CodeSetup = { readonly app: GitHubApp };

export function codeSetup(
  env: NodeJS.ProcessEnv,
  catalog: ConnectorCatalog | undefined,
): CodeSetup | undefined {
  const appId = env["AEP_GITHUB_APP_ID"]?.trim() ?? "";
  const keyPath = env["AEP_GITHUB_PRIVATE_KEY_PATH"]?.trim() ?? "";
  if (appId === "" || keyPath === "") return undefined;
  if (catalog?.manifests.some((m) => m.id === CODE_CONNECTOR)) {
    throw new Error(
      `connector id "${CODE_CONNECTOR}" is reserved for the workspace's code tools; rename the manifest`,
    );
  }
  return { app: gitHubApp({ appId, privateKey: readFileSync(keyPath, "utf8") }) };
}

export function codeToolsFor(setup: CodeSetup, db: Kysely<Database>): CodeTools {
  return workspaceCodeTools({
    repositories: new PostgresWorkspaceRepositories(db),
    reader: gitHubCodeReader({ app: setup.app }),
    audit: new PostgresAuditLog(db),
  });
}
