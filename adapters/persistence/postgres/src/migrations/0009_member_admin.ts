import { sql, type Kysely } from "kysely";

// Tenant administration (ADR-011): admins create members and change their roles, logins and
// passwords, so the runtime role now writes users, memberships and password_credentials.
// - users has no tenant_id. Reads and inserts stay open (login reads it before the tenant is
//   known; a new user has no membership yet), but an UPDATE only reaches users who are members
//   of the current tenant: memberships is itself filtered by RLS inside the policy.
// - audit_events records member changes and login outcomes: append-only, tenant-scoped RLS.

const AUDIT_EVENT_TYPES = [
  "member.created",
  "member.role_changed",
  "member.disabled",
  "member.enabled",
  "member.password_reset",
  "login.succeeded",
  "login.failed",
  "password.changed",
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table users enable row level security`.execute(db);
  await sql`alter table users force row level security`.execute(db);
  await sql`create policy users_read on users for select using (true)`.execute(db);
  await sql`create policy users_insert on users for insert with check (true)`.execute(db);
  await sql`
    create policy users_update_in_tenant on users for update
      using (exists (select 1 from memberships m where m.user_id = users.id))
      with check (exists (select 1 from memberships m where m.user_id = users.id))
  `.execute(db);

  await sql`
    create table audit_events (
      id bigint generated always as identity primary key,
      tenant_id uuid not null references tenants (id),
      type text not null check (type in (${sql.join(AUDIT_EVENT_TYPES.map((t) => sql.lit(t)))})),
      actor_user_id uuid,
      subject_user_id uuid,
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      occurred_at timestamptz not null default now(),
      foreign key (tenant_id, actor_user_id) references memberships (tenant_id, user_id),
      foreign key (tenant_id, subject_user_id) references memberships (tenant_id, user_id)
    )
  `.execute(db);
  await sql`create index audit_events_tenant_idx on audit_events (tenant_id, id)`.execute(db);
  await sql`
    create trigger audit_events_append_only
      before update or delete on audit_events
      for each row execute function forbid_mutation()
  `.execute(db);
  await sql`alter table audit_events enable row level security`.execute(db);
  await sql`alter table audit_events force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on audit_events
      using (tenant_id = current_tenant_id())
      with check (tenant_id = current_tenant_id())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table audit_events`.execute(db);
  await sql`drop policy users_update_in_tenant on users`.execute(db);
  await sql`drop policy users_insert on users`.execute(db);
  await sql`drop policy users_read on users`.execute(db);
  await sql`alter table users no force row level security`.execute(db);
  await sql`alter table users disable row level security`.execute(db);
}
