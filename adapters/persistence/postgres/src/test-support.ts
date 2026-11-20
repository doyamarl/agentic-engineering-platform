import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { migrateToLatest } from "./migrate.ts";
import { grantRuntimeAccess } from "./runtime-access.ts";
import type { Database } from "./schema.ts";

// Test-only helpers. Not exported from index.ts.

export const TENANT_A = "0a000000-0000-4000-8000-000000000001";
export const TENANT_B = "0b000000-0000-4000-8000-000000000001";
export const WORKSPACE_A = "0a000000-0000-4000-8000-0000000000a1";
export const WORKSPACE_B = "0b000000-0000-4000-8000-0000000000b1";
export const USER_A = "0a000000-0000-4000-8000-0000000000aa";
export const USER_B = "0b000000-0000-4000-8000-0000000000bb";

export const connect = (connectionString: string, max = 10): Kysely<Database> =>
  new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max }) }),
  });

export type TestDatabase = {
  readonly container: StartedPostgreSqlContainer;
  /** Superuser: bypasses RLS. Use for fixtures only. */
  readonly admin: Kysely<Database>;
  /** Table owner (aep_owner): ran the migrations; RLS is forced on it. */
  readonly owner: Kysely<Database>;
  /** Runtime role (aep_app): least privilege, single connection so connection reuse is exercised. */
  readonly app: Kysely<Database>;
  /** Connection string of the runtime role, for extra connections or child processes. */
  readonly appUri: string;
  stop(): Promise<void>;
};

const withCredentials = (uri: string, user: string, password: string): string => {
  const url = new URL(uri);
  url.username = user;
  url.password = password;
  return url.toString();
};

/** Same role layout as infra/compose: superuser, schema owner that migrates, runtime role. */
export async function startDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("postgres:18-alpine").start();
  const uri = container.getConnectionUri();
  const admin = connect(uri);

  await sql`create role aep_owner login password 'owner' nosuperuser nobypassrls`.execute(admin);
  await sql`create role aep_app login password 'app' nosuperuser nobypassrls`.execute(admin);
  await sql`grant create on schema public to aep_owner`.execute(admin);

  const owner = connect(withCredentials(uri, "aep_owner", "owner"));
  await migrateToLatest(owner);
  await grantRuntimeAccess(owner, "aep_app");
  const appUri = withCredentials(uri, "aep_app", "app");
  const app = connect(appUri, 1);

  return {
    container,
    admin,
    owner,
    app,
    appUri,
    async stop() {
      await app.destroy();
      await owner.destroy();
      await admin.destroy();
      await container.stop();
    },
  };
}

/** Resets to two tenants, each with one workspace and one member. */
export async function seedTwoTenants(admin: Kysely<Database>): Promise<void> {
  await sql`truncate tenants, users cascade`.execute(admin);
  await admin
    .insertInto("tenants")
    .values([
      { id: TENANT_A, name: "Tenant A" },
      { id: TENANT_B, name: "Tenant B" },
    ])
    .execute();
  await admin
    .insertInto("users")
    .values([
      { id: USER_A, display_name: "Alice" },
      { id: USER_B, display_name: "Bob" },
    ])
    .execute();
  await admin
    .insertInto("workspaces")
    .values([
      { tenant_id: TENANT_A, id: WORKSPACE_A, name: "Growth" },
      { tenant_id: TENANT_B, id: WORKSPACE_B, name: "Growth" },
    ])
    .execute();
  await admin
    .insertInto("memberships")
    .values([
      { tenant_id: TENANT_A, user_id: USER_A, role: "planner" },
      { tenant_id: TENANT_B, user_id: USER_B, role: "planner" },
    ])
    .execute();
}
