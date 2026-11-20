import { sql, type Kysely } from "kysely";

// Least-privilege grants for the role the API and worker connect as. Migration bookkeeping tables
// (kysely_migration*) are deliberately absent. Append-only tables get no UPDATE/DELETE even though
// triggers would also refuse them.
const RUNTIME_GRANTS = {
  tenants: ["select"],
  users: ["select", "insert", "update"],
  workspaces: ["select"],
  memberships: ["select", "insert", "update"],
  missions: ["select", "insert", "update"],
  approvals: ["select", "insert"],
  mission_events: ["select", "insert"],
  plans: ["select", "insert"],
  acceptance_packets: ["select", "insert"],
  artifacts: ["select", "insert"],
  api_tokens: ["select"],
  audit_events: ["select", "insert"],
  password_credentials: ["select", "insert", "update"],
  oidc_identities: ["select", "insert"],
  // Ended sessions are kept (revoked_at); no DELETE.
  sessions: ["select", "insert", "update"],
  // Finished jobs are kept for inspection; no DELETE.
  jobs: ["select", "insert", "update"],
  threads: ["select", "insert", "update"],
  // Unsharing removes rows; who was shared with when is not an audit record yet.
  thread_members: ["select", "insert", "delete"],
  thread_messages: ["select", "insert"],
  thread_events: ["select", "insert"],
  tenant_settings: ["select", "insert", "update"],
  // Shared OAuth client registrations; never changed once made.
  connector_clients: ["select", "insert"],
  // Rows of an authorization in progress go once it ends; connections and tokens go on disconnect.
  connection_authorizations: ["select", "insert", "update", "delete"],
  connections: ["select", "insert", "update", "delete"],
  connection_tokens: ["select", "insert", "update", "delete"],
  // Decisions and closing update rows; nothing is deleted (who decided what stays).
  reply_pauses: ["select", "insert", "update"],
  tool_approvals: ["select", "insert", "update"],
  // Admins remove repositories; the audit log keeps who added and removed what.
  workspace_repositories: ["select", "insert", "delete"],
} as const;

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Must run as the table owner, after migrations. Idempotent. */
export async function grantRuntimeAccess<DB>(db: Kysely<DB>, role: string): Promise<void> {
  if (!ROLE_NAME.test(role)) throw new Error(`invalid role name: ${role}`);
  await sql`grant usage on schema public to ${sql.id(role)}`.execute(db);
  for (const [table, privileges] of Object.entries(RUNTIME_GRANTS)) {
    await sql`revoke all on ${sql.table(table)} from ${sql.id(role)}`.execute(db);
    await sql`grant ${sql.raw(privileges.join(", "))} on ${sql.table(table)} to ${sql.id(role)}`.execute(
      db,
    );
  }
}
