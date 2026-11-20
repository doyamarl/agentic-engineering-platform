import type { ColumnType, Generated } from "kysely";

// Row types for the tables created in migrations/. Keep in sync with the migrations;
// schema.test.ts inserts through these types against a real database.

type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
/** jsonb columns are written as serialized JSON text and read back as parsed values. */
type Json = ColumnType<unknown, string, string>;

export type MembershipRole = "admin" | "planner" | "engineer" | "viewer";

export interface TenantsTable {
  id: string;
  name: string;
  created_at: CreatedAt;
}

export interface UsersTable {
  id: string;
  display_name: string;
  /** Lower-case and trimmed; unique across the instance. */
  email: string | null;
  disabled_at: Date | null;
  created_at: CreatedAt;
}

export interface WorkspacesTable {
  tenant_id: string;
  id: string;
  name: string;
  created_at: CreatedAt;
}

export interface MembershipsTable {
  tenant_id: string;
  user_id: string;
  role: MembershipRole;
  created_at: CreatedAt;
}

export interface MissionsTable {
  tenant_id: string;
  workspace_id: string;
  id: string;
  title: string;
  status: string;
  state: Json;
  source: ColumnType<unknown, string | null | undefined, string | null>;
  version: Generated<number>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ApprovalsTable {
  tenant_id: string;
  mission_id: string;
  id: string;
  subject: "plan" | "acceptance_packet";
  subject_version: number;
  decision: "approved" | "rejected";
  decided_by: string;
  comment: ColumnType<string | null, string | null | undefined, never>;
  decided_at: CreatedAt;
}

export interface MissionEventsTable {
  tenant_id: string;
  mission_id: string;
  /** bigint; pg returns int8 as string to avoid precision loss. */
  seq: ColumnType<string, string, never>;
  type: string;
  payload: Json;
  actor_kind: "human" | "agent" | "system";
  actor_id: string | null;
  occurred_at: CreatedAt;
}

export interface PlansTable {
  tenant_id: string;
  mission_id: string;
  version: number;
  body: string;
  checksum_sha256: string;
  author_kind: "human" | "agent" | "system";
  author_id: string | null;
  created_at: CreatedAt;
}

export interface AcceptancePacketsTable {
  tenant_id: string;
  mission_id: string;
  version: number;
  /** JSON text, exactly as hashed. */
  content: string;
  checksum_sha256: string;
  created_at: CreatedAt;
}

export interface ArtifactsTable {
  tenant_id: string;
  mission_id: string;
  id: string;
  kind: string;
  version: number;
  checksum_sha256: string;
  storage_uri: string;
  provenance: Json;
  access_policy: "tenant_members" | "restricted";
  created_at: CreatedAt;
}

export interface ApiTokensTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: CreatedAt;
  expires_at: Date | null;
  revoked_at: Date | null;
}

export interface OidcIdentitiesTable {
  issuer: string;
  subject: string;
  tenant_id: string;
  user_id: string;
  created_at: CreatedAt;
}

export interface PasswordCredentialsTable {
  user_id: string;
  tenant_id: string;
  password_hash: string;
  must_change_password: boolean;
  failed_attempts: Generated<number>;
  locked_until: Date | null;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface SessionsTable {
  id: string;
  tenant_id: string;
  user_id: string;
  refresh_hash: string;
  previous_refresh_hash: string | null;
  created_at: CreatedAt;
  last_used_at: ColumnType<Date, Date | string | undefined, Date | string>;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  rotated_at: Generated<Date | null>;
}

export interface AuditEventsTable {
  id: Generated<string>;
  tenant_id: string;
  type: string;
  actor_user_id: string | null;
  subject_user_id: string | null;
  payload: Json;
  occurred_at: CreatedAt;
}

export interface JobsTable {
  id: Generated<string>;
  tenant_id: string;
  kind: string;
  idempotency_key: string;
  payload: Json;
  status: Generated<"queued" | "running" | "succeeded" | "dead">;
  attempts: Generated<number>;
  max_attempts: number;
  run_after: ColumnType<Date, Date | string | undefined, Date | string>;
  locked_by: string | null;
  locked_until: Date | null;
  last_error: string | null;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
  finished_at: Date | null;
}

export type ReplyEffort = "low" | "medium" | "high";

export type ThreadVisibilityKind = "personal" | "members" | "workspace";

export interface ThreadsTable {
  tenant_id: string;
  workspace_id: string;
  id: string;
  owner_id: string;
  title: string;
  visibility: ColumnType<
    ThreadVisibilityKind,
    ThreadVisibilityKind | undefined,
    ThreadVisibilityKind
  >;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ThreadMembersTable {
  tenant_id: string;
  thread_id: string;
  /** The thread's owner, repeated so the RLS policy need not read threads. */
  owner_id: string;
  user_id: string;
  added_at: CreatedAt;
}

export interface ThreadMessagesTable {
  tenant_id: string;
  thread_id: string;
  id: string;
  role: "user" | "assistant";
  author_id: string | null;
  content: string;
  /** The user message an assistant message answers; null for user messages. */
  in_reply_to: ColumnType<string | null, string | null | undefined, never>;
  /** The effort a person chose for the reply to this message. */
  effort: ColumnType<ReplyEffort | null, ReplyEffort | null | undefined, never>;
  /** The model that wrote a reply. */
  model: ColumnType<string | null, string | null | undefined, never>;
  created_at: CreatedAt;
}

export interface ThreadEventsTable {
  tenant_id: string;
  thread_id: string;
  /** bigint; pg returns int8 as string to avoid precision loss. */
  seq: ColumnType<string, string, never>;
  type: string;
  payload: Json;
  actor_kind: "human" | "agent" | "system";
  actor_id: string | null;
  occurred_at: CreatedAt;
}

export interface TenantSettingsTable {
  tenant_id: string;
  /** Null: the instance default. */
  chat_model: string | null;
  updated_by: string;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ConnectorClientsTable {
  connector_id: string;
  server_id: string;
  redirect_uri: string;
  issuer: string;
  client_id: string;
  details: ColumnType<Record<string, unknown>, string, string>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface ConnectionAuthorizationsTable {
  tenant_id: string;
  user_id: string;
  connector_id: string;
  server_id: string;
  state: string;
  code_verifier: string;
  code: string | null;
  iss: string | null;
  error: string | null;
  status: "started" | "answered" | "failed";
  expires_at: ColumnType<Date, Date | string, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ConnectionsTable {
  tenant_id: string;
  user_id: string;
  connector_id: string;
  server_id: string;
  status: "connected" | "expired" | "disconnecting";
  scope: string | null;
  connected_at: ColumnType<Date, Date | string, Date | string>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface ConnectionTokensTable {
  tenant_id: string;
  user_id: string;
  connector_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface ReplyPausesTable {
  tenant_id: string;
  id: string;
  thread_id: string;
  message_id: string;
  requested_by: string;
  /** JSON text on insert (kysely does not serialise objects); parsed on select. */
  snapshot: ColumnType<unknown, string | null, string | null>;
  created_at: ColumnType<Date, Date | string, never>;
  closed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface ToolApprovalsTable {
  tenant_id: string;
  id: string;
  pause_id: string;
  requested_by: string;
  call_id: string;
  connector_id: string;
  tool: string;
  input: ColumnType<unknown, string, never>;
  status: "pending" | "approved" | "rejected" | "expired" | "executing" | "done";
  decided_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface WorkspaceRepositoriesTable {
  tenant_id: string;
  workspace_id: string;
  owner: string;
  name: string;
  added_by: string;
  added_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface Database {
  api_tokens: ApiTokensTable;
  audit_events: AuditEventsTable;
  oidc_identities: OidcIdentitiesTable;
  password_credentials: PasswordCredentialsTable;
  sessions: SessionsTable;
  jobs: JobsTable;
  tenants: TenantsTable;
  users: UsersTable;
  workspaces: WorkspacesTable;
  memberships: MembershipsTable;
  missions: MissionsTable;
  approvals: ApprovalsTable;
  mission_events: MissionEventsTable;
  plans: PlansTable;
  acceptance_packets: AcceptancePacketsTable;
  artifacts: ArtifactsTable;
  threads: ThreadsTable;
  thread_members: ThreadMembersTable;
  thread_messages: ThreadMessagesTable;
  thread_events: ThreadEventsTable;
  tenant_settings: TenantSettingsTable;
  connector_clients: ConnectorClientsTable;
  connection_authorizations: ConnectionAuthorizationsTable;
  connections: ConnectionsTable;
  connection_tokens: ConnectionTokensTable;
  reply_pauses: ReplyPausesTable;
  tool_approvals: ToolApprovalsTable;
  workspace_repositories: WorkspaceRepositoriesTable;
}
