import type { WorkspaceId } from "@aep/domain";
import {
  TOOL_LIMITS,
  toolName,
  type GatewayCallResult,
  type GatewayTool,
  type ToolCallOutcome,
} from "../connectors/connector-gateway.ts";
import type { ConnectionScope } from "../connectors/connector-ports.ts";
import type { AuditLog } from "../members/member-ports.ts";
import {
  repositoryKey,
  sameRepository,
  type WorkspaceRepositories,
} from "../workspaces/workspace-repositories.ts";
import { CodeReadError, type CodeReader } from "./code-reader.ts";
import type { RepositoryRef } from "./git-port.ts";

// Read tools over the code of a thread's workspace (#52 scope 7). They read through the
// instance's GitHub App, not a person's connection, and only the repositories an admin registered
// for the workspace (owner decision 2026-11-17): the repository the model names is checked against
// that list on every call, so a repository outside the workspace is refused and audited like a
// connector tool the manifest does not allow. Search queries may not carry qualifiers such as
// `repo:`, which would widen the search beyond the repository. There are no write tools.

/** Tool names start with `github__`; no connector manifest may use this id with these tools on. */
export const CODE_CONNECTOR = "github";
export const SEARCH_CODE = "search_code";
export const READ_FILE = "read_file";

const MAX_QUERY = 256;
const MAX_PATH = 1_000;
const MAX_REF = 255;
const MAX_ENTRIES = 1_000;
/** Search qualifiers that would choose other repositories. */
const SCOPE_QUALIFIER = /(^|[\s(])-?(repo|org|user|owner|enterprise):/i;
/** Control characters (U+0000–U+001F, U+007F) have no place in a path or a query. */
const hasControl = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};
const REF = /^[A-Za-z0-9._/-]+$/;

export type CodeTools = {
  /** The tools for a thread of `workspaceId`; none when the workspace has no repositories. */
  tools(scope: ConnectionScope, workspaceId: WorkspaceId): Promise<readonly GatewayTool[]>;
  call(
    scope: ConnectionScope,
    request: {
      readonly workspaceId: WorkspaceId;
      readonly threadId: string;
      readonly name: string;
      readonly input: unknown;
    },
    signal: AbortSignal,
  ): Promise<GatewayCallResult & { readonly repository?: string }>;
};

export type CodeToolsDeps = {
  readonly repositories: Pick<WorkspaceRepositories, "list">;
  readonly reader: CodeReader;
  readonly audit: Pick<AuditLog, "record">;
  readonly limits?: { readonly callMs?: number; readonly resultChars?: number };
};

const field = (input: unknown, key: string): unknown =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)[key]
    : undefined;

/** `owner/name` → RepositoryRef, or undefined. */
function parseRepository(value: unknown): RepositoryRef | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return undefined;
  return { owner: parts[0] ?? "", name: parts[1] ?? "" };
}

/** A repository-relative path, or a reason it is not one. */
function pathProblem(path: string): string | undefined {
  if (path.length > MAX_PATH) return "The path is too long.";
  if (hasControl(path) || path.startsWith("/") || path.includes("\\")) {
    return "The path must be relative to the repository root, without a leading slash.";
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    return "The path may not contain `.` or `..` segments.";
  }
  return undefined;
}

function refProblem(ref: string): string | undefined {
  if (
    ref.length > MAX_REF ||
    !REF.test(ref) ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.includes("..")
  ) {
    return "`ref` must be a branch, tag or commit SHA.";
  }
  return undefined;
}

function cut(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return { text: text.slice(0, end), truncated: true };
}

export function workspaceCodeTools(deps: CodeToolsDeps): CodeTools {
  const limits = {
    callMs: deps.limits?.callMs ?? TOOL_LIMITS.callMs,
    resultChars: deps.limits?.resultChars ?? TOOL_LIMITS.resultChars,
  };

  const describe = (repositories: readonly string[]) => {
    const which = `The workspace's GitHub repositories (${repositories.join(", ")}), read through the platform's GitHub App.`;
    return {
      search: `${which} Searches the code on the default branch of one repository and returns matching file paths with short fragments. Only files under 384 KB are searchable. Qualifiers such as path:, language: and extension: work; qualifiers that choose repositories (repo:, org:, user:) are refused.`,
      read: `${which} Reads one file, or lists one directory, of one repository. Use "" as the path for the root directory. Files over 1 MB and binary files are not returned.`,
    };
  };

  return {
    async tools(scope, workspaceId) {
      const listed = (await deps.repositories.list(scope.tenantId, workspaceId)) ?? [];
      if (listed.length === 0) return [];
      const names = listed.map(repositoryKey);
      const repository = {
        type: "string",
        enum: names,
        description: "The repository, as owner/name.",
      };
      const text = describe(names);
      const tool = (name: string, description: string, inputSchema: GatewayTool["inputSchema"]) =>
        ({
          name: toolName(CODE_CONNECTOR, name),
          connectorId: CODE_CONNECTOR,
          tool: name,
          toolClass: "read",
          description,
          inputSchema,
        }) satisfies GatewayTool;
      return [
        tool(SEARCH_CODE, text.search, {
          type: "object",
          properties: {
            repository,
            query: { type: "string", maxLength: MAX_QUERY, description: "Search terms." },
          },
          required: ["repository", "query"],
          additionalProperties: false,
        }),
        tool(READ_FILE, text.read, {
          type: "object",
          properties: {
            repository,
            path: {
              type: "string",
              maxLength: MAX_PATH,
              description:
                'A path from the repository root, such as "src/index.ts"; "" for the root.',
            },
            ref: {
              type: "string",
              maxLength: MAX_REF,
              description: "A branch, tag or commit SHA; the default branch if omitted.",
            },
          },
          required: ["repository", "path"],
          additionalProperties: false,
        }),
      ];
    },

    async call(scope, request, signal) {
      const prefix = `${CODE_CONNECTOR}__`;
      const tool = request.name.startsWith(prefix)
        ? request.name.slice(prefix.length)
        : request.name;
      const started = Date.now();
      let repositoryLabel: string | undefined;
      const done = async (
        outcome: ToolCallOutcome,
        content: string,
        details: { truncated?: boolean; resultChars?: number } = {},
      ) => {
        await deps.audit.record(scope.tenantId, {
          type: "connector.tool_called",
          actorId: scope.userId,
          subjectId: scope.userId,
          payload: {
            connectorId: CODE_CONNECTOR,
            tool,
            class: "read",
            outcome,
            threadId: request.threadId,
            durationMs: Date.now() - started,
            approvalId: null,
            resultChars: details.resultChars ?? 0,
            repository: repositoryLabel ?? null,
          },
        });
        return {
          connectorId: CODE_CONNECTOR,
          tool,
          outcome,
          content,
          truncated: details.truncated ?? false,
          ...(repositoryLabel === undefined ? {} : { repository: repositoryLabel }),
        };
      };

      if (tool !== SEARCH_CODE && tool !== READ_FILE) return done("refused", "No such tool.");
      const asked = parseRepository(field(request.input, "repository"));
      const listed = (await deps.repositories.list(scope.tenantId, request.workspaceId)) ?? [];
      const repository =
        asked === undefined ? undefined : listed.find((r) => sameRepository(r, asked));
      if (repository === undefined) {
        repositoryLabel =
          asked === undefined ? undefined : `${asked.owner}/${asked.name}`.slice(0, 201);
        return done(
          "refused",
          "This repository is not one of the workspace's repositories, so it cannot be read.",
        );
      }
      repositoryLabel = repositoryKey(repository);

      const timeout = AbortSignal.timeout(limits.callMs);
      const callSignal = AbortSignal.any([signal, timeout]);
      const finish = (text: string) => {
        const { text: content, truncated } = cut(text, limits.resultChars);
        return done("ok", content, { truncated, resultChars: text.length });
      };
      try {
        if (tool === SEARCH_CODE) {
          const query = field(request.input, "query");
          if (typeof query !== "string" || query.trim() === "" || query.length > MAX_QUERY) {
            return await done(
              "tool_error",
              `\`query\` must be 1 to ${String(MAX_QUERY)} characters.`,
            );
          }
          if (SCOPE_QUALIFIER.test(query) || hasControl(query)) {
            return await done(
              "refused",
              "Qualifiers that choose repositories (repo:, org:, user:, owner:, enterprise:) are not allowed; the tool searches the repository you name.",
            );
          }
          const found = await deps.reader.search(repository, query, callSignal);
          const lines = found.items.flatMap((item) => [
            `- ${item.path}`,
            ...item.fragments.map((f) => `    ${f.replaceAll("\n", "\n    ")}`),
          ]);
          return await finish(
            found.items.length === 0
              ? `No code in ${repositoryLabel} matches.`
              : `${String(found.total)} files in ${repositoryLabel} match; ${String(found.items.length)} shown:\n${lines.join("\n")}`,
          );
        }

        const path = field(request.input, "path") ?? "";
        const ref = field(request.input, "ref");
        if (typeof path !== "string") return await done("tool_error", "`path` must be a string.");
        if (ref !== undefined && typeof ref !== "string") {
          return await done("tool_error", "`ref` must be a string.");
        }
        const problem = pathProblem(path) ?? (ref === undefined ? undefined : refProblem(ref));
        if (problem !== undefined) return await done("tool_error", problem);
        const read = await deps.reader.readPath(
          repository,
          { path, ...(ref === undefined ? {} : { ref }) },
          callSignal,
        );
        const where = `${repositoryLabel}:${path === "" ? "/" : path}${ref === undefined ? "" : ` at ${ref}`}`;
        switch (read.kind) {
          case "not_found":
            return await done("tool_error", `${where} does not exist.`);
          case "binary":
            return await done(
              "tool_error",
              `${where} is a binary file (${String(read.size)} bytes).`,
            );
          case "too_large":
            return await done(
              "tool_error",
              `${where} is too large to read (${String(read.size)} bytes; the limit is 1 MB).`,
            );
          case "directory": {
            const shown = read.entries.slice(0, MAX_ENTRIES);
            const lines = shown.map(
              (e) => `${e.type === "dir" ? "dir " : e.type === "file" ? "file" : e.type} ${e.path}`,
            );
            return await finish(
              `Directory ${where} (${String(read.entries.length)} entries):\n${lines.join("\n")}`,
            );
          }
          case "file":
            return await finish(`File ${where} (${String(read.size)} bytes):\n\n${read.text}`);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (timeout.aborted) {
          return done(
            "timeout",
            `GitHub did not answer within ${String(limits.callMs / 1000)} seconds.`,
          );
        }
        if (error instanceof CodeReadError) {
          return done(
            "tool_error",
            error.reason === "rate_limited"
              ? "GitHub's rate limit was reached (code search allows 10 searches a minute); try again shortly."
              : `The platform's GitHub App is not installed on ${repositoryLabel}; an admin must install it.`,
          );
        }
        return done("failed", "Reading from GitHub failed.");
      }
    },
  };
}
