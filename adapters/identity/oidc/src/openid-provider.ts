import type { OidcChecks, OidcClaims, OidcProvider, OidcStart } from "@aep/application";
import * as client from "openid-client";

// The instance's identity provider through openid-client (ADR-011): authorization code flow
// with PKCE (S256), state and nonce. openid-client verifies the ID token's signature against
// the provider's JWKS and checks issuer, audience, expiry and nonce.

export type OpenIdSettings = {
  readonly issuer: URL;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The web UI's callback, registered at the provider exactly as written here. */
  readonly redirectUri: URL;
  /** Shown on the login button. */
  readonly name: string;
  /** Allows an http:// issuer; for local stacks and CI only. */
  readonly allowHttp?: boolean;
};

const SCOPE = "openid email";

export class OpenIdProvider implements OidcProvider {
  readonly name: string;
  readonly #settings: OpenIdSettings;
  #config: Promise<client.Configuration> | undefined;

  constructor(settings: OpenIdSettings) {
    if (settings.issuer.protocol !== "https:" && settings.allowHttp !== true) {
      throw new Error(
        "the OIDC issuer must use https (set AEP_OIDC_ALLOW_HTTP=true for local tests)",
      );
    }
    this.name = settings.name;
    this.#settings = settings;
  }

  /** Discovers the provider on first use; a failed discovery is retried on the next login. */
  #configuration(): Promise<client.Configuration> {
    const { issuer, clientId, clientSecret, allowHttp } = this.#settings;
    this.#config ??= client
      .discovery(
        issuer,
        clientId,
        clientSecret,
        undefined,
        allowHttp === true
          ? // openid-client marks this deprecated only so that it stands out; it is meant for
            // exactly this: a local or CI provider on plain HTTP, opted into explicitly.
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            { execute: [client.allowInsecureRequests] }
          : undefined,
      )
      .catch((error: unknown) => {
        this.#config = undefined;
        throw error;
      });
    return this.#config;
  }

  async start(): Promise<OidcStart> {
    const config = await this.#configuration();
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.#settings.redirectUri.href,
      scope: SCOPE,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { authorizationUrl: url.href, state, nonce, codeVerifier };
  }

  async finish(callback: URL, checks: OidcChecks): Promise<OidcClaims | undefined> {
    try {
      const config = await this.#configuration();
      const tokens = await client.authorizationCodeGrant(config, callback, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (claims === undefined) return undefined;
      const email = typeof claims["email"] === "string" ? claims["email"] : undefined;
      return {
        issuer: claims.iss,
        subject: claims.sub,
        ...(email === undefined ? {} : { email }),
        // Only a literal true counts; providers that omit the claim have not verified the email.
        emailVerified: claims["email_verified"] === true,
      };
    } catch {
      // A refused login, a replayed or forged callback, a bad token: all mean "not logged in".
      return undefined;
    }
  }
}
