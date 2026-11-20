import { TokensDto } from "@aep/contracts";
import { NextResponse, type NextRequest } from "next/server";
import { callApi } from "../../../lib/api";
import { cookieNames, readOidcCookie, sessionCookies, type CookieSpec } from "../../../lib/session";

// The identity provider redirects the browser here (ADR-011). The API exchanges the code and
// checks state, nonce and PKCE against what the login started with; this route only carries the
// query and the cookie over, then sets the session cookies. Not behind the proxy (see matcher).

export const dynamic = "force-dynamic";

function done(path: string, cookies: readonly CookieSpec[]): NextResponse {
  // A relative Location: request.url carries the address the server listens on (0.0.0.0 in a
  // container), not the host the browser used, and the session cookies belong to the latter.
  const response = new NextResponse(null, { status: 303, headers: { location: path } });
  // The checks are good for one attempt only, whatever its outcome.
  response.cookies.set(cookieNames().oidc, "", { path: "/", expires: new Date(0) });
  for (const cookie of cookies) response.cookies.set(cookie);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const pending = readOidcCookie(request.cookies.get(cookieNames().oidc)?.value);
  if (pending === undefined) return done("/login?error=oidc", []);
  const result = await callApi(
    "/v1/auth/oidc/callback",
    {
      method: "POST",
      body: {
        query: request.nextUrl.search,
        state: pending.state,
        nonce: pending.nonce,
        codeVerifier: pending.codeVerifier,
      },
      auth: false,
    },
    TokensDto,
  );
  if (!result.ok) {
    const error = result.status === 0 ? "unavailable" : "oidc";
    return done(`/login?error=${error}&next=${encodeURIComponent(pending.next)}`, []);
  }
  return done(pending.next, sessionCookies(result.value));
}
