import { sql, type Kysely } from "kysely";

// What a person asked for and what answered (#43): a person's message records the effort chosen
// for its reply, and a reply records the model that wrote it, which differs from the configured
// one after a server-side fallback.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table thread_messages
      add column effort text check (effort in ('low', 'medium', 'high')),
      add column model text check (length(model) between 1 and 200),
      add constraint thread_messages_effort_role check (effort is null or role = 'user'),
      add constraint thread_messages_model_role check (model is null or role = 'assistant')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table thread_messages drop column effort, drop column model`.execute(db);
}
