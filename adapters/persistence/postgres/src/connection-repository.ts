import type {
  AnsweredAuthorization,
  AuditEventInput,
  ClientRegistration,
  Connection,
  ConnectionRepository,
  ConnectionScope,
  ConnectorClients,
  NewJob,
  PendingAuthorization,
  SealedTokens,
} from "@aep/application";
import type { TenantId, UserId } from "@aep/domain";
import { sql, type Kysely, type Transaction } from "kysely";
import { enqueueJob } from "./job-queue.ts";
import { appendAudit } from "./member-repository.ts";
import type { Database } from "./schema.ts";
import { withTenant, withTenantUser } from "./tenant-session.ts";

// Connections and their tokens (ADR-013, migration 0016). Every method on a person's own rows runs
// under withTenantUser, so row-level security limits it to that person; the admin methods set
// app.connection_admin, which shows connections (never tokens) of every member of the tenant.

type Trx = Transaction<Database>;

const asAdmin = async (trx: Trx) => {
  await sql`select set_config('app.connection_admin', 'on', true)`.execute(trx);
};

export class PostgresConnections implements ConnectionRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  list(scope: ConnectionScope): Promise<readonly Connection[]> {
    return withTenantUser(this.#db, scope, async (trx) => {
      const rows = await trx
        .selectFrom("connections")
        .selectAll()
        .where("user_id", "=", scope.userId)
        .execute();
      const pending = await trx
        .selectFrom("connection_authorizations")
        .selectAll()
        .where("user_id", "=", scope.userId)
        .where("status", "in", ["answered", "failed"])
        .execute();
      const result = new Map<string, Connection>(
        rows.map((row) => [
          row.connector_id,
          {
            tenantId: scope.tenantId,
            userId: scope.userId,
            connectorId: row.connector_id,
            serverId: row.server_id,
            status: row.status,
            connectedAt: row.connected_at,
            updatedAt: row.updated_at,
          },
        ]),
      );
      // An attempt to connect again shows over the connection it would replace; a disconnect in
      // progress shows over both.
      for (const p of pending) {
        const base = result.get(p.connector_id);
        if (base?.status === "disconnecting") continue;
        result.set(p.connector_id, {
          tenantId: scope.tenantId,
          userId: scope.userId,
          connectorId: p.connector_id,
          serverId: p.server_id,
          status: p.status === "answered" ? "connecting" : "failed",
          updatedAt: p.updated_at,
          ...(base?.connectedAt === undefined ? {} : { connectedAt: base.connectedAt }),
          ...(p.error === null ? {} : { error: p.error }),
        });
      }
      return [...result.values()].sort((a, b) => a.connectorId.localeCompare(b.connectorId));
    });
  }

  async startAuthorization(scope: ConnectionScope, pending: PendingAuthorization): Promise<void> {
    await withTenantUser(this.#db, scope, async (trx) => {
      const values = {
        server_id: pending.serverId,
        state: pending.state,
        code_verifier: pending.codeVerifier,
        code: null,
        iss: null,
        error: null,
        status: "started" as const,
        expires_at: pending.expiresAt,
        updated_at: sql<Date>`now()`,
      };
      await trx
        .insertInto("connection_authorizations")
        .values({
          tenant_id: scope.tenantId,
          user_id: scope.userId,
          connector_id: pending.connectorId,
          ...values,
        })
        .onConflict((oc) =>
          oc.columns(["tenant_id", "user_id", "connector_id"]).doUpdateSet(values),
        )
        .execute();
    });
  }

  answerAuthorization(
    scope: ConnectionScope,
    state: string,
    answer: { readonly code?: string; readonly iss?: string; readonly error?: string },
    at: Date,
    job: (connectorId: string) => NewJob,
  ): Promise<{ readonly connectorId: string } | undefined> {
    return withTenantUser(this.#db, scope, async (trx) => {
      // Only a started, unexpired authorization of this person: answering twice does nothing.
      const row = await trx
        .updateTable("connection_authorizations")
        .set({
          code: answer.code ?? null,
          iss: answer.iss ?? null,
          error: answer.code === undefined ? (answer.error ?? "access_denied").slice(0, 200) : null,
          status: answer.code === undefined ? "failed" : "answered",
          updated_at: at,
        })
        .where("user_id", "=", scope.userId)
        .where("state", "=", state)
        .where("status", "=", "started")
        .where("expires_at", ">", at)
        .returning("connector_id")
        .executeTakeFirst();
      if (row === undefined) return undefined;
      if (answer.code !== undefined) await enqueueJob(trx, job(row.connector_id));
      return { connectorId: row.connector_id };
    });
  }

  answeredAuthorization(
    scope: ConnectionScope,
    connectorId: string,
  ): Promise<AnsweredAuthorization | undefined> {
    return withTenantUser(this.#db, scope, async (trx) => {
      const row = await trx
        .selectFrom("connection_authorizations")
        .selectAll()
        .where("user_id", "=", scope.userId)
        .where("connector_id", "=", connectorId)
        .where("status", "=", "answered")
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        connectorId: row.connector_id,
        serverId: row.server_id,
        state: row.state,
        codeVerifier: row.code_verifier,
        expiresAt: row.expires_at,
        ...(row.code === null ? {} : { code: row.code }),
        ...(row.iss === null ? {} : { iss: row.iss }),
      };
    });
  }

  async failAuthorization(
    scope: ConnectionScope,
    connectorId: string,
    error: string,
  ): Promise<void> {
    await withTenantUser(this.#db, scope, (trx) =>
      trx
        .updateTable("connection_authorizations")
        // The code is single use; drop it with the verifier's partner so neither lingers.
        .set({ status: "failed", code: null, error: error.slice(0, 200), updated_at: sql`now()` })
        .where("user_id", "=", scope.userId)
        .where("connector_id", "=", connectorId)
        .execute(),
    );
  }

  async saveTokens(
    scope: ConnectionScope,
    connection: { readonly connectorId: string; readonly serverId: string },
    tokens: SealedTokens,
    at: Date,
    audit: AuditEventInput,
  ): Promise<void> {
    await withTenantUser(this.#db, scope, async (trx) => {
      const values = {
        server_id: connection.serverId,
        status: "connected" as const,
        scope: tokens.scope ?? null,
        connected_at: at,
        updated_at: at,
      };
      await trx
        .insertInto("connections")
        .values({
          tenant_id: scope.tenantId,
          user_id: scope.userId,
          connector_id: connection.connectorId,
          ...values,
        })
        .onConflict((oc) =>
          oc.columns(["tenant_id", "user_id", "connector_id"]).doUpdateSet(values),
        )
        .execute();
      const sealed = {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken ?? null,
        expires_at: tokens.expiresAt ?? null,
      };
      await trx
        .insertInto("connection_tokens")
        .values({
          tenant_id: scope.tenantId,
          user_id: scope.userId,
          connector_id: connection.connectorId,
          ...sealed,
        })
        .onConflict((oc) =>
          oc.columns(["tenant_id", "user_id", "connector_id"]).doUpdateSet(sealed),
        )
        .execute();
      await trx
        .deleteFrom("connection_authorizations")
        .where("user_id", "=", scope.userId)
        .where("connector_id", "=", connection.connectorId)
        .execute();
      await appendAudit(trx, scope.tenantId, [audit]);
    });
  }

  tokens(
    scope: ConnectionScope,
    connectorId: string,
  ): Promise<(SealedTokens & { readonly serverId: string }) | undefined> {
    return withTenantUser(this.#db, scope, async (trx) => {
      const row = await trx
        .selectFrom("connection_tokens as t")
        .innerJoin("connections as c", (join) =>
          join
            .onRef("c.tenant_id", "=", "t.tenant_id")
            .onRef("c.user_id", "=", "t.user_id")
            .onRef("c.connector_id", "=", "t.connector_id"),
        )
        .select(["t.access_token", "t.refresh_token", "t.expires_at", "c.server_id", "c.scope"])
        .where("t.user_id", "=", scope.userId)
        .where("t.connector_id", "=", connectorId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        serverId: row.server_id,
        accessToken: row.access_token,
        ...(row.refresh_token === null ? {} : { refreshToken: row.refresh_token }),
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
        ...(row.scope === null ? {} : { scope: row.scope }),
      };
    });
  }

  replaceTokens(
    scope: ConnectionScope,
    connectorId: string,
    expected: string,
    tokens: SealedTokens,
    at: Date,
  ): Promise<boolean> {
    return withTenantUser(this.#db, scope, async (trx) => {
      const replaced = await trx
        .updateTable("connection_tokens")
        .set({
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken ?? null,
          expires_at: tokens.expiresAt ?? null,
        })
        .where("user_id", "=", scope.userId)
        .where("connector_id", "=", connectorId)
        .where("access_token", "=", expected)
        .executeTakeFirst();
      if (replaced.numUpdatedRows === 0n) return false;
      await trx
        .updateTable("connections")
        .set({ updated_at: at, ...(tokens.scope === undefined ? {} : { scope: tokens.scope }) })
        .where("user_id", "=", scope.userId)
        .where("connector_id", "=", connectorId)
        .execute();
      return true;
    });
  }

  async markExpired(scope: ConnectionScope, connectorId: string, at: Date): Promise<void> {
    await withTenantUser(this.#db, scope, (trx) =>
      trx
        .updateTable("connections")
        .set({ status: "expired", updated_at: at })
        .where("user_id", "=", scope.userId)
        .where("connector_id", "=", connectorId)
        .where("status", "=", "connected")
        .execute(),
    );
  }

  requestDisconnect(
    scope: ConnectionScope,
    connectorId: string,
    at: Date,
    job: NewJob,
  ): Promise<boolean> {
    return withTenantUser(this.#db, scope, (trx) =>
      markDisconnecting(trx, scope.userId, connectorId, at, job),
    );
  }

  async remove(scope: ConnectionScope, connectorId: string, audit: AuditEventInput): Promise<void> {
    await withTenantUser(this.#db, scope, async (trx) => {
      for (const table of [
        "connection_tokens",
        "connections",
        "connection_authorizations",
      ] as const) {
        await trx
          .deleteFrom(table)
          .where("user_id", "=", scope.userId)
          .where("connector_id", "=", connectorId)
          .execute();
      }
      await appendAudit(trx, scope.tenantId, [audit]);
    });
  }

  listAll(tenantId: TenantId): Promise<readonly Connection[]> {
    return withTenant(this.#db, tenantId, async (trx) => {
      await asAdmin(trx);
      const rows = await trx
        .selectFrom("connections")
        .selectAll()
        .orderBy("user_id")
        .orderBy("connector_id")
        .execute();
      return rows.map((row) => ({
        tenantId,
        userId: row.user_id as UserId,
        connectorId: row.connector_id,
        serverId: row.server_id,
        status: row.status,
        connectedAt: row.connected_at,
        updatedAt: row.updated_at,
      }));
    });
  }

  requestDisconnectAsAdmin(
    tenantId: TenantId,
    userId: UserId,
    connectorId: string,
    at: Date,
    job: NewJob,
  ): Promise<boolean> {
    return withTenant(this.#db, tenantId, async (trx) => {
      await asAdmin(trx);
      return markDisconnecting(trx, userId, connectorId, at, job);
    });
  }
}

/**
 * Marks the connection disconnecting and enqueues the job that revokes and deletes it. A pending
 * authorization without a connection is cleared too (by the job; admins cannot see it).
 */
async function markDisconnecting(
  trx: Trx,
  userId: UserId,
  connectorId: string,
  at: Date,
  job: NewJob,
): Promise<boolean> {
  const updated = await trx
    .updateTable("connections")
    .set({ status: "disconnecting", updated_at: at })
    .where("user_id", "=", userId)
    .where("connector_id", "=", connectorId)
    .returning("connector_id")
    .executeTakeFirst();
  const pending =
    updated === undefined
      ? await trx
          .selectFrom("connection_authorizations")
          .select("connector_id")
          .where("user_id", "=", userId)
          .where("connector_id", "=", connectorId)
          .executeTakeFirst()
      : undefined;
  if (updated === undefined && pending === undefined) return false;
  await enqueueJob(trx, job);
  return true;
}

export class PostgresConnectorClients implements ConnectorClients {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async find(
    connectorId: string,
    serverId: string,
    redirectUri: string,
  ): Promise<ClientRegistration | undefined> {
    const row = await this.#db
      .selectFrom("connector_clients")
      .selectAll()
      .where("connector_id", "=", connectorId)
      .where("server_id", "=", serverId)
      .where("redirect_uri", "=", redirectUri)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          connectorId: row.connector_id,
          serverId: row.server_id,
          redirectUri: row.redirect_uri,
          issuer: row.issuer,
          clientId: row.client_id,
          details: row.details,
        };
  }

  async save(registration: ClientRegistration): Promise<ClientRegistration> {
    await this.#db
      .insertInto("connector_clients")
      .values({
        connector_id: registration.connectorId,
        server_id: registration.serverId,
        redirect_uri: registration.redirectUri,
        issuer: registration.issuer,
        client_id: registration.clientId,
        details: JSON.stringify(registration.details),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    const kept = await this.find(
      registration.connectorId,
      registration.serverId,
      registration.redirectUri,
    );
    if (kept === undefined) throw new Error("connector client registration was not stored");
    return kept;
  }
}
