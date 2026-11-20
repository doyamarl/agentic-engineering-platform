import { sql, type Kysely } from "kysely";

// Personal connections to outside tools (ADR-013, #52).
// - connector_clients: the platform registered as an OAuth client of an MCP server. No tenant
//   data and no secret (dynamic clients here are public), so no row-level security, like
//   api_tokens.
// - connection_authorizations: an OAuth authorization in progress, at most one per person and
//   connector. It holds the PKCE verifier and, once the provider answers, the code, until the
//   worker exchanges them (minutes). Visible to its person only.
// - connections: who is connected to what. Visible to its person, and to a transaction that set
//   app.connection_admin (an admin listing or disconnecting members; the API checks
//   connector:manage first). No tokens here.
// - connection_tokens: the tokens, sealed by the worker under the instance master key. Visible to
//   their person only, even with app.connection_admin.

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
];
const AUDIT_TYPES_AFTER = [
  ...AUDIT_TYPES_BEFORE,
  "connection.connected",
  "connection.disconnected",
];

const typeCheck = (types: readonly string[]) =>
  sql`check (type in (${sql.join(types.map((t) => sql.lit(t)))}))`;

const OWN = sql`tenant_id = current_tenant_id() and user_id = current_user_id()`;

async function protect(db: Kysely<unknown>, table: string, using: ReturnType<typeof sql>) {
  await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
  await sql`alter table ${sql.table(table)} force row level security`.execute(db);
  await sql`create policy person_isolation on ${sql.table(table)} using (${using}) with check (${using})`.execute(
    db,
  );
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function current_connection_admin() returns boolean
      language sql stable
      as $$ select coalesce(current_setting('app.connection_admin', true), '') = 'on' $$
  `.execute(db);

  await sql`
    create table connector_clients (
      connector_id text not null,
      server_id text not null,
      redirect_uri text not null,
      issuer text not null,
      client_id text not null,
      details jsonb not null,
      created_at timestamptz not null default now(),
      primary key (connector_id, server_id, redirect_uri)
    )
  `.execute(db);

  await sql`
    create table connection_authorizations (
      tenant_id uuid not null,
      user_id uuid not null,
      connector_id text not null,
      server_id text not null,
      state text not null unique,
      code_verifier text not null,
      code text,
      iss text,
      error text check (length(error) <= 200),
      status text not null check (status in ('started', 'answered', 'failed')),
      expires_at timestamptz not null,
      updated_at timestamptz not null default now(),
      primary key (tenant_id, user_id, connector_id),
      foreign key (tenant_id, user_id) references memberships (tenant_id, user_id)
    )
  `.execute(db);
  await protect(db, "connection_authorizations", OWN);

  await sql`
    create table connections (
      tenant_id uuid not null,
      user_id uuid not null,
      connector_id text not null,
      server_id text not null,
      status text not null check (status in ('connected', 'expired', 'disconnecting')),
      scope text,
      connected_at timestamptz not null,
      updated_at timestamptz not null,
      primary key (tenant_id, user_id, connector_id),
      foreign key (tenant_id, user_id) references memberships (tenant_id, user_id)
    )
  `.execute(db);
  await protect(
    db,
    "connections",
    sql`tenant_id = current_tenant_id() and (user_id = current_user_id() or current_connection_admin())`,
  );

  await sql`
    create table connection_tokens (
      tenant_id uuid not null,
      user_id uuid not null,
      connector_id text not null,
      access_token text not null,
      refresh_token text,
      expires_at timestamptz,
      primary key (tenant_id, user_id, connector_id),
      foreign key (tenant_id, user_id, connector_id)
        references connections (tenant_id, user_id, connector_id) on delete cascade
    )
  `.execute(db);
  await protect(db, "connection_tokens", OWN);

  await sql`
    alter table audit_events
      drop constraint audit_events_type_check,
      add constraint audit_events_type_check ${typeCheck(AUDIT_TYPES_AFTER)}
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table audit_events
      drop constraint audit_events_type_check,
      add constraint audit_events_type_check ${typeCheck(AUDIT_TYPES_BEFORE)} not valid
  `.execute(db);
  await sql`drop table connection_tokens`.execute(db);
  await sql`drop table connections`.execute(db);
  await sql`drop table connection_authorizations`.execute(db);
  await sql`drop table connector_clients`.execute(db);
  await sql`drop function current_connection_admin()`.execute(db);
}
