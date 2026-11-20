import { sql, type Kysely } from "kysely";

// Durable job queue and outbox (ADR-003). A job is enqueued in the same transaction as the state
// change that calls for it, and a worker claims it with a lease (FOR UPDATE SKIP LOCKED); an
// expired lease makes the job claimable again, which is how work survives a worker crash.
//
// No row-level security: workers claim jobs before they know the tenant, as with api_tokens.
// Payloads hold identifiers only; handlers read tenant data under the job's tenant scope.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table jobs (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants (id),
      kind text not null check (kind ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
      idempotency_key text not null check (length(idempotency_key) between 1 and 200),
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      status text not null default 'queued'
        check (status in ('queued', 'running', 'succeeded', 'dead')),
      attempts integer not null default 0 check (attempts >= 0),
      max_attempts integer not null check (max_attempts between 1 and 100),
      run_after timestamptz not null default now(),
      locked_by text,
      locked_until timestamptz,
      last_error text check (length(last_error) <= 2000),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      finished_at timestamptz,
      unique (tenant_id, kind, idempotency_key),
      check ((status = 'running') = (locked_by is not null and locked_until is not null)),
      check ((status in ('succeeded', 'dead')) = (finished_at is not null))
    )
  `.execute(db);
  await sql`create index jobs_claimable_idx on jobs (kind, run_after)
    where status in ('queued', 'running')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table jobs`.execute(db);
}
