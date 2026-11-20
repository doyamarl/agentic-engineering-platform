// Server-only API client for the UI. Runs in the proxy, server components, server actions and
// route handlers. Each request acts as the signed-in person: the access token comes from their
// HttpOnly session cookie (lib/session.ts) and never reaches browser JavaScript.

import { ErrorDto } from "@aep/contracts";
import { cookieNames } from "./session";

export type ApiFailure = {
  readonly ok: false;
  /** HTTP status, or 0 when the API could not be reached or is not configured. */
  readonly status: number;
  /** The API's error code (ErrorDto), when it sent one. */
  readonly code?: string;
  readonly message: string;
};
export type ApiResult<T> = { readonly ok: true; readonly value: T } | ApiFailure;

type Schema<T> = { parse(data: unknown): T };
type Env = Readonly<Record<string, string | undefined>>;

export type ApiDeps = {
  readonly env?: Env;
  readonly fetch?: typeof fetch;
  /** The bearer token to use instead of the session cookie (tests, the proxy). */
  readonly token?: string;
};

/** The signed-in person's access token from the session cookie, if any. */
export async function sessionToken(env: Env = process.env): Promise<string | undefined> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(cookieNames(env).access)?.value;
  return token === undefined || token === "" ? undefined : token;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** For responses without a body (204). */
export const NoContent: Schema<undefined> = { parse: () => undefined };

/** True for an id that is safe to put in an API path. */
export const isUuid = (value: string): boolean => UUID.test(value);

/** `url` if it is an https URL, for use as a link target; otherwise undefined. */
export function httpsUrl(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined) return undefined;
  try {
    return new URL(url).protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Calls the API at `path` (e.g. `/v1/missions`) and validates a 2xx body with `schema`.
 * Never throws for HTTP or network errors; they come back as ApiFailure.
 */
export async function callApi<T>(
  path: string,
  options: {
    readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    readonly body?: unknown;
    /** False for /v1/auth/login, /refresh and /logout, which take no bearer token. */
    readonly auth?: boolean;
  },
  schema: Schema<T>,
  deps: ApiDeps = {},
): Promise<ApiResult<T>> {
  const env = deps.env ?? process.env;
  const base = env["API_BASE_URL"];
  if (base === undefined || base === "") {
    return { ok: false, status: 0, message: "API_BASE_URL が設定されていません" };
  }
  const auth = options.auth ?? true;
  const token = auth ? (deps.token ?? (await sessionToken(env))) : undefined;
  if (auth && token === undefined) {
    return { ok: false, status: 401, message: "ログインしていません" };
  }
  const doFetch = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(new URL(path, base), {
      method: options.method ?? "GET",
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "error";
    return { ok: false, status: 0, message: `API に接続できません (${name})` };
  }
  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = ErrorDto.safeParse(data);
    return {
      ok: false,
      status: response.status,
      ...(parsed.success ? { code: parsed.data.error.code } : {}),
      message: parsed.success ? parsed.data.error.message : `HTTP ${String(response.status)}`,
    };
  }
  try {
    return { ok: true, value: schema.parse(data) };
  } catch {
    return { ok: false, status: response.status, message: "API の応答が契約と一致しません" };
  }
}
