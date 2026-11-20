// Server-only: reads API_BASE_URL from the server environment, never exposed to the browser.
export type ApiStatus = { readonly reachable: boolean; readonly detail: string };

export async function fetchApiStatus(): Promise<ApiStatus> {
  const base = process.env["API_BASE_URL"];
  if (!base) return { reachable: false, detail: "API_BASE_URL is not set" };
  try {
    const response = await fetch(new URL("/healthz", base), {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    return { reachable: response.ok, detail: `HTTP ${String(response.status)}` };
  } catch (error) {
    return { reachable: false, detail: error instanceof Error ? error.name : "request failed" };
  }
}
