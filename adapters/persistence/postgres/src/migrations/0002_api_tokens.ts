import { sql, type Kysely } from "kysely";

// Static API tokens for the Sprint 1 identity mode (decided 2026-11-13; OIDC later behind
// IdentityPort). Only the SHA-256 digest is stored.
// No row-level security: authentication runs before the tenant is known. The table holds digests
// and ids only; the role is read from memberships under the resolved tenant's RLS scope.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table api_tokens (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null,
      user_id uuid not null,
      name text not null check (length(name) between 1 and 100),
      token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
      created_at timestamptz not null default now(),
      expires_at timestamptz,
      revoked_at timestamptz,
      foreign key (tenant_id, user_id) references memberships (tenant_id, user_id)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table api_tokens`.execute(db);
}
