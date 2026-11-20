import { ConnectorCallbackResponse } from "@aep/contracts";
import { NextResponse, type NextRequest } from "next/server";
import { callApi } from "../../../lib/api";

// The connector's authorization server sends the browser back here (ADR-013). Behind the proxy,
// so only a signed-in person gets this far. The query goes to the API as it came: the API checks
// that the state belongs to this person and is fresh, and the worker exchanges the code. Nothing
// from the query is shown on the page.

export const dynamic = "force-dynamic";

const back = (path: string): NextResponse =>
  // Relative, like the OIDC callback: request.url carries the address the server listens on.
  new NextResponse(null, { status: 303, headers: { location: path } });

const param = (request: NextRequest, name: string): string | undefined =>
  request.nextUrl.searchParams.get(name) ?? undefined;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const state = param(request, "state");
  if (state === undefined || state === "") {
    return back(
      `/connections?error=${encodeURIComponent("接続先からの応答に state がありません")}`,
    );
  }
  const code = param(request, "code");
  const iss = param(request, "iss");
  const error = param(request, "error");
  const result = await callApi(
    "/v1/connections/oauth/callback",
    {
      method: "POST",
      body: {
        state,
        ...(code === undefined ? {} : { code }),
        ...(iss === undefined ? {} : { iss }),
        ...(error === undefined ? {} : { error }),
      },
    },
    ConnectorCallbackResponse,
  );
  if (!result.ok) {
    const message =
      result.status === 400
        ? "接続の手続きが見つからないか、期限（10 分）が切れました。もう一度接続してください"
        : result.message;
    return back(`/connections?error=${encodeURIComponent(message)}`);
  }
  return back("/connections");
}
