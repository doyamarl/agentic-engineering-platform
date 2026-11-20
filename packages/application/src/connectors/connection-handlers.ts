import { parseId } from "@aep/domain";
import type { DeadJobHandler, JobHandler } from "../jobs/run-worker.ts";
import type { Job } from "../jobs/job-queue.ts";
import type { SealedSecret, SecretOpener, SecretSealer } from "../secrets/secret-box.ts";
import {
  DISCONNECT_JOB,
  EXCHANGE_JOB,
  tokenContext,
  type DisconnectReason,
} from "./connection-jobs.ts";
import type {
  ConnectionRepository,
  ConnectionScope,
  ConnectorCatalog,
  ConnectorClients,
  ConnectorOAuth,
} from "./connector-ports.ts";

// The worker's half of connecting (ADR-013, #52 decision 6): it exchanges the code for tokens and
// seals them, and on disconnect asks the provider to revoke them before deleting them. Only the
// worker holds the master key, so only it can open a token.

const scopeOf = (job: Job): ConnectionScope & { readonly connectorId: string } => {
  const userId = parseId("UserId", String(job.payload["userId"]));
  const connectorId = job.payload["connectorId"];
  if (!userId.ok || typeof connectorId !== "string") {
    throw new Error(`${job.kind} job ${job.id} has an invalid payload`);
  }
  return { tenantId: job.tenantId, userId: userId.value, connectorId };
};

/** Short and free of secrets: a provider's error code, or the error's class. */
const reasonOf = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  const name = error instanceof Error ? error.name : "Error";
  return (code ?? name).slice(0, 100);
};

export function connectionHandlers({
  catalog,
  connections,
  clients,
  oauth,
  box,
  now,
}: {
  readonly catalog: ConnectorCatalog;
  readonly connections: ConnectionRepository;
  readonly clients: ConnectorClients;
  readonly oauth: ConnectorOAuth;
  readonly box: SecretSealer & SecretOpener;
  readonly now: () => Date;
}): {
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly onDead: Readonly<Record<string, DeadJobHandler>>;
} {
  const manifestOf = (connectorId: string) => {
    const manifest = catalog.manifests.find((m) => m.id === connectorId);
    if (manifest === undefined) throw new Error(`connector ${connectorId} is not configured`);
    return manifest;
  };
  const registrationOf = async (connectorId: string, serverId: string) => {
    const registration = await clients.find(connectorId, serverId, catalog.redirectUri);
    if (registration === undefined) {
      throw new Error(`connector ${connectorId} has no client registration for ${serverId}`);
    }
    return registration;
  };

  const exchange: JobHandler = async (job) => {
    const { connectorId, ...scope } = scopeOf(job);
    const pending = await connections.answeredAuthorization(scope, connectorId);
    // Already exchanged by an earlier attempt, or replaced by a newer authorization.
    if (pending?.code === undefined) return;
    const manifest = manifestOf(connectorId);
    const registration = await registrationOf(connectorId, pending.serverId);
    let tokens;
    try {
      tokens = await oauth.exchange(manifest, registration, {
        code: pending.code,
        codeVerifier: pending.codeVerifier,
        ...(pending.iss === undefined ? {} : { iss: pending.iss }),
      });
    } catch (error) {
      // A code works once; retrying a refused exchange cannot succeed, so fail it now.
      await connections.failAuthorization(scope, connectorId, reasonOf(error));
      return;
    }
    const seal = (value: string, kind: "access" | "refresh") =>
      box.seal(value, tokenContext(scope.tenantId, scope.userId, connectorId, kind));
    await connections.saveTokens(
      scope,
      { connectorId, serverId: pending.serverId },
      {
        accessToken: seal(tokens.accessToken, "access"),
        ...(tokens.refreshToken === undefined
          ? {}
          : { refreshToken: seal(tokens.refreshToken, "refresh") }),
        ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
        ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
      },
      now(),
      {
        type: "connection.connected",
        actorId: scope.userId,
        subjectId: scope.userId,
        payload: { connectorId, serverId: pending.serverId },
      },
    );
  };

  const disconnect: JobHandler = async (job) => {
    const { connectorId, ...scope } = scopeOf(job);
    const reason = String(job.payload["reason"] ?? "user") as DisconnectReason;
    const actor = parseId("UserId", String(job.payload["actorId"]));
    const stored = await connections.tokens(scope, connectorId);
    const manifest = catalog.manifests.find((m) => m.id === connectorId);
    if (stored !== undefined && manifest !== undefined) {
      const registration = await clients.find(connectorId, stored.serverId, catalog.redirectUri);
      if (registration !== undefined) {
        // Revoking the refresh token ends the grant at most providers; the access token is
        // revoked too for those that keep them apart. A refusal is retried by the queue.
        const open = (value: string, kind: "access" | "refresh") =>
          box.open(
            value as SealedSecret,
            tokenContext(scope.tenantId, scope.userId, connectorId, kind),
          );
        if (stored.refreshToken !== undefined) {
          await oauth.revoke(manifest, registration, {
            value: open(stored.refreshToken, "refresh"),
            hint: "refresh_token",
          });
        }
        await oauth.revoke(manifest, registration, {
          value: open(stored.accessToken, "access"),
          hint: "access_token",
        });
      }
    }
    await connections.remove(scope, connectorId, {
      type: "connection.disconnected",
      actorId: actor.ok ? actor.value : null,
      subjectId: scope.userId,
      payload: { connectorId, reason, revoked: stored !== undefined && manifest !== undefined },
    });
  };

  // A provider that keeps refusing revocation must not keep the tokens alive here: delete them
  // anyway, and record that revocation was not confirmed.
  const disconnectDead: DeadJobHandler = async (job, error) => {
    const { connectorId, ...scope } = scopeOf(job);
    const actor = parseId("UserId", String(job.payload["actorId"]));
    await connections.remove(scope, connectorId, {
      type: "connection.disconnected",
      actorId: actor.ok ? actor.value : null,
      subjectId: scope.userId,
      payload: {
        connectorId,
        reason: String(job.payload["reason"] ?? "user"),
        revoked: false,
        error: error.slice(0, 200),
      },
    });
  };

  const exchangeDead: DeadJobHandler = async (job, error) => {
    const { connectorId, ...scope } = scopeOf(job);
    await connections.failAuthorization(scope, connectorId, error.slice(0, 100));
  };

  return {
    handlers: { [EXCHANGE_JOB]: exchange, [DISCONNECT_JOB]: disconnect },
    onDead: { [EXCHANGE_JOB]: exchangeDead, [DISCONNECT_JOB]: disconnectDead },
  };
}
