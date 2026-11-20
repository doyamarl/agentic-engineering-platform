import { sql, type Kysely } from "kysely";

// Plan versions (domain Plan, PRD FR-01/FR-07). Append-only like approvals: a version, once
// written, is what an approval of that version approved. Written by recordTransition in the same
// transaction as SubmitPlan. Tenant-scoped with row-level security, as in 0001.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table plans (
      tenant_id uuid not null,
      mission_id uuid not null,
      version integer not null check (version >= 1),
      body text not null check (length(body) between 1 and 32000),
      checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
      author_kind text not null check (author_kind in ('human', 'agent', 'system')),
      author_id text,
      created_at timestamptz not null default now(),
      primary key (tenant_id, mission_id, version),
      foreign key (tenant_id, mission_id) references missions (tenant_id, id),
      check (checksum_sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex'))
    )
  `.execute(db);
  await sql`
    create trigger plans_append_only
      before update or delete on plans
      for each row execute function forbid_mutation()
  `.execute(db);
  await sql`alter table plans enable row level security`.execute(db);
  await sql`alter table plans force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on plans
      using (tenant_id = current_tenant_id())
      with check (tenant_id = current_tenant_id())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table plans`.execute(db);
}
