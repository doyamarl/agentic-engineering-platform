import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import type { RepositoryRef } from "@aep/application";

// GitHub App authentication. The App's private key signs a JWT valid for 9 minutes; the JWT buys
// an installation access token that GitHub expires after an hour. Each token is scoped down to
// the one repository and the permissions this adapter needs, so a leaked token cannot reach other
// repositories the App is installed on.

export type GitHubAppConfig = {
  readonly appId: string;
  /** PEM. Read from a file the operator controls; never logged. */
  readonly privateKey: string;
  /** Defaults to https://api.github.com (GitHub Enterprise Server: https://HOST/api/v3). */
  readonly apiUrl?: string;
  /** Replaces global fetch in tests. */
  readonly fetch?: typeof fetch;
};

/** The permissions requested for every installation token. */
export const TOKEN_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "read",
  // CI results of the draft pull request (mission.verify).
  checks: "read",
  statuses: "read",
} as const;

/** For reading code in chat (#52 scope 7): nothing else, so a leak cannot write. */
export const READ_PERMISSIONS = { contents: "read" } as const;

export type TokenPermissions = Readonly<Record<string, "read" | "write">>;

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number, message: string) {
    super(`GitHub ${method} ${path} failed (${String(status)}): ${message}`);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export type InstallationToken = {
  readonly token: string;
  readonly expiresAt: Date;
};

/** GitHub's error body is `{ message: string, ... }`. */
export function errorMessage(data: unknown): string {
  return typeof data === "object" && data !== null && "message" in data
    ? String(data.message)
    : "no message";
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/** RS256 JWT identifying the App, as GitHub requires: iat 60 s in the past, exp under 10 min. */
export function appJwt(appId: string, key: KeyObject, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${b64url(signature)}`;
}

export type RequestOptions = {
  /** The media type to ask for; application/vnd.github+json by default. */
  readonly accept?: string;
  readonly signal?: AbortSignal;
};

export type GitHubApp = {
  /** Calls the REST API with the given bearer credential. */
  request(
    method: string,
    path: string,
    credential: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<{ status: number; data: unknown; headers: Headers }>;
  /** A fresh installation token limited to `repository` and `permissions` (TOKEN_PERMISSIONS). */
  installationToken(
    repository: RepositoryRef,
    permissions?: TokenPermissions,
  ): Promise<InstallationToken>;
};

export function gitHubApp(config: GitHubAppConfig): GitHubApp {
  const apiUrl = (config.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const key = createPrivateKey(config.privateKey);

  async function request(
    method: string,
    path: string,
    credential: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<{ status: number; data: unknown; headers: Headers }> {
    const response = await doFetch(`${apiUrl}${path}`, {
      method,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      headers: {
        accept: options.accept ?? "application/vnd.github+json",
        authorization: `Bearer ${credential}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "agentic-engineering-platform",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const data: unknown = text === "" ? undefined : JSON.parse(text);
    return { status: response.status, data, headers: response.headers };
  }

  /** The response body of a 2xx response; anything else throws GitHubApiError. */
  async function expect2xx(method: string, path: string, credential: string, body?: unknown) {
    const { status, data } = await request(method, path, credential, body);
    if (status < 200 || status > 299) {
      throw new GitHubApiError(method, path, status, errorMessage(data));
    }
    return data;
  }

  return {
    request,
    async installationToken(repository, permissions = TOKEN_PERMISSIONS) {
      const jwt = appJwt(config.appId, key);
      const repo = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
      const installation = (await expect2xx("GET", `${repo}/installation`, jwt)) as { id: number };
      const path = `/app/installations/${String(installation.id)}/access_tokens`;
      const issued = (await expect2xx("POST", path, jwt, {
        repositories: [repository.name],
        permissions,
      })) as { token: string; expires_at: string };
      return { token: issued.token, expiresAt: new Date(issued.expires_at) };
    },
  };
}
