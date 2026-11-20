import { sql, type Kysely } from "kysely";

// A write call nobody decides within three days expires (owner, 2026-11-16).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table tool_approvals
      drop constraint tool_approvals_status_check,
      add constraint tool_approvals_status_check
        check (status in ('pending', 'approved', 'rejected', 'expired', 'executing', 'done'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table tool_approvals
      drop constraint tool_approvals_status_check,
      add constraint tool_approvals_status_check
        check (status in ('pending', 'approved', 'rejected', 'executing', 'done')) not valid
  `.execute(db);
}
