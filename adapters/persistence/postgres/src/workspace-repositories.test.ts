import type { TenantId, UserId, WorkspaceId } from "@aep/domain";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "./tenant-session.ts";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
  WORKSPACE_A,
  WORKSPACE_B,
  seedTwoTenants,
  startDatabase,
  type TestDatabase,
} from "./test-support.ts";
import { PostgresWorkspaceRepositories } from "./workspace-repositories.ts";

// The GitHub repositories of a workspace (migration 0020).

let db: TestDatabase;
let repositories: PostgresWorkspaceRepositories;
const NOW = new Date("2026-11-17T00:00:00Z");
const tenantA = TENANT_A as TenantId;
const workspaceA = WORKSPACE_A as WorkspaceId;
const row = (owner: string, name: string) => ({
  owner,
  name,
  addedBy: USER_A as UserId,
  addedAt: NOW,
});
const audit = (type: "workspace.repository_added" | "workspace.repository_removed") => ({
  type,
  actorId: USER_A as UserId,
  subjectId: null,
  payload: { workspaceId: WORKSPACE_A, repository: "acme/shop" },
});
const auditTypes = async () =>
  (
    await db.admin
      .selectFrom("audit_events")
      .select("type")
      .where("tenant_id", "=", TENANT_A)
      .orderBy("id")
      .execute()
  ).map((r) => r.type);

beforeAll(async () => {
  db = await startDatabase();
  repositories = new PostgresWorkspaceRepositories(db.app);
}, 180_000);

afterAll(async () => {
  await db.stop();
});

beforeEach(async () => {
  await seedTwoTenants(db.admin);
});

describe("PostgresWorkspaceRepositories", () => {
  it("adds a repository once, ignoring case, and audits only the addition", async () => {
    expect(await repositories.list(tenantA, workspaceA)).toEqual([]);
    expect(
      await repositories.add(
        tenantA,
        workspaceA,
        row("acme", "shop"),
        audit("workspace.repository_added"),
      ),
    ).toEqual({ ok: true, value: "added" });
    expect(
      await repositories.add(
        tenantA,
        workspaceA,
        row("ACME", "Shop"),
        audit("workspace.repository_added"),
      ),
    ).toEqual({ ok: true, value: "exists" });
    expect(await repositories.list(tenantA, workspaceA)).toEqual([row("acme", "shop")]);
    expect(await auditTypes()).toEqual(["workspace.repository_added"]);
  });

  it("removes a repository whatever the case, and audits it", async () => {
    await repositories.add(
      tenantA,
      workspaceA,
      row("acme", "shop"),
      audit("workspace.repository_added"),
    );
    const remove = () =>
      repositories.remove(
        tenantA,
        workspaceA,
        { owner: "Acme", name: "SHOP" },
        audit("workspace.repository_removed"),
      );
    expect(await remove()).toBe(true);
    expect(await remove()).toBe(false);
    expect(await repositories.list(tenantA, workspaceA)).toEqual([]);
    expect(await auditTypes()).toEqual([
      "workspace.repository_added",
      "workspace.repository_removed",
    ]);
  });

  it("does not find another tenant's workspace", async () => {
    expect(await repositories.list(tenantA, WORKSPACE_B as WorkspaceId)).toBeUndefined();
    expect(
      await repositories.add(
        tenantA,
        WORKSPACE_B as WorkspaceId,
        row("acme", "shop"),
        audit("workspace.repository_added"),
      ),
    ).toEqual({ ok: false, error: { kind: "WorkspaceNotFound" } });
  });

  it("keeps another tenant's rows out of reach of the runtime role", async () => {
    await db.admin
      .insertInto("workspace_repositories")
      .values({
        tenant_id: TENANT_B,
        workspace_id: WORKSPACE_B,
        owner: "b",
        name: "secret",
        added_by: USER_B,
      })
      .execute();
    const seen = await withTenant(db.app, TENANT_A, (trx) =>
      trx.selectFrom("workspace_repositories").select("name").execute(),
    );
    expect(seen).toEqual([]);
    await expect(
      withTenant(db.app, TENANT_A, (trx) =>
        trx
          .insertInto("workspace_repositories")
          .values({
            tenant_id: TENANT_B,
            workspace_id: WORKSPACE_B,
            owner: "a",
            name: "x",
            added_by: USER_B,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(db.app, TENANT_A, (trx) =>
        sql`delete from workspace_repositories where tenant_id = ${TENANT_B}`.execute(trx),
      ),
    ).resolves.toMatchObject({ numAffectedRows: 0n });
  });

  it("refuses names that are not GitHub names", async () => {
    for (const [owner, name] of [
      ["acme", ".."],
      ["a/b", "shop"],
      ["acme", "sh op"],
    ] as const) {
      await expect(
        db.admin
          .insertInto("workspace_repositories")
          .values({ tenant_id: TENANT_A, workspace_id: WORKSPACE_A, owner, name, added_by: USER_A })
          .execute(),
      ).rejects.toThrow(/check constraint/);
    }
  });
});
