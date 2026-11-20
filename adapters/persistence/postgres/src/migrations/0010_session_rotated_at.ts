import { sql, type Kysely } from "kysely";

// When a session's refresh token was last replaced. The token replaced last still answers for a
// short grace period (ADR-011), so two requests from one browser that refresh at the same time
// do not look like a stolen token.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sessions add column rotated_at timestamptz`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sessions drop column rotated_at`.execute(db);
}
