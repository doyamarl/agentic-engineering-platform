import { sql, type Kysely } from "kysely";

// Acceptance packet versions (domain AcceptancePacket, PRD FR-06). Append-only like plans (0005):
// a release approval names a version. The content is stored as the exact JSON text that was
// hashed, so the checksum can be verified by the database and by any reader.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table acceptance_packets (
      tenant_id uuid not null,
      mission_id uuid not null,
      version integer not null check (version >= 1),
      content text not null check (length(content) <= 1000000),
      checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
      created_at timestamptz not null default now(),
      primary key (tenant_id, mission_id, version),
      foreign key (tenant_id, mission_id) references missions (tenant_id, id),
      check (jsonb_typeof(content::jsonb) = 'object'),
      check (checksum_sha256 = encode(sha256(convert_to(content, 'UTF8')), 'hex'))
    )
  `.execute(db);
  await sql`
    create trigger acceptance_packets_append_only
      before update or delete on acceptance_packets
      for each row execute function forbid_mutation()
  `.execute(db);
  await sql`alter table acceptance_packets enable row level security`.execute(db);
  await sql`alter table acceptance_packets force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on acceptance_packets
      using (tenant_id = current_tenant_id())
      with check (tenant_id = current_tenant_id())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table acceptance_packets`.execute(db);
}
