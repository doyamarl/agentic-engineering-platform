import { sql, type Kysely } from "kysely";

// OIDC subjects bound to members (ADR-011). A first OIDC login matches a verified email to a
// registered member and stores the provider's (issuer, subject) here; later logins match on that
// pair only. No row-level security, like password_credentials: read before the tenant is known.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table oidc_identities (
      issuer text not null check (length(issuer) between 1 and 2000),
      subject text not null check (length(subject) between 1 and 255),
      tenant_id uuid not null,
      user_id uuid not null,
      created_at timestamptz not null default now(),
      primary key (issuer, subject),
      unique (issuer, user_id),
      foreign key (tenant_id, user_id) references memberships (tenant_id, user_id) on delete cascade
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table oidc_identities`.execute(db);
}
