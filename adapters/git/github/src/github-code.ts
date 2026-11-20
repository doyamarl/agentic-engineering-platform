import {
  CodeReadError,
  type CodeEntry,
  type CodeReader,
  type CodeSearchResult,
  type ReadPathResult,
  type RepositoryRef,
} from "@aep/application";
import {
  errorMessage,
  GitHubApiError,
  READ_PERMISSIONS,
  type GitHubApp,
  type InstallationToken,
} from "./github-app.ts";

// CodeReader over the GitHub REST API (#52 scope 7): the contents endpoint for files and
// directories, code search for searching. Each repository gets an installation token limited to
// it and to `contents: read`, kept in memory until five minutes before it expires. Both endpoints
// take installation tokens (docs.github.com, "Endpoints available for GitHub App installation
// access tokens"). Code search covers the default branch and files under 384 KB only, and allows
// 10 requests a minute.

/** GitHub sends file content inline up to 1 MB. */
const INLINE_LIMIT = 1024 * 1024;
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
const SEARCH_RESULTS = 20;

export type GitHubCodeReaderConfig = {
  readonly app: GitHubApp;
  readonly now?: () => Date;
};

type ContentItem = {
  type?: string;
  path?: string;
  size?: number;
  encoding?: string;
  content?: string;
  target?: string;
  submodule_git_url?: string;
};

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

function rateLimited(status: number, headers: Headers): boolean {
  return (
    status === 429 ||
    (status === 403 &&
      (headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after") !== null))
  );
}

/** UTF-8 text, or undefined for binary content. */
function decodeText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function gitHubCodeReader(config: GitHubCodeReaderConfig): CodeReader {
  const now = config.now ?? (() => new Date());
  const tokens = new Map<string, InstallationToken>();

  async function token(repository: RepositoryRef): Promise<string> {
    const key = `${repository.owner}/${repository.name}`.toLowerCase();
    const cached = tokens.get(key);
    if (
      cached !== undefined &&
      cached.expiresAt.getTime() - TOKEN_REUSE_MARGIN_MS > now().getTime()
    ) {
      return cached.token;
    }
    try {
      const issued = await config.app.installationToken(repository, READ_PERMISSIONS);
      tokens.set(key, issued);
      return issued.token;
    } catch (error) {
      // The App is not installed on the repository (or it does not exist).
      if (error instanceof GitHubApiError && error.status === 404) {
        throw new CodeReadError("not_installed", error.message);
      }
      throw error;
    }
  }

  async function get(
    repository: RepositoryRef,
    path: string,
    signal: AbortSignal,
    accept?: string,
  ): Promise<{ status: number; data: unknown }> {
    const { status, data, headers } = await config.app.request(
      "GET",
      path,
      await token(repository),
      undefined,
      { signal, ...(accept === undefined ? {} : { accept }) },
    );
    if (rateLimited(status, headers)) {
      throw new CodeReadError("rate_limited", `GitHub GET ${path}: rate limited`);
    }
    return { status, data };
  }

  return {
    async readPath(repository, request, signal): Promise<ReadPathResult> {
      const base = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents`;
      const path = `${base}${request.path === "" ? "" : `/${encodePath(request.path)}`}${
        request.ref === undefined ? "" : `?ref=${encodeURIComponent(request.ref)}`
      }`;
      const { status, data } = await get(repository, path, signal);
      if (status === 404) return { kind: "not_found" };
      if (status !== 200) throw new GitHubApiError("GET", path, status, errorMessage(data));

      if (Array.isArray(data)) {
        const entries: CodeEntry[] = (data as ContentItem[]).map((item) => ({
          path: item.path ?? "",
          type:
            item.type === "dir" || item.type === "symlink" || item.type === "submodule"
              ? item.type
              : "file",
        }));
        return { kind: "directory", path: request.path, entries };
      }
      const item = data as ContentItem;
      const size = item.size ?? 0;
      const itemPath = item.path ?? request.path;
      if (item.type === "symlink") {
        return {
          kind: "file",
          path: itemPath,
          size,
          text: `(symbolic link to ${item.target ?? "?"})`,
        };
      }
      if (item.type === "submodule") {
        return {
          kind: "file",
          path: itemPath,
          size,
          text: `(git submodule${item.submodule_git_url === undefined ? "" : ` of ${item.submodule_git_url}`})`,
        };
      }
      if (size > INLINE_LIMIT || item.encoding !== "base64" || item.content === undefined) {
        return { kind: "too_large", path: itemPath, size };
      }
      const text = decodeText(Buffer.from(item.content, "base64"));
      return text === undefined
        ? { kind: "binary", path: itemPath, size }
        : { kind: "file", path: itemPath, size, text };
    },

    async search(repository, query, signal): Promise<CodeSearchResult> {
      const q = `${query} repo:${repository.owner}/${repository.name}`;
      const path = `/search/code?q=${encodeURIComponent(q)}&per_page=${String(SEARCH_RESULTS)}`;
      const { status, data } = await get(
        repository,
        path,
        signal,
        "application/vnd.github.text-match+json",
      );
      if (status !== 200) throw new GitHubApiError("GET", path, status, errorMessage(data));
      const found = data as {
        total_count?: number;
        items?: { path?: string; text_matches?: { fragment?: string }[] }[];
      };
      const items = (found.items ?? []).map((item) => ({
        path: item.path ?? "",
        fragments: (item.text_matches ?? []).flatMap((m) =>
          typeof m.fragment === "string" ? [m.fragment] : [],
        ),
      }));
      return { total: found.total_count ?? items.length, items };
    },
  };
}
