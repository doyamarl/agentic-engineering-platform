import { sql, type Kysely } from "kysely";

// Approval of connector write tools in the thread (ADR-013, #52 decision 2).
// - reply_pauses: a reply waiting for decisions, with the state it continues from. The snapshot
//   holds data read through the person's connection, so the row is visible to that person only
//   (the one who asked), and the snapshot is dropped once the reply has continued.
// - tool_approvals: one write call each, with the arguments the person sees and the call runs
//   with. Same visibility. Other members who can read the thread see the request as a thread
//   event, without the right to decide.

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
];
const AUDIT_TYPES_AFTER = [...AUDIT_TYPES_BEFORE, "connector.tool_decided"];

const typeCheck = (types: readonly string[]) =>
  sql`check (type in (${sql.join(types.map((t) => sql.lit(t)))}))`;

const OWN = sql`tenant_id = current_tenant_id() and requested_by = current_user_id()`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table reply_pauses (
      tenant_id uuid not null,
      id uuid not null,
      thread_id uuid not null,
      message_id uuid not null,
      requested_by uuid not null,
      snapshot jsonb,
      created_at timestamptz not null,
      closed_at timestamptz,
      primary key (tenant_id, id),
      foreign key (tenant_id, thread_id) references threads (tenant_id, id),
      check ((closed_at is null) = (snapshot is not null))
    )
  `.execute(db);
  await sql`create index reply_pauses_open on reply_pauses (tenant_id, message_id) where closed_at is null`.execute(
    db,
  );

  await sql`
    create table tool_approvals (
      tenant_id uuid not null,
      id uuid not null,
      pause_id uuid not null,
      requested_by uuid not null,
      call_id text not null,
      connector_id text not null,
      tool text not null,
      input jsonb not null,
      status text not null
        check (status in ('pending', 'approved', 'rejected', 'executing', 'done')),
      decided_at timestamptz,
      primary key (tenant_id, id),
      foreign key (tenant_id, pause_id) references reply_pauses (tenant_id, id)
    )
  `.execute(db);
  await sql`create index tool_approvals_pause on tool_approvals (tenant_id, pause_id)`.execute(db);

  for (const table of ["reply_pauses", "tool_approvals"]) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.table(table)} force row level security`.execute(db);
    await sql`create policy person_isolation on ${sql.table(table)} using (${OWN}) with check (${OWN})`.execute(
      db,
    );
  }

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
  await sql`drop table tool_approvals`.execute(db);
  await sql`drop table reply_pauses`.execute(db);
}
