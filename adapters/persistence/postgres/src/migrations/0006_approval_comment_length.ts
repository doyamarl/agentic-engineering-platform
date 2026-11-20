import { sql, type Kysely } from "kysely";

// A rejection's comment is shown to reviewers and quoted in the next planning prompt; bound it
// like a plan body is bound (0005).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table approvals add constraint approvals_comment_length
      check (comment is null or length(comment) between 1 and 4000)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table approvals drop constraint approvals_comment_length`.execute(db);
}
