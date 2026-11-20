import type { Kysely } from "kysely";
import { Migrator, NO_MIGRATIONS, type Migration, type MigrationResultSet } from "kysely/migration";
import * as tenantSchema from "./migrations/0001_tenant_schema.ts";
import * as apiTokens from "./migrations/0002_api_tokens.ts";
import * as jobs from "./migrations/0003_jobs.ts";
import * as missionSource from "./migrations/0004_mission_source.ts";
import * as plans from "./migrations/0005_plans.ts";
import * as approvalCommentLength from "./migrations/0006_approval_comment_length.ts";
import * as acceptancePackets from "./migrations/0007_acceptance_packets.ts";
import * as passwordLogin from "./migrations/0008_password_login.ts";
import * as memberAdmin from "./migrations/0009_member_admin.ts";
import * as sessionRotatedAt from "./migrations/0010_session_rotated_at.ts";
import * as oidcIdentities from "./migrations/0011_oidc_identities.ts";
import * as threads from "./migrations/0012_threads.ts";
import * as threadReplies from "./migrations/0013_thread_replies.ts";
import * as messageEffortModel from "./migrations/0014_message_effort_model.ts";
import * as tenantSettings from "./migrations/0015_tenant_settings.ts";
import * as connections from "./migrations/0016_connections.ts";
import * as connectorToolAudit from "./migrations/0017_connector_tool_audit.ts";
import * as toolApprovals from "./migrations/0018_tool_approvals.ts";
import * as approvalExpiry from "./migrations/0019_approval_expiry.ts";
import * as workspaceRepositories from "./migrations/0020_workspace_repositories.ts";

// Migrations are registered explicitly rather than discovered from the filesystem, so the set
// that runs is exactly what was type-checked and reviewed.
const migrations: Record<string, Migration> = {
  "0001_tenant_schema": tenantSchema,
  "0002_api_tokens": apiTokens,
  "0003_jobs": jobs,
  "0004_mission_source": missionSource,
  "0005_plans": plans,
  "0006_approval_comment_length": approvalCommentLength,
  "0007_acceptance_packets": acceptancePackets,
  "0008_password_login": passwordLogin,
  "0009_member_admin": memberAdmin,
  "0010_session_rotated_at": sessionRotatedAt,
  "0011_oidc_identities": oidcIdentities,
  "0012_threads": threads,
  "0013_thread_replies": threadReplies,
  "0014_message_effort_model": messageEffortModel,
  "0015_tenant_settings": tenantSettings,
  "0016_connections": connections,
  "0017_connector_tool_audit": connectorToolAudit,
  "0018_tool_approvals": toolApprovals,
  "0019_approval_expiry": approvalExpiry,
  "0020_workspace_repositories": workspaceRepositories,
};

const migrator = (db: Kysely<unknown>): Migrator =>
  new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });

function unwrap({ error, results }: MigrationResultSet): void {
  if (error !== undefined) {
    const failed = results?.find((result) => result.status === "Error")?.migrationName;
    throw new Error(`migration ${failed ?? "(unknown)"} failed`, { cause: error });
  }
}

export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<void> {
  unwrap(await migrator(db as Kysely<unknown>).migrateToLatest());
}

export async function migrateDownToZero<DB>(db: Kysely<DB>): Promise<void> {
  unwrap(await migrator(db as Kysely<unknown>).migrateTo(NO_MIGRATIONS));
}
