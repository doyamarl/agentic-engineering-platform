import { sql, type Kysely } from "kysely";

// Every connector tool call is audited with the person, the connector, the tool and its class
// (ADR-013, PRD FR-12).

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
];
const AUDIT_TYPES_AFTER = [...AUDIT_TYPES_BEFORE, "connector.tool_called"];

const typeCheck = (types: readonly string[]) =>
  sql`check (type in (${sql.join(types.map((t) => sql.lit(t)))}))`;

export async function up(db: Kysely<unknown>): Promise<void> {
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
}
