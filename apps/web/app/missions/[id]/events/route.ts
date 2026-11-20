import { MissionEventListDto } from "@aep/contracts";
import { callApi, isUuid } from "../../../lib/api";

// The detail page's event log polls this (same origin) for events after the last seq it has.

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const after = new URL(request.url).searchParams.get("after") ?? "0";
  if (!isUuid(id) || !/^[0-9]{1,15}$/.test(after)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const result = await callApi(`/v1/missions/${id}/events?after=${after}`, {}, MissionEventListDto);
  return result.ok
    ? Response.json(result.value)
    : Response.json(
        { error: result.message },
        { status: result.status === 0 ? 502 : result.status },
      );
}
