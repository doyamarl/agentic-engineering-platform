import type { TenantId, UserId } from "@aep/domain";
import type { NewJob } from "../jobs/job-queue.ts";
import type { AuditEventInput } from "../members/member-ports.ts";
import type {
  AnsweredAuthorization,
  ClientRegistration,
  Connection,
  ConnectionRepository,
  ConnectionScope,
  ConnectorClients,
  PendingAuthorization,
  SealedTokens,
} from "./connector-ports.ts";

// In-memory ports for tests. Same rules as the Postgres adapter, without row-level security.

const key = (scope: ConnectionScope, connectorId: string) =>
  `${scope.tenantId}/${scope.userId}/${connectorId}`;

type Row = {
  scope: ConnectionScope;
  connectorId: string;
  serverId: string;
  status: "connected" | "expired" | "disconnecting";
  connectedAt: Date;
  updatedAt: Date;
  tokens: SealedTokens;
};

type Pending = AnsweredAuthorization & {
  scope: ConnectionScope;
  status: "started" | "answered" | "failed";
  updatedAt: Date;
};

export class InMemoryConnections implements ConnectionRepository {
  readonly rows = new Map<string, Row>();
  readonly pending = new Map<string, Pending>();
  readonly jobs: NewJob[] = [];
  readonly audit: AuditEventInput[] = [];
  readonly #now: () => Date;

  constructor(now: () => Date) {
    this.#now = now;
  }

  list(scope: ConnectionScope): Promise<readonly Connection[]> {
    const own = (s: ConnectionScope) => s.tenantId === scope.tenantId && s.userId === scope.userId;
    const result = new Map<string, Connection>();
    for (const row of this.rows.values()) {
      if (own(row.scope)) result.set(row.connectorId, toConnection(row));
    }
    for (const p of this.pending.values()) {
      if (!own(p.scope) || p.status === "started") continue;
      const base = result.get(p.connectorId);
      result.set(p.connectorId, {
        tenantId: scope.tenantId,
        userId: scope.userId,
        connectorId: p.connectorId,
        serverId: p.serverId,
        status: p.status === "answered" ? "connecting" : "failed",
        updatedAt: p.updatedAt,
        ...(base?.connectedAt === undefined ? {} : { connectedAt: base.connectedAt }),
        ...(p.error === undefined ? {} : { error: p.error }),
      });
    }
    return Promise.resolve([...result.values()]);
  }

  startAuthorization(scope: ConnectionScope, pending: PendingAuthorization): Promise<void> {
    this.pending.set(key(scope, pending.connectorId), {
      ...pending,
      scope,
      status: "started",
      updatedAt: this.#now(),
    });
    return Promise.resolve();
  }

  answerAuthorization(
    scope: ConnectionScope,
    state: string,
    answer: { readonly code?: string; readonly iss?: string; readonly error?: string },
    at: Date,
    job: (connectorId: string) => NewJob,
  ): Promise<{ readonly connectorId: string } | undefined> {
    const found = [...this.pending.values()].find(
      (p) =>
        p.scope.tenantId === scope.tenantId &&
        p.scope.userId === scope.userId &&
        p.state === state &&
        p.status === "started" &&
        p.expiresAt > at,
    );
    if (found === undefined) return Promise.resolve(undefined);
    this.pending.set(key(scope, found.connectorId), {
      ...found,
      ...answer,
      status: answer.code === undefined ? "failed" : "answered",
      updatedAt: at,
    });
    if (answer.code !== undefined) this.jobs.push(job(found.connectorId));
    return Promise.resolve({ connectorId: found.connectorId });
  }

  answeredAuthorization(
    scope: ConnectionScope,
    connectorId: string,
  ): Promise<AnsweredAuthorization | undefined> {
    const p = this.pending.get(key(scope, connectorId));
    return Promise.resolve(p?.status === "answered" ? p : undefined);
  }

  failAuthorization(scope: ConnectionScope, connectorId: string, error: string): Promise<void> {
    const p = this.pending.get(key(scope, connectorId));
    if (p !== undefined) {
      const { code: _code, ...rest } = p;
      this.pending.set(key(scope, connectorId), {
        ...rest,
        status: "failed",
        error,
        updatedAt: this.#now(),
      });
    }
    return Promise.resolve();
  }

  saveTokens(
    scope: ConnectionScope,
    connection: { readonly connectorId: string; readonly serverId: string },
    tokens: SealedTokens,
    at: Date,
    audit: AuditEventInput,
  ): Promise<void> {
    this.rows.set(key(scope, connection.connectorId), {
      scope,
      ...connection,
      status: "connected",
      connectedAt: at,
      updatedAt: at,
      tokens,
    });
    this.pending.delete(key(scope, connection.connectorId));
    this.audit.push(audit);
    return Promise.resolve();
  }

  tokens(
    scope: ConnectionScope,
    connectorId: string,
  ): Promise<(SealedTokens & { readonly serverId: string }) | undefined> {
    const row = this.rows.get(key(scope, connectorId));
    return Promise.resolve(
      row === undefined ? undefined : { ...row.tokens, serverId: row.serverId },
    );
  }

  replaceTokens(
    scope: ConnectionScope,
    connectorId: string,
    expected: string,
    tokens: SealedTokens,
    at: Date,
  ): Promise<boolean> {
    const row = this.rows.get(key(scope, connectorId));
    if (row?.tokens.accessToken !== expected) return Promise.resolve(false);
    row.tokens = tokens;
    row.updatedAt = at;
    return Promise.resolve(true);
  }

  markExpired(scope: ConnectionScope, connectorId: string, at: Date): Promise<void> {
    const row = this.rows.get(key(scope, connectorId));
    if (row?.status === "connected") {
      row.status = "expired";
      row.updatedAt = at;
    }
    return Promise.resolve();
  }

  requestDisconnect(
    scope: ConnectionScope,
    connectorId: string,
    at: Date,
    job: NewJob,
  ): Promise<boolean> {
    const row = this.rows.get(key(scope, connectorId));
    const pending = this.pending.get(key(scope, connectorId));
    if (row === undefined && pending === undefined) return Promise.resolve(false);
    if (row !== undefined) {
      row.status = "disconnecting";
      row.updatedAt = at;
    }
    this.jobs.push(job);
    return Promise.resolve(true);
  }

  remove(scope: ConnectionScope, connectorId: string, audit: AuditEventInput): Promise<void> {
    this.rows.delete(key(scope, connectorId));
    this.pending.delete(key(scope, connectorId));
    this.audit.push(audit);
    return Promise.resolve();
  }

  listAll(tenantId: TenantId): Promise<readonly Connection[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.scope.tenantId === tenantId).map(toConnection),
    );
  }

  requestDisconnectAsAdmin(
    tenantId: TenantId,
    userId: UserId,
    connectorId: string,
    at: Date,
    job: NewJob,
  ): Promise<boolean> {
    return this.requestDisconnect({ tenantId, userId }, connectorId, at, job);
  }
}

const toConnection = (row: Row): Connection => ({
  tenantId: row.scope.tenantId,
  userId: row.scope.userId,
  connectorId: row.connectorId,
  serverId: row.serverId,
  status: row.status,
  connectedAt: row.connectedAt,
  updatedAt: row.updatedAt,
});

export class InMemoryConnectorClients implements ConnectorClients {
  readonly registrations: ClientRegistration[] = [];

  find(connectorId: string, serverId: string, redirectUri: string) {
    return Promise.resolve(
      this.registrations.find(
        (r) =>
          r.connectorId === connectorId && r.serverId === serverId && r.redirectUri === redirectUri,
      ),
    );
  }

  async save(registration: ClientRegistration) {
    const existing = await this.find(
      registration.connectorId,
      registration.serverId,
      registration.redirectUri,
    );
    if (existing !== undefined) return existing;
    this.registrations.push(registration);
    return registration;
  }
}
