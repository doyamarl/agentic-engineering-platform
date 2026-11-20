// Model endpoints are limited to APIs whose terms exclude training on inputs (PRD FR-15,
// ADR-012). The worker checks its configuration against this list before it starts, and refuses
// to start otherwise. OpenAI and the Bedrock and Vertex AI routes join when their adapters do.

export const ALLOWED_MODEL_ENDPOINTS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["https://api.anthropic.com"],
  // In-process replies for tests and local demos; nothing leaves the worker.
  fake: [],
};

export type ModelEndpoint = { readonly provider: string; readonly baseUrl?: string };

/** Undefined when allowed, else why not. */
export function modelEndpointProblem(endpoint: ModelEndpoint): string | undefined {
  const allowed = ALLOWED_MODEL_ENDPOINTS[endpoint.provider];
  if (allowed === undefined) {
    return `model provider ${endpoint.provider} is not allowed (allowed: ${Object.keys(ALLOWED_MODEL_ENDPOINTS).join(", ")})`;
  }
  if (endpoint.baseUrl === undefined) return undefined;
  let origin: string;
  try {
    const url = new URL(endpoint.baseUrl);
    if (url.pathname !== "/" || url.search !== "" || url.username !== "" || url.password !== "") {
      return `model base URL ${url.origin} must be an origin without a path`;
    }
    origin = url.origin;
  } catch {
    return "model base URL is not a URL";
  }
  return allowed.includes(origin)
    ? undefined
    : `model endpoint ${origin} is not allowed for ${endpoint.provider} (allowed: ${allowed.join(", ") || "none"})`;
}
