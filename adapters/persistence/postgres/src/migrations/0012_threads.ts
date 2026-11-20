import { sql, type Kysely } from "kysely";

// Threads for talking with a model (ADR-012, ADR-014, PRD FR-11).
// - A thread is personal by default. Row-level security filters by tenant and by the session's
//   user (app.user_id, set by withTenantUser); with no user set, no thread is visible.
// - thread_members holds the chosen members of a thread shared with `members`. It repeats the
//   owner so its policy need not read threads: the threads policy reads thread_members, and a
//   policy that read back would recurse. The owner and id of a thread never change.
// - thread_messages and thread_events are append-only and visible exactly when their thread is.
//   Events are the stream the web follows with a cursor (`seq`), like mission_events.

const OWNER_TABLES = ["threads", "thread_members"] as const;
const APPEND_ONLY_TABLES = ["thread_messages", "thread_events"] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function current_user_id() returns uuid
      language sql stable
      as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$
  `.execute(db);

  await sql`
    create function forbid_thread_reassignment() returns trigger
      language plpgsql
      as $$ begin
        if new.tenant_id <> old.tenant_id or new.id <> old.id or new.owner_id <> old.owner_id then
          raise exception 'a thread keeps its tenant, id and owner' using errcode = 'P0001';
        end if;
        return new;
      end $$
  `.execute(db);

  await sql`
    create table threads (
      tenant_id uuid not null,
      workspace_id uuid not null,
      id uuid not null,
      owner_id uuid not null,
      title text not null check (length(title) between 1 and 200),
      visibility text not null default 'personal'
        check (visibility in ('personal', 'members', 'workspace')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (tenant_id, id),
      unique (tenant_id, id, owner_id),
      foreign key (tenant_id, workspace_id) references workspaces (tenant_id, id),
      foreign key (tenant_id, owner_id) references memberships (tenant_id, user_id)
    )
  `.execute(db);
  await sql`create index threads_owner_created_idx
    on threads (tenant_id, owner_id, created_at desc)`.execute(db);
  await sql`create index threads_workspace_created_idx
    on threads (tenant_id, workspace_id, created_at desc)`.execute(db);
  await sql`
    create trigger threads_keep_owner before update on threads
      for each row execute function forbid_thread_reassignment()
  `.execute(db);

  await sql`
    create table thread_members (
      tenant_id uuid not null,
      thread_id uuid not null,
      owner_id uuid not null,
      user_id uuid not null,
      added_at timestamptz not null default now(),
      primary key (tenant_id, thread_id, user_id),
      check (user_id <> owner_id),
      foreign key (tenant_id, thread_id, owner_id)
        references threads (tenant_id, id, owner_id),
      foreign key (tenant_id, user_id) references memberships (tenant_id, user_id)
    )
  `.execute(db);
  await sql`create index thread_members_user_idx on thread_members (tenant_id, user_id)`.execute(
    db,
  );

  await sql`
    create table thread_messages (
      tenant_id uuid not null,
      thread_id uuid not null,
      id uuid not null,
      role text not null check (role in ('user', 'assistant')),
      author_id uuid,
      content text not null check (length(content) between 1 and 32000),
      created_at timestamptz not null default now(),
      primary key (tenant_id, id),
      check ((role = 'user') = (author_id is not null)),
      foreign key (tenant_id, thread_id) references threads (tenant_id, id),
      foreign key (tenant_id, author_id) references memberships (tenant_id, user_id)
    )
  `.execute(db);
  await sql`create index thread_messages_thread_idx
    on thread_messages (tenant_id, thread_id, created_at, id)`.execute(db);

  await sql`
    create table thread_events (
      tenant_id uuid not null,
      thread_id uuid not null,
      seq bigint not null check (seq >= 1),
      type text not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      actor_kind text not null check (actor_kind in ('human', 'agent', 'system')),
      actor_id text,
      occurred_at timestamptz not null default now(),
      primary key (tenant_id, thread_id, seq),
      foreign key (tenant_id, thread_id) references threads (tenant_id, id)
    )
  `.execute(db);

  for (const table of APPEND_ONLY_TABLES) {
    await sql`
      create trigger ${sql.id(`${table}_append_only`)}
        before update or delete on ${sql.table(table)}
        for each row execute function forbid_mutation()
    `.execute(db);
  }

  for (const table of [...OWNER_TABLES, ...APPEND_ONLY_TABLES]) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.table(table)} force row level security`.execute(db);
  }

  // Owner, chosen member, or anyone in the tenant for a workspace thread.
  await sql`
    create policy thread_read on threads for select using (
      tenant_id = current_tenant_id()
      and current_user_id() is not null
      and (
        owner_id = current_user_id()
        or visibility = 'workspace'
        or (visibility = 'members' and exists (
          select 1 from thread_members m
          where m.tenant_id = threads.tenant_id and m.thread_id = threads.id
            and m.user_id = current_user_id()))
      )
    )
  `.execute(db);
  await sql`
    create policy thread_insert on threads for insert
      with check (tenant_id = current_tenant_id() and owner_id = current_user_id())
  `.execute(db);
  await sql`
    create policy thread_update on threads for update
      using (tenant_id = current_tenant_id() and owner_id = current_user_id())
      with check (tenant_id = current_tenant_id() and owner_id = current_user_id())
  `.execute(db);

  // A member sees only their own row; the owner sees and changes them all.
  await sql`
    create policy thread_member_read on thread_members for select using (
      tenant_id = current_tenant_id()
      and (user_id = current_user_id() or owner_id = current_user_id())
    )
  `.execute(db);
  await sql`
    create policy thread_member_insert on thread_members for insert
      with check (tenant_id = current_tenant_id() and owner_id = current_user_id())
  `.execute(db);
  await sql`
    create policy thread_member_delete on thread_members for delete
      using (tenant_id = current_tenant_id() and owner_id = current_user_id())
  `.execute(db);

  // The subquery on threads is itself filtered by thread_read.
  for (const table of APPEND_ONLY_TABLES) {
    const visible = sql`tenant_id = current_tenant_id() and exists (
      select 1 from threads t
      where t.tenant_id = ${sql.table(table)}.tenant_id and t.id = ${sql.table(table)}.thread_id)`;
    await sql`create policy thread_child_read on ${sql.table(table)} for select
      using (${visible})`.execute(db);
    // A person's message is written as that person; replies have no author.
    const author =
      table === "thread_messages"
        ? sql`and (author_id is null or author_id = current_user_id())`
        : sql``;
    await sql`create policy thread_child_insert on ${sql.table(table)} for insert
      with check (${visible} ${author})`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // thread_read reads thread_members, so it goes before the tables.
  await sql`drop policy thread_read on threads`.execute(db);
  for (const table of ["thread_events", "thread_messages", "thread_members", "threads"]) {
    await sql`drop table ${sql.table(table)}`.execute(db);
  }
  await sql`drop function forbid_thread_reassignment()`.execute(db);
  await sql`drop function current_user_id()`.execute(db);
}
