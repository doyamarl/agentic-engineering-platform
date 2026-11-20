import {
  RefreshRefusedError,
  type ClientRegistration,
  type ConnectorOAuth,
  type TokenSet,
} from "@aep/application";
import { checkEgress, type ConnectorManifest, type EgressOptions } from "@aep/domain";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  OAuthError,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/client";

// OAuth with an MCP server's authorization server (ADR-013, #52), on the MCP TypeScript SDK v2.
// Discovery follows RFC 9728 then RFC 8414; registration is dynamic (RFC 7591, #52 decision 1';
// Client ID Metadata Documents follow in #56);
// the flow is the authorization code grant with PKCE S256, with a resource indicator when the
// server publishes one. Every request goes through guardedFetch: a host off the manifest's
// egressHosts is refused, and redirects are not followed, so a server cannot steer the platform
// somewhere else.

const CLIENT_NAME = "Agentic Engineering Platform";
const TIMEOUT_MS = 15_000;

export type McpOAuthOptions = EgressOptions & {
  /** Replaces the global fetch, for tests. */
  readonly fetch?: typeof fetch;
};

/** fetch restricted to the manifest's egress hosts, without redirects, with a timeout. */
export function guardedFetch(manifest: ConnectorManifest, options: McpOAuthOptions): FetchLike {
  const base = options.fetch ?? fetch;
  return async (input, init) => {
    const url = input instanceof URL ? input.toString() : input;
    const allowed = checkEgress(manifest, url, options);
    if (!allowed.ok) {
      throw Object.assign(new Error(`egress refused for ${manifest.id}: ${allowed.error.reason}`), {
        code: "egress_refused",
      });
    }
    return base(allowed.value, {
      ...init,
      redirect: "manual",
      signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  };
}

/** What register() keeps in ClientRegistration.details; all public. */
type Details = {
  readonly authorizationServerUrl: string;
  readonly metadata: AuthorizationServerMetadata;
  readonly clientInformation: OAuthClientInformationMixed;
  readonly resource?: string;
};

const detailsOf = (registration: ClientRegistration): Details =>
  registration.details as unknown as Details;

const toTokenSet = (tokens: OAuthTokens, now: number): TokenSet => ({
  accessToken: tokens.access_token,
  ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
  ...(tokens.expires_in === undefined
    ? {}
    : { expiresAt: new Date(now + tokens.expires_in * 1000) }),
  ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
});

export function mcpOAuth(options: McpOAuthOptions): ConnectorOAuth {
  return {
    async register(manifest, server, redirectUri) {
      if (manifest.auth.registration !== "dynamic") {
        throw new Error(`connector ${manifest.id}: only dynamic client registration is supported`);
      }
      const fetchFn = guardedFetch(manifest, options);
      const info = await discoverOAuthServerInfo(server.url, { fetchFn });
      const metadata = info.authorizationServerMetadata;
      if (metadata === undefined) {
        throw new Error(`connector ${manifest.id}: no authorization server metadata`);
      }
      if (metadata.registration_endpoint === undefined) {
        throw new Error(`connector ${manifest.id}: the server offers no dynamic registration`);
      }
      // Deprecated in the MCP spec 2026-07-28 in favour of Client ID Metadata Documents, which
      // need the authorization server to fetch a document from outside; deployments closed to
      // inbound traffic cannot offer that. Usable until at least 2027-07-28 (#52, #56).
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const clientInformation = await registerClient(info.authorizationServerUrl, {
        metadata,
        clientMetadata: {
          client_name: CLIENT_NAME,
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: manifest.auth.scopes.join(" "),
        },
        fetchFn,
      });
      const resource = info.resourceMetadata?.resource;
      const details: Details = {
        authorizationServerUrl: info.authorizationServerUrl,
        metadata,
        clientInformation,
        ...(resource === undefined ? {} : { resource }),
      };
      return {
        connectorId: manifest.id,
        serverId: server.id,
        redirectUri,
        issuer: metadata.issuer,
        clientId: clientInformation.client_id,
        details,
      };
    },

    async authorizationUrl(manifest, registration, request) {
      const d = detailsOf(registration);
      const { authorizationUrl, codeVerifier } = await startAuthorization(
        d.authorizationServerUrl,
        {
          metadata: d.metadata,
          clientInformation: d.clientInformation,
          redirectUrl: registration.redirectUri,
          scope: request.scopes.join(" "),
          state: request.state,
          ...(d.resource === undefined ? {} : { resource: d.resource }),
        },
      );
      // The browser goes there, not the platform; still, never send a person off the manifest.
      const allowed = checkEgress(manifest, authorizationUrl.toString(), options);
      if (!allowed.ok) throw new Error(`connector ${manifest.id}: ${allowed.error.reason}`);
      return { url: authorizationUrl.toString(), codeVerifier };
    },

    async exchange(manifest, registration, grant) {
      const d = detailsOf(registration);
      const tokens = await exchangeAuthorization(d.authorizationServerUrl, {
        metadata: d.metadata,
        clientInformation: d.clientInformation,
        authorizationCode: grant.code,
        codeVerifier: grant.codeVerifier,
        redirectUri: registration.redirectUri,
        ...(grant.iss === undefined ? {} : { iss: grant.iss }),
        ...(d.resource === undefined ? {} : { resource: d.resource }),
        fetchFn: guardedFetch(manifest, options),
      });
      return toTokenSet(tokens, Date.now());
    },

    async refresh(manifest, registration, refreshToken) {
      const d = detailsOf(registration);
      let tokens: OAuthTokens;
      try {
        tokens = await refreshAuthorization(d.authorizationServerUrl, {
          metadata: d.metadata,
          clientInformation: d.clientInformation,
          refreshToken,
          ...(d.resource === undefined ? {} : { resource: d.resource }),
          fetchFn: guardedFetch(manifest, options),
        });
      } catch (error) {
        // RFC 6749 §5.2: the grant is invalid, expired or revoked; connecting again is the way out.
        if (OAuthError.isInstance(error) && error.code === "invalid_grant") {
          throw new RefreshRefusedError(manifest.id);
        }
        throw error;
      }
      // RFC 6749 §6: a server may keep the refresh token; the old one then stays valid.
      return toTokenSet(
        { ...tokens, refresh_token: tokens.refresh_token ?? refreshToken },
        Date.now(),
      );
    },

    async revoke(manifest, registration, token) {
      const d = detailsOf(registration);
      // OpenID metadata types leave it out, though providers may publish it there too.
      const endpoint =
        "revocation_endpoint" in d.metadata ? d.metadata.revocation_endpoint : undefined;
      if (typeof endpoint !== "string") return;
      const response = await guardedFetch(manifest, options)(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: token.value,
          token_type_hint: token.hint,
          client_id: registration.clientId,
        }).toString(),
      });
      // RFC 7009 §2.2: 200 also for a token already invalid. Anything else is retried.
      if (response.status !== 200) {
        throw Object.assign(new Error(`revocation answered ${String(response.status)}`), {
          code: `revocation_${String(response.status)}`,
        });
      }
    },
  };
}
