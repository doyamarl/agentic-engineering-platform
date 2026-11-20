import type { TenantId, UserId } from "@aep/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresOidcIdentities } from "./oidc-identities.ts";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "./test-support.ts";

let db: TestDatabase;

beforeAll(async () => {
  db = await startDatabase();
}, 180_000);

afterAll(async () => {
  await db.stop();
});

const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";
const ISSUER = "https://idp.example";
const alice = { userId: USER_A as UserId, tenantId: TENANT_A as TenantId, disabled: false };
const identities = () => new PostgresOidcIdentities(db.app);

beforeEach(async () => {
  await seedTwoTenants(db.admin);
  await db.admin
    .updateTable("users")
    .set({ email: "alice@example.com" })
    .where("id", "=", USER_A)
    .execute();
  await db.admin
    .insertInto("password_credentials")
    .values({
      user_id: USER_A,
      tenant_id: TENANT_A,
      password_hash: HASH,
      must_change_password: false,
    })
    .execute();
});

describe("PostgresOidcIdentities (runtime role)", () => {
  it("finds a registered member by email, with the tenant", async () => {
    expect(await identities().findByEmail("alice@example.com")).toEqual(alice);
    expect(await identities().findByEmail("bob@example.com")).toBeUndefined();
  });

  it("binds a subject once per member and issuer, and finds the member by it", async () => {
    expect(await identities().bind(ISSUER, "idp-alice", alice)).toBe(true);
    expect(await identities().findBySubject(ISSUER, "idp-alice")).toEqual(alice);
    expect(await identities().findBySubject("https://other.example", "idp-alice")).toBeUndefined();
    expect(await identities().bind(ISSUER, "someone-else", alice)).toBe(false);
    expect(await identities().bind("https://other.example", "idp-alice", alice)).toBe(true);
  });

  it("reports a disabled member", async () => {
    await identities().bind(ISSUER, "idp-alice", alice);
    await db.admin
      .updateTable("users")
      .set({ disabled_at: new Date() })
      .where("id", "=", USER_A)
      .execute();
    expect(await identities().findBySubject(ISSUER, "idp-alice")).toMatchObject({ disabled: true });
  });

  it("refuses to bind a subject to a tenant the member does not belong to", async () => {
    await expect(
      identities().bind(ISSUER, "idp-x", { ...alice, tenantId: TENANT_B as TenantId }),
    ).rejects.toThrow(/foreign key/);
  });

  it("does not let the runtime role change or delete bindings", async () => {
    await identities().bind(ISSUER, "idp-alice", alice);
    await expect(
      db.app.updateTable("oidc_identities").set({ subject: "x" }).execute(),
    ).rejects.toThrow(/permission denied/);
    await expect(db.app.deleteFrom("oidc_identities").execute()).rejects.toThrow(
      /permission denied/,
    );
  });
});
