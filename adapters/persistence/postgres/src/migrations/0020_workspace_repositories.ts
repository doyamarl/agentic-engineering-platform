import { sql, type Kysely } from "kysely";

// The GitHub repositories of a workspace (#52 scope 7, owner decision 2026-11-17): chat replies in
// the workspace's threads may read these through the instance's GitHub App, and no others.
// GitHub names are case-insensitive, so a repository is unique per workspace ignoring case.
// Admins add and remove rows; both are audited.
//
// Numbered 0020 so that 0019 (approval expiry, #62) keeps its number whichever merges first.

const AUDIT_TYPES_BEFORE = [
  "member.created",
  "member.role_changed",
  "member.disabled",
  "member.enabled",
  "member.password_reset",
  "login.succeeded",
  "login.failed",
  "password.changed",
  "settings.chat_model_changed",
  "connection.connected",
  "connection.disconnected",
  "connector.tool_called",
  "connector.tool_decided",
];
const AUDIT_TYPES_AFTER = [
  ...AUDIT_TYPES_BEFORE,
  "workspace.repository_added",
  "workspace.repository_removed",
];

const typeCheck = (types: readonly string[]) =>
  sql`check (type in (${sql.join(types.map((t) => sql.lit(t)))}))`;

/** The rules of GitHub names that `isGitHubName` checks, kept by the database too. */
const GITHUB_NAME = sql.lit("^[A-Za-z0-9_.-]{1,100}$");

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table workspace_repositories (
      tenant_id uuid not null,
      workspace_id uuid not null,
      owner text not null check (owner ~ ${GITHUB_NAME} and owner not in ('.', '..')),
      name text not null check (name ~ ${GITHUB_NAME} and name not in ('.', '..')),
      added_by uuid not null,
      added_at timestamptz not null default now(),
      foreign key (tenant_id, workspace_id) references workspaces (tenant_id, id),
      foreign key (tenant_id, added_by) references memberships (tenant_id, user_id)
    )
  `.execute(db);
  await sql`
    create unique index workspace_repositories_unique
      on workspace_repositories (tenant_id, workspace_id, lower(owner), lower(name))
  `.execute(db);
  await sql`alter table workspace_repositories enable row level security`.execute(db);
  await sql`alter table workspace_repositories force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on workspace_repositories
      using (tenant_id = current_tenant_id())
      with check (tenant_id = current_tenant_id())
  `.execute(db);

  await sql`
    alter table audit_events
      drop constraint audit_events_type_check,
      add constraint audit_events_type_check ${typeCheck(AUDIT_TYPES_AFTER)}
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Audit events are append-only, so recorded changes stay; the old check skips them.
  await sql`
    alter table audit_events
      drop constraint audit_events_type_check,
      add constraint audit_events_type_check ${typeCheck(AUDIT_TYPES_BEFORE)} not valid
  `.execute(db);
  await sql`drop table workspace_repositories`.execute(db);
}
