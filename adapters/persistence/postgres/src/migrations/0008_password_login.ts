import { sql, type Kysely } from "kysely";

// Password login and refresh sessions (ADR-011).
// - A user belongs to exactly one tenant, so a login resolves to one tenant.
// - password_credentials and sessions carry tenant_id and have no row-level security, like
//   api_tokens (0002): they are read before the tenant is known. They hold digests, ids and
//   counters only; the role is read from memberships under the tenant's RLS scope.
// - Only digests are stored: an Argon2id PHC string for passwords, SHA-256 hex for refresh tokens.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table users
      add column email text unique
        check (email = lower(btrim(email)) and length(email) between 3 and 254 and email like '%_@_%'),
      add column disabled_at timestamptz
  `.execute(db);
  await sql`alter table memberships add constraint memberships_one_tenant_per_user unique (user_id)`.execute(
    db,
  );

  await sql`
    create table password_credentials (
      user_id uuid primary key,
      tenant_id uuid not null,
      password_hash text not null check (password_hash like '$argon2id$%'),
      must_change_password boolean not null,
      failed_attempts integer not null default 0 check (failed_attempts >= 0),
      locked_until timestamptz,
      updated_at timestamptz not null default now(),
      foreign key (tenant_id, user_id) references memberships (tenant_id, user_id) on delete cascade
    )
  `.execute(db);

  await sql`
    create table sessions (
      id uuid primary key,
      tenant_id uuid not null,
      user_id uuid not null,
      refresh_hash text not null unique check (refresh_hash ~ '^[0-9a-f]{64}$'),
      previous_refresh_hash text unique check (previous_refresh_hash ~ '^[0-9a-f]{64}$'),
      created_at timestamptz not null default now(),
      last_used_at timestamptz not null default now(),
      idle_expires_at timestamptz not null,
      absolute_expires_at timestamptz not null,
      revoked_at timestamptz,
      foreign key (tenant_id, user_id) references memberships (tenant_id, user_id) on delete cascade
    )
  `.execute(db);
  await sql`create index sessions_user_idx on sessions (user_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table sessions`.execute(db);
  await sql`drop table password_credentials`.execute(db);
  await sql`alter table memberships drop constraint memberships_one_tenant_per_user`.execute(db);
  await sql`alter table users drop column disabled_at, drop column email`.execute(db);
}
