import { can, err, ok, type ConnectorManifest, type Result, type UserId } from "@aep/domain";
import type { AppError } from "../errors.ts";
import type { Principal } from "../principal.ts";
import { disconnectJob, exchangeJob } from "./connection-jobs.ts";
import type {
  Connection,
  ConnectionRepository,
  ConnectorCatalog,
  ConnectorClients,
  ConnectorOAuth,
} from "./connector-ports.ts";

// What people do with their own connections, and what admins see (ADR-013, #52). The API runs
// this; it never holds a token or the master key (#52 decision 6).

/** How long a person has to approve at the provider. */
export const AUTHORIZATION_TTL_MS = 10 * 60_000;

export type ConnectorView = {
  readonly manifest: ConnectorManifest;
  readonly connection?: Connection;
};

export function connectionService({
  catalog,
  connections,
  clients,
  oauth,
  newState,
  now,
}: {
  readonly catalog: ConnectorCatalog;
  readonly connections: ConnectionRepository;
  readonly clients: ConnectorClients;
  readonly oauth: ConnectorOAuth;
  readonly newState: () => string;
  readonly now: () => Date;
}) {
  const manifestOf = (connectorId: string) =>
    catalog.manifests.find((manifest) => manifest.id === connectorId);
  const forbidden = (action: "connector:use" | "connector:manage") =>
    err<AppError>({ kind: "Forbidden", action });
  const notFound = err<AppError>({ kind: "NotFound", resource: "connector" });

  return {
    async list(principal: Principal): Promise<Result<readonly ConnectorView[], AppError>> {
      if (!can(principal.role, "connector:use")) return forbidden("connector:use");
      const mine = await connections.list(principal);
      return ok(
        catalog.manifests.map((manifest) => {
          const connection = mine.find((c) => c.connectorId === manifest.id);
          return connection === undefined ? { manifest } : { manifest, connection };
        }),
      );
    },

    /** The URL to send the person to. Registers the platform with the provider the first time. */
    async authorize(
      principal: Principal,
      connectorId: string,
      serverId: string | undefined,
    ): Promise<Result<{ readonly url: string }, AppError>> {
      if (!can(principal.role, "connector:use")) return forbidden("connector:use");
      const manifest = manifestOf(connectorId);
      if (manifest === undefined) return notFound;
      const server =
        serverId === undefined
          ? manifest.servers[0]
          : manifest.servers.find((s) => s.id === serverId);
      if (server === undefined) {
        return err({
          kind: "Invalid",
          field: "serverId",
          reason: "not a server of this connector",
        });
      }
      const registration =
        (await clients.find(manifest.id, server.id, catalog.redirectUri)) ??
        (await clients.save(await oauth.register(manifest, server, catalog.redirectUri)));
      const state = newState();
      const { url, codeVerifier } = await oauth.authorizationUrl(manifest, registration, {
        state,
        scopes: manifest.auth.scopes,
      });
      await connections.startAuthorization(principal, {
        connectorId: manifest.id,
        serverId: server.id,
        state,
        codeVerifier,
        expiresAt: new Date(now().getTime() + AUTHORIZATION_TTL_MS),
      });
      return ok({ url });
    },

    /**
     * The provider's answer, forwarded by the web UI's callback. Only the person who started the
     * authorization can answer it: the lookup is scoped to them.
     */
    async callback(
      principal: Principal,
      answer: {
        readonly state: string;
        readonly code?: string;
        readonly iss?: string;
        readonly error?: string;
      },
    ): Promise<Result<{ readonly connectorId: string }, AppError>> {
      if (!can(principal.role, "connector:use")) return forbidden("connector:use");
      if (answer.code === undefined && answer.error === undefined) {
        return err({ kind: "Invalid", field: "code", reason: "code or error is required" });
      }
      const { state, ...rest } = answer;
      const found = await connections.answerAuthorization(
        principal,
        state,
        answer.code === undefined ? { error: answer.error ?? "access_denied" } : rest,
        now(),
        (connectorId) => exchangeJob(principal.tenantId, principal.userId, connectorId, state),
      );
      return found === undefined
        ? err({ kind: "Invalid", field: "state", reason: "unknown or expired authorization" })
        : ok(found);
    },

    async disconnect(principal: Principal, connectorId: string): Promise<Result<void, AppError>> {
      if (!can(principal.role, "connector:use")) return forbidden("connector:use");
      const at = now();
      const requested = await connections.requestDisconnect(
        principal,
        connectorId,
        at,
        disconnectJob(
          principal.tenantId,
          principal.userId,
          connectorId,
          "user",
          principal.userId,
          at,
        ),
      );
      return requested ? ok(undefined) : notFound;
    },

    async listAll(principal: Principal): Promise<Result<readonly Connection[], AppError>> {
      if (!can(principal.role, "connector:manage")) return forbidden("connector:manage");
      return ok(await connections.listAll(principal.tenantId));
    },

    async disconnectMember(
      principal: Principal,
      userId: UserId,
      connectorId: string,
    ): Promise<Result<void, AppError>> {
      if (!can(principal.role, "connector:manage")) return forbidden("connector:manage");
      const at = now();
      const requested = await connections.requestDisconnectAsAdmin(
        principal.tenantId,
        userId,
        connectorId,
        at,
        disconnectJob(principal.tenantId, userId, connectorId, "admin", principal.userId, at),
      );
      return requested ? ok(undefined) : notFound;
    },
  };
}

export type ConnectionService = ReturnType<typeof connectionService>;
