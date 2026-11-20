import type { AccessClaims, AccessTokenCodec } from "@aep/application";
import { parseId } from "@aep/domain";
import { jwtVerify, SignJWT } from "jose";

// HS256 access tokens (ADR-011). The API both issues and verifies them, so one shared secret is
// enough; a second verifying service would be the reason to move to asymmetric keys.

const ALGORITHM = "HS256";
const ISSUER = "aep";
const AUDIENCE = "aep-api";
/** RFC 7518 §3.2: the HS256 key must be at least as long as the hash output. */
export const MIN_SECRET_BYTES = 32;

export class JwtAccessTokens implements AccessTokenCodec {
  readonly #key: Uint8Array;

  constructor(secret: Uint8Array) {
    if (secret.length < MIN_SECRET_BYTES) {
      throw new Error(`the access token secret must be at least ${String(MIN_SECRET_BYTES)} bytes`);
    }
    this.#key = secret;
  }

  issue(claims: AccessClaims, expiresAt: Date): Promise<string> {
    return new SignJWT({ tid: claims.tenantId, sid: claims.sessionId })
      .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(claims.userId)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(this.#key);
  }

  async verify(token: string): Promise<AccessClaims | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        requiredClaims: ["sub", "exp", "tid", "sid"],
      });
      const userId = parseId("UserId", payload.sub ?? "");
      const tenantId = parseId(
        "TenantId",
        typeof payload["tid"] === "string" ? payload["tid"] : "",
      );
      const sessionId = payload["sid"];
      if (!userId.ok || !tenantId.ok || typeof sessionId !== "string") return undefined;
      return { userId: userId.value, tenantId: tenantId.value, sessionId };
    } catch {
      // Bad signature, wrong algorithm, expired, malformed: all mean "not authenticated".
      return undefined;
    }
  }
}
