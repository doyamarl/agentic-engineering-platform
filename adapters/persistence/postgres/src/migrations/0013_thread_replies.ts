import { sql, type Kysely } from "kysely";

// The model's reply to a message (ADR-012). The reply job runs at least once, so a reply names the
// message it answers and there is at most one per message: a repeated attempt finds it and stops.
// A reply may be longer than a person's message: up to 64,000 output tokens is ~250,000 characters.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table thread_messages add column in_reply_to uuid`.execute(db);
  await sql`
    alter table thread_messages
      drop constraint thread_messages_content_check,
      add constraint thread_messages_content_check check (
        length(content) between 1 and (case when role = 'user' then 32000 else 400000 end))
  `.execute(db);
  await sql`
    alter table thread_messages
      add constraint thread_messages_reply_role check ((role = 'assistant') = (in_reply_to is not null)),
      add constraint thread_messages_one_reply unique (tenant_id, in_reply_to),
      add constraint thread_messages_reply_fkey foreign key (tenant_id, in_reply_to)
        references thread_messages (tenant_id, id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table thread_messages drop column in_reply_to`.execute(db);
  await sql`
    alter table thread_messages
      drop constraint thread_messages_content_check,
      add constraint thread_messages_content_check check (length(content) between 1 and 32000)
  `.execute(db);
}
