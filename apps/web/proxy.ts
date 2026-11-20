import { TokensDto } from "@aep/contracts";
import { NextResponse, type NextRequest } from "next/server";
import { callApi } from "./app/lib/api";
import {
  clearedCookies,
  cookieNames,
  expiresSoon,
  sessionCookies,
  type CookieSpec,
} from "./app/lib/session";

// Runs before every page, route handler and server action except /login and /healthz (see the
// matcher). It refreshes an access token that is missing or about to expire, so the render
// that follows sees a fresh one, and sends people without a session to /login.
// Pages and actions still pass every call through the API, which authorizes each request;
// this only decides where to send the browser.

/** Route handlers answer JSON; a redirect to the login page would be parsed as data. */
const isJsonRoute = (path: string) => /^\/(missions|threads)\/[^/]+\/events$/.test(path);

function proceed(request: NextRequest, cookies: readonly CookieSpec[]): NextResponse {
  const names = cookieNames();
  const path = request.nextUrl.pathname;
  const mustChange =
    cookies.find((c) => c.name === names.mustChange)?.value ??
    request.cookies.get(names.mustChange)?.value;
  const response =
    mustChange === "1" && path !== "/password" && request.method === "GET" && !isJsonRoute(path)
      ? NextResponse.redirect(new URL("/password", request.url))
      : NextResponse.next({ request: { headers: request.headers } });
  for (const cookie of cookies) response.cookies.set(cookie);
  return response;
}

function unauthenticated(request: NextRequest): NextResponse {
  const path = request.nextUrl.pathname;
  const response = isJsonRoute(path)
    ? NextResponse.json({ error: "ログインしていません" }, { status: 401 })
    : NextResponse.redirect(
        new URL(`/login?next=${encodeURIComponent(path + request.nextUrl.search)}`, request.url),
      );
  for (const cookie of clearedCookies()) response.cookies.set(cookie);
  return response;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const names = cookieNames();
  const access = request.cookies.get(names.access)?.value;
  if (access !== undefined && access !== "" && !expiresSoon(access, Date.now())) {
    return proceed(request, []);
  }

  const refreshToken = request.cookies.get(names.refresh)?.value;
  if (refreshToken === undefined || refreshToken === "") return unauthenticated(request);

  const refreshed = await callApi(
    "/v1/auth/refresh",
    { method: "POST", body: { refreshToken }, auth: false },
    TokensDto,
  );
  if (!refreshed.ok) {
    // An unreachable API is not a logout: let the page render its "cannot connect" message.
    return refreshed.status === 0 ? proceed(request, []) : unauthenticated(request);
  }
  const cookies = sessionCookies(refreshed.value);
  // The render after this proxy reads the request's cookies, so it must see the new token too.
  for (const cookie of cookies) request.cookies.set(cookie.name, cookie.value);
  return proceed(request, cookies);
}

export const config = {
  matcher: ["/((?!login|healthz|_next/static|_next/image|favicon\\.ico).*)"],
};
