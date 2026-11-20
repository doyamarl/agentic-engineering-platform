import type { RepositoryRef } from "./git-port.ts";

// Reading a repository's code without cloning it (#52 scope 7): one file or directory, or a code
// search. The GitHub adapter reads through the instance's GitHub App with a read-only token
// scoped to the one repository. Callers check which repositories may be read; this port does not.

export type CodeEntry = {
  readonly path: string;
  readonly type: "file" | "dir" | "symlink" | "submodule";
};

export type ReadPathResult =
  | { readonly kind: "file"; readonly path: string; readonly size: number; readonly text: string }
  | { readonly kind: "directory"; readonly path: string; readonly entries: readonly CodeEntry[] }
  /** Not text (a NUL byte, or not UTF-8). */
  | { readonly kind: "binary"; readonly path: string; readonly size: number }
  /** Over 1 MB: GitHub does not send the content inline. */
  | { readonly kind: "too_large"; readonly path: string; readonly size: number }
  | { readonly kind: "not_found" };

export type CodeSearchResult = {
  readonly total: number;
  readonly items: readonly { readonly path: string; readonly fragments: readonly string[] }[];
};

/** The repository cannot be read, for a reason worth telling the person. */
export class CodeReadError extends Error {
  readonly reason: "not_installed" | "rate_limited";

  constructor(reason: "not_installed" | "rate_limited", message: string) {
    super(message);
    this.name = "CodeReadError";
    this.reason = reason;
  }
}

export interface CodeReader {
  /** `path` is relative to the repository root ("" for the root); `ref` defaults to the default branch. */
  readPath(
    repository: RepositoryRef,
    request: { readonly path: string; readonly ref?: string },
    signal: AbortSignal,
  ): Promise<ReadPathResult>;
  /** Searches the default branch. `query` holds search terms only, never qualifiers. */
  search(repository: RepositoryRef, query: string, signal: AbortSignal): Promise<CodeSearchResult>;
}
