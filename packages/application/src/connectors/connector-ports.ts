import type { ConnectorManifest, ConnectorServer, TenantId, UserId } from "@aep/domain";
import type { NewJob } from "../jobs/job-queue.ts";
import type { ToolInputSchema } from "../models/model-port.ts";
import type { AuditEventInput } from "../members/member-ports.ts";

// Personal connections to outside tools through MCP (ADR-013, #52). A person connects with OAuth;
// the tokens are sealed by the worker and never leave it. The API registers the platform as an
// OAuth client and builds the authorization URL (neither involves a secret), keeps the code the
// provider sends back in a short-lived row, and enqueues the exchange (#52 decision 6).

/** The person whose connection it is. Repositories scope row-level security to this user. */
export type ConnectionScope = { readonly tenantId: TenantId; readonly userId: UserId };

/**
 * `connecting`: the provider sent a code and the worker has not exchanged it yet.
 * `failed`: the last attempt to connect failed (`error` says why); any tokens from before remain.
 * `connected`: tokens are stored. `expired`: they can no longer be refreshed; connect again.
 * `disconnecting`: the worker is revoking and deleting the tokens.
 */
export type ConnectionStatus = "connecting" | "failed" | "connected" | "expired" | "disconnecting";

export type Connection = {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly connectorId: string;
  readonly serverId: string;
  readonly status: ConnectionStatus;
  readonly connectedAt?: Date;
  readonly updatedAt: Date;
  /** Why the last attempt failed; a provider's error code or a short reason, never a token. */
  readonly error?: string;
};

/** The platform as an OAuth client of one MCP server (one per connector, server and redirect URI). */
export type ClientRegistration = {
  readonly connectorId: string;
  readonly serverId: string;
  readonly redirectUri: string;
  readonly issuer: string;
  readonly clientId: string;
  /**
   * What the adapter needs to use the registration again (authorization server metadata, the
   * resource, the client information). Public data only: dynamic clients here have no secret.
   */
  readonly details: Readonly<Record<string, unknown>>;
};

export type TokenSet = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: Date;
  readonly scope?: string;
};

/** OAuth with an MCP server's authorization server. Every request is checked against the manifest's egress hosts. */
export interface ConnectorOAuth {
  /** Discovers the authorization server and registers the platform with it (RFC 7591). */
  register(
    manifest: ConnectorManifest,
    server: ConnectorServer,
    redirectUri: string,
  ): Promise<ClientRegistration>;
  authorizationUrl(
    manifest: ConnectorManifest,
    registration: ClientRegistration,
    request: { readonly state: string; readonly scopes: readonly string[] },
  ): Promise<{ readonly url: string; readonly codeVerifier: string }>;
  exchange(
    manifest: ConnectorManifest,
    registration: ClientRegistration,
    grant: { readonly code: string; readonly codeVerifier: string; readonly iss?: string },
  ): Promise<TokenSet>;
  refresh(
    manifest: ConnectorManifest,
    registration: ClientRegistration,
    refreshToken: string,
  ): Promise<TokenSet>;
  /** RFC 7009. Resolves when the server has no revocation endpoint: there is nothing to ask. */
  revoke(
    manifest: ConnectorManifest,
    registration: ClientRegistration,
    token: { readonly value: string; readonly hint: "access_token" | "refresh_token" },
  ): Promise<void>;
}

/** Shared by every tenant of the instance: a registration holds no tenant data. */
export interface ConnectorClients {
  find(
    connectorId: string,
    serverId: string,
    redirectUri: string,
  ): Promise<ClientRegistration | undefined>;
  /** Keeps the first registration when two requests race, and returns the one kept. */
  save(registration: ClientRegistration): Promise<ClientRegistration>;
}

export type PendingAuthorization = {
  readonly connectorId: string;
  readonly serverId: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly expiresAt: Date;
};

/** A pending authorization once the provider has answered. */
export type AnsweredAuthorization = PendingAuthorization & {
  readonly code?: string;
  readonly iss?: string;
  readonly error?: string;
};

/** Sealed with SecretSealer; the repository stores them as they are. */
export type SealedTokens = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: Date;
  readonly scope?: string;
};

export interface ConnectionRepository {
  /** The person's own connections, including attempts in progress or failed. */
  list(scope: ConnectionScope): Promise<readonly Connection[]>;
  /** Replaces any earlier pending authorization of the person for this connector. */
  startAuthorization(scope: ConnectionScope, pending: PendingAuthorization): Promise<void>;
  /**
   * Records the provider's answer to the pending authorization with this state, and in the same
   * transaction enqueues `job` when there is a code. Undefined when no unexpired authorization
   * of this person has the state.
   */
  answerAuthorization(
    scope: ConnectionScope,
    state: string,
    answer: { readonly code?: string; readonly iss?: string; readonly error?: string },
    at: Date,
    job: (connectorId: string) => NewJob,
  ): Promise<{ readonly connectorId: string } | undefined>;
  answeredAuthorization(
    scope: ConnectionScope,
    connectorId: string,
  ): Promise<AnsweredAuthorization | undefined>;
  /** Marks the pending authorization failed, keeping any tokens from before. */
  failAuthorization(scope: ConnectionScope, connectorId: string, error: string): Promise<void>;
  /** Stores the tokens, removes the pending authorization and writes `audit`, in one transaction. */
  saveTokens(
    scope: ConnectionScope,
    connection: { readonly connectorId: string; readonly serverId: string },
    tokens: SealedTokens,
    at: Date,
    audit: AuditEventInput,
  ): Promise<void>;
  tokens(
    scope: ConnectionScope,
    connectorId: string,
  ): Promise<(SealedTokens & { readonly serverId: string }) | undefined>;
  /**
   * Replaces the tokens after a refresh, only while the stored access token is still `expected`
   * (the sealed value read before refreshing). False when another refresh got there first; the
   * caller then reads the tokens again.
   */
  replaceTokens(
    scope: ConnectionScope,
    connectorId: string,
    expected: string,
    tokens: SealedTokens,
    at: Date,
  ): Promise<boolean>;
  /** The tokens can no longer be refreshed: the person must connect again. */
  markExpired(scope: ConnectionScope, connectorId: string, at: Date): Promise<void>;
  /**
   * Marks the connection disconnecting and enqueues `job`, in one transaction. False when there is
   * nothing to disconnect.
   */
  requestDisconnect(
    scope: ConnectionScope,
    connectorId: string,
    at: Date,
    job: NewJob,
  ): Promise<boolean>;
  /** Deletes the tokens, the connection and any pending authorization, and writes `audit`. */
  remove(scope: ConnectionScope, connectorId: string, audit: AuditEventInput): Promise<void>;
  /** Every member's connections, for admins. Statuses only; never tokens. */
  listAll(tenantId: TenantId): Promise<readonly Connection[]>;
  /** Like requestDisconnect, for an admin acting on someone else's connection. */
  requestDisconnectAsAdmin(
    tenantId: TenantId,
    userId: UserId,
    connectorId: string,
    at: Date,
    job: NewJob,
  ): Promise<boolean>;
}

/** The connectors this instance offers, from `connectors/<id>/manifest.json`. */
export type ConnectorCatalog = {
  readonly manifests: readonly ConnectorManifest[];
  /** Where the provider sends people back: the web UI's /connections/oauth/callback. */
  readonly redirectUri: string;
};

/** The provider refused the refresh token (OAuth `invalid_grant`): the person must connect again. */
export class RefreshRefusedError extends Error {
  constructor(connectorId: string) {
    super(`connector ${connectorId}: the provider refused the refresh token`);
    this.name = "RefreshRefusedError";
  }
}

/** The MCP server answered 401 to the access token. */
export class McpUnauthorizedError extends Error {
  constructor(connectorId: string) {
    super(`connector ${connectorId}: the MCP server refused the access token`);
    this.name = "McpUnauthorizedError";
  }
}

/** A tool as the MCP server describes it. The description and schema come from outside. */
export type McpToolInfo = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
};

export type McpToolResult = {
  /** The result's text content; other content (images, resources) is named, not included. */
  readonly text: string;
  /** The server reported the call as failed (MCP `isError`). */
  readonly isError: boolean;
};

/**
 * Calls an MCP server as one person, with their access token. Every request is checked against
 * the manifest's egress hosts. Throws McpUnauthorizedError on 401 so the caller can refresh.
 */
export interface McpTools {
  list(
    manifest: ConnectorManifest,
    server: ConnectorServer,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<readonly McpToolInfo[]>;
  call(
    manifest: ConnectorManifest,
    server: ConnectorServer,
    accessToken: string,
    call: { readonly name: string; readonly input: unknown },
    signal: AbortSignal,
  ): Promise<McpToolResult>;
}
