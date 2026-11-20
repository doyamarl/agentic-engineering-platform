import { randomBytes, randomUUID } from "node:crypto";
import {
  authService,
  bearerIdentity,
  memberService,
  missionService,
  threadService,
  peopleService,
  settingsService,
  workspaceService,
  workspaceRepositoryService,
  connectionService,
  toolApprovalService,
  type ConnectorCatalog,
  type ConnectorOAuth,
  type OidcProvider,
} from "@aep/application";
import type { MessageId, MissionId, ThreadId, UserId } from "@aep/domain";
import { Argon2PasswordHasher, JwtAccessTokens } from "@aep/identity-local";
import {
  PostgresAuditLog,
  PostgresIdentity,
  PostgresMemberRepository,
  PostgresMissionRepository,
  PostgresOidcIdentities,
  PostgresPasswordAccounts,
  PostgresSessions,
  PostgresThreadRepository,
  PostgresPeopleDirectory,
  PostgresTenantSettings,
  PostgresWorkspaceDirectory,
  PostgresWorkspaceRepositories,
  PostgresConnections,
  PostgresToolApprovals,
  PostgresConnectorClients,
  type Database,
} from "@aep/postgres";
import type { Kysely } from "kysely";
import type { AppDependencies } from "./app.ts";

export type AuthOptions = {
  /** Signs access tokens; at least 32 bytes. Without it only API tokens authenticate. */
  readonly accessTokenSecret?: Uint8Array;
  /** Password login (default true when a secret is given). */
  readonly password?: boolean;
  /** OIDC login through this provider, which redirects back to `redirectUri`. */
  readonly oidc?: { readonly provider: OidcProvider; readonly redirectUri: URL };
};

/** Connectors this instance offers (ADR-013); absent: none. */
export type ConnectorOptions = {
  readonly catalog: ConnectorCatalog;
  readonly oauth: ConnectorOAuth;
};

/** Wires the API to Postgres. `db` must connect as the runtime role, not the table owner. */
export function postgresDependencies(
  db: Kysely<Database>,
  options: AuthOptions = {},
  connectors?: ConnectorOptions,
): AppDependencies {
  const apiTokens = new PostgresIdentity(db);
  const audit = new PostgresAuditLog(db);
  const hasher = new Argon2PasswordHasher();
  const missions = missionService({
    missions: new PostgresMissionRepository(db),
    newMissionId: () => randomUUID() as MissionId,
    now: () => new Date(),
  });
  const members = memberService({
    members: new PostgresMemberRepository(db),
    audit,
    hasher,
    newUserId: () => randomUUID() as UserId,
    // 18 random bytes are 24 base64url characters, above the 12-character minimum.
    newPassword: () => randomBytes(18).toString("base64url"),
  });
  const threads = threadService({
    threads: new PostgresThreadRepository(db),
    newThreadId: () => randomUUID() as ThreadId,
    newMessageId: () => randomUUID() as MessageId,
    now: () => new Date(),
  });
  const people = peopleService({ people: new PostgresPeopleDirectory(db) });
  const settings = settingsService({
    settings: new PostgresTenantSettings(db),
    now: () => new Date(),
  });
  const workspaces = workspaceService({ workspaces: new PostgresWorkspaceDirectory(db) });
  const workspaceRepositories = workspaceRepositoryService({
    repositories: new PostgresWorkspaceRepositories(db),
    now: () => new Date(),
  });
  const connections =
    connectors === undefined
      ? {}
      : {
          connections: connectionService({
            catalog: connectors.catalog,
            oauth: connectors.oauth,
            connections: new PostgresConnections(db),
            clients: new PostgresConnectorClients(db),
            newState: () => randomBytes(32).toString("base64url"),
            now: () => new Date(),
          }),
          toolApprovals: toolApprovalService({
            approvals: new PostgresToolApprovals(db),
            now: () => new Date(),
          }),
        };
  if (options.accessTokenSecret === undefined) {
    return {
      identity: apiTokens,
      missions,
      members,
      workspaces,
      workspaceRepositories,
      threads,
      people,
      settings,
      ...connections,
    };
  }

  const tokens = new JwtAccessTokens(options.accessTokenSecret);
  return {
    identity: bearerIdentity({ apiTokens, tokens, members: apiTokens }),
    missions,
    members,
    threads,
    people,
    settings,
    workspaces,
    workspaceRepositories,
    ...connections,
    authMethods: {
      password: options.password ?? true,
      ...(options.oidc === undefined ? {} : { oidc: { name: options.oidc.provider.name } }),
    },
    ...(options.oidc === undefined ? {} : { oidcRedirectUri: options.oidc.redirectUri }),
    auth: authService({
      accounts: new PostgresPasswordAccounts(db),
      sessions: new PostgresSessions(db),
      hasher,
      tokens,
      members: apiTokens,
      audit,
      now: () => new Date(),
      newSessionId: randomUUID,
      newSecret: () => randomBytes(32).toString("base64url"),
      ...(options.oidc === undefined
        ? {}
        : {
            oidc: {
              provider: options.oidc.provider,
              identities: new PostgresOidcIdentities(db),
            },
          }),
    }),
  };
}
