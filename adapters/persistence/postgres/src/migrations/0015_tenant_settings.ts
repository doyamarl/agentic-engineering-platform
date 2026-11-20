import { sql, type Kysely } from "kysely";

// Tenant settings (#43): the model chat replies use, chosen by a tenant admin. No row, or a null
// chat_model, means the instance default (the worker's AEP_CHAT_MODEL). A change is audited.

const AUDIT_TYPES_BEFORE = [
  "member.created",
  "member.role_changed",
  "member.disabled",
  "member.enabled",
  "member.password_reset",
  "login.succeeded",
  "login.failed",
  "password.changed",
];
const AUDIT_TYPES_AFTER = [...AUDIT_TYPES_BEFORE, "settings.chat_model_changed"];

const typeCheck = (types: readonly string[]) =>
  sql`check (type in (${sql.join(types.map((t) => sql.lit(t)))}))`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table tenant_settings (
      tenant_id uuid primary key references tenants (id),
      chat_model text check (length(chat_model) between 1 and 200),
      updated_by uuid not null,
      updated_at timestamptz not null default now(),
      foreign key (tenant_id, updated_by) references memberships (tenant_id, user_id)
    )
  `.execute(db);
  await sql`alter table tenant_settings enable row level security`.execute(db);
  await sql`alter table tenant_settings force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on tenant_settings
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
  // Audit events are append-only, so recorded setting changes stay; the old check skips them.
  await sql`
    alter table audit_events
      drop constraint audit_events_type_check,
      add constraint audit_events_type_check ${typeCheck(AUDIT_TYPES_BEFORE)} not valid
  `.execute(db);
  await sql`drop table tenant_settings`.execute(db);
}
