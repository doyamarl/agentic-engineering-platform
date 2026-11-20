import { sql, type Kysely } from "kysely";

// Where a mission's work comes from (domain MissionSource), e.g. a GitHub issue. Nullable:
// missions created before this migration, or without a source, have none.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table missions add column source jsonb
      check (source is null or jsonb_typeof(source) = 'object')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table missions drop column source`.execute(db);
}
