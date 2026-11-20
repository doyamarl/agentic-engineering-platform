import { sql, type Kysely } from "kysely";

// Tenant-first schema (ADR-005, PRD FR-05/FR-07).
// - Every tenant-owned table keys on (tenant_id, id); foreign keys include tenant_id, so a row can
//   only reference rows of its own tenant.
// - approvals, mission_events and artifacts are append-only.
// - Row-level security is defense in depth (ADR §3); the API still authorizes every request.
//   The runtime role must not own these tables or hold BYPASSRLS / TRUNCATE.

const TENANT_TABLES = [
  "workspaces",
  "memberships",
  "missions",
  "approvals",
  "mission_events",
  "artifacts",
] as const;
const APPEND_ONLY_TABLES = ["approvals", "mission_events", "artifacts"] as const;

const MISSION_STATUSES = [
  "DRAFT",
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "APPROVED",
  "EXECUTING",
  "VERIFYING",
  "ACCEPTANCE_READY",
  "AWAITING_RELEASE_APPROVAL",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "CANCEL_REQUESTED",
  "CANCELLED",
];

const inList = (values: readonly string[]) => sql.join(values.map((value) => sql.lit(value)));

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function current_tenant_id() returns uuid
      language sql stable
      as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$
  `.execute(db);

  await sql`
    create function forbid_mutation() returns trigger
      language plpgsql
      as $$ begin
        raise exception '% is append-only', tg_table_name using errcode = 'P0001';
      end $$
  `.execute(db);

  await sql`
    create table tenants (
      id uuid primary key,
      name text not null check (length(name) between 1 and 200),
      created_at timestamptz not null default now()
    )
  `.execute(db);

  await sql`
    create table users (
      id uuid primary key,
      display_name text not null check (length(display_name) between 1 and 200),
      created_at timestamptz not null default now()
    )
  `.execute(db);

  await sql`
    create table workspaces (
      tenant_id uuid not null references tenants (id),
      id uuid not null,
      name text not null check (length(name) between 1 and 200),
      created_at timestamptz not null default now(),
      primary key (tenant_id, id)
    )
  `.execute(db);

  await sql`
    create table memberships (
      tenant_id uuid not null references tenants (id),
      user_id uuid not null references users (id),
      role text not null check (role in ('admin', 'planner', 'engineer', 'viewer')),
      created_at timestamptz not null default now(),
      primary key (tenant_id, user_id)
    )
  `.execute(db);

  await sql`
    create table missions (
      tenant_id uuid not null,
      workspace_id uuid not null,
      id uuid not null,
      title text not null check (length(title) between 1 and 200),
      status text not null check (status in (${inList(MISSION_STATUSES)})),
      state jsonb not null,
      version integer not null default 1 check (version >= 1),
      created_by uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (tenant_id, id),
      foreign key (tenant_id, workspace_id) references workspaces (tenant_id, id),
      foreign key (tenant_id, created_by) references memberships (tenant_id, user_id),
      check (state ->> 'status' = status)
    )
  `.execute(db);
  await sql`create index missions_workspace_created_idx
    on missions (tenant_id, workspace_id, created_at desc)`.execute(db);

  await sql`
    create table approvals (
      tenant_id uuid not null,
      mission_id uuid not null,
      id uuid not null,
      subject text not null check (subject in ('plan', 'acceptance_packet')),
      subject_version integer not null check (subject_version >= 1),
      decision text not null check (decision in ('approved', 'rejected')),
      decided_by uuid not null,
      comment text,
      decided_at timestamptz not null default now(),
      primary key (tenant_id, id),
      foreign key (tenant_id, mission_id) references missions (tenant_id, id),
      foreign key (tenant_id, decided_by) references memberships (tenant_id, user_id)
    )
  `.execute(db);

  await sql`
    create table mission_events (
      tenant_id uuid not null,
      mission_id uuid not null,
      seq bigint not null check (seq >= 1),
      type text not null,
      payload jsonb not null,
      actor_kind text not null check (actor_kind in ('human', 'agent', 'system')),
      actor_id text,
      occurred_at timestamptz not null default now(),
      primary key (tenant_id, mission_id, seq),
      foreign key (tenant_id, mission_id) references missions (tenant_id, id)
    )
  `.execute(db);

  await sql`
    create table artifacts (
      tenant_id uuid not null,
      mission_id uuid not null,
      id uuid not null,
      kind text not null,
      version integer not null check (version >= 1),
      checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
      storage_uri text not null,
      provenance jsonb not null,
      access_policy text not null check (access_policy in ('tenant_members', 'restricted')),
      created_at timestamptz not null default now(),
      primary key (tenant_id, id),
      unique (tenant_id, mission_id, kind, version),
      foreign key (tenant_id, mission_id) references missions (tenant_id, id)
    )
  `.execute(db);

  for (const table of APPEND_ONLY_TABLES) {
    await sql`
      create trigger ${sql.id(`${table}_append_only`)}
        before update or delete on ${sql.table(table)}
        for each row execute function forbid_mutation()
    `.execute(db);
  }

  await sql`alter table tenants enable row level security`.execute(db);
  await sql`alter table tenants force row level security`.execute(db);
  await sql`create policy tenant_isolation on tenants
    using (id = current_tenant_id())`.execute(db);

  for (const table of TENANT_TABLES) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.table(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.table(table)}
        using (tenant_id = current_tenant_id())
        with check (tenant_id = current_tenant_id())
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [...TENANT_TABLES].reverse()) {
    await sql`drop table ${sql.table(table)}`.execute(db);
  }
  await sql`drop table users`.execute(db);
  await sql`drop table tenants`.execute(db);
  await sql`drop function forbid_mutation()`.execute(db);
  await sql`drop function current_tenant_id()`.execute(db);
}
