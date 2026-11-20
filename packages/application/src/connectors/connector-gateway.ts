import { checkToolCall, type ConnectorManifest, type ConnectorServer } from "@aep/domain";
import type { AuditLog } from "../members/member-ports.ts";
import type { ModelTool } from "../models/model-port.ts";
import type { SealedSecret, SecretOpener, SecretSealer } from "../secrets/secret-box.ts";
import type { ToolApprovalRepository } from "./tool-approval-ports.ts";
import { tokenContext } from "./connection-jobs.ts";
import {
  McpUnauthorizedError,
  RefreshRefusedError,
  type ConnectionRepository,
  type ConnectionScope,
  type ConnectorCatalog,
  type ConnectorClients,
  type ConnectorOAuth,
  type McpTools,
} from "./connector-ports.ts";

// The connector gateway (ADR-013): the only code that opens a person's tokens and calls an MCP
// server with them. It runs in the worker. The model sees tool names, descriptions and results,
// never a token. Each call is checked against the manifest, limited in time and size, and
// audited with the person, the connector, the tool and its class (PRD FR-12).
//
// Write tools run only with an approval the person gave in the thread (#52 decision 2): the call
// must name an approved approval whose connector, tool and arguments match, and claiming it is
// what lets the call run, once. Text read through a connector cannot cause a write without that
// (PRD scenario I). Without an approval repository, write tools are neither offered nor run.

/** #52 decision 3. */
export const TOOL_LIMITS = { roundTrips: 10, callMs: 60_000, resultChars: 50_000 } as const;

/** Refresh an access token this long before it expires, so a call does not start with a stale one. */
const REFRESH_SKEW_MS = 30_000;
/** Tool descriptions come from the MCP server; cap what reaches the model. */
const MAX_DESCRIPTION = 2_000;
/** What model APIs accept as a tool name. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SEPARATOR = "__";

/** A connector tool as offered to the model: `<connector>__<tool>`. */
export type GatewayTool = ModelTool & {
  readonly connectorId: string;
  readonly tool: string;
  readonly toolClass: "read" | "write";
};

export type ToolCallOutcome =
  | "ok"
  /** The server ran the tool and reported an error. */
  | "tool_error"
  /** Not a tool of a configured connector, not in its manifest, or a write without approval. */
  | "refused"
  | "not_connected"
  /** The provider refused the refresh token; the person must connect again. */
  | "expired"
  | "timeout"
  | "failed";

export type GatewayCallResult = {
  readonly connectorId: string;
  readonly tool: string;
  readonly outcome: ToolCallOutcome;
  /** What the model receives: the result's text, or a short reason. Never a token. */
  readonly content: string;
  readonly truncated: boolean;
};

export type UnavailableConnector = {
  readonly connectorId: string;
  readonly reason: "expired" | "failed";
};

export interface ConnectorGateway {
  /** Read tools of the person's connected connectors, and the connectors that could not answer. */
  tools(
    scope: ConnectionScope,
    signal: AbortSignal,
  ): Promise<{
    readonly tools: readonly GatewayTool[];
    readonly unavailable: readonly UnavailableConnector[];
  }>;
  call(
    scope: ConnectionScope,
    request: {
      readonly name: string;
      readonly input: unknown;
      readonly threadId: string;
      /** Required for a write tool: the person's approval of exactly this call. */
      readonly approvalId?: string;
    },
    signal: AbortSignal,
  ): Promise<GatewayCallResult>;
}

export type ConnectorGatewayDeps = {
  readonly catalog: ConnectorCatalog;
  readonly connections: ConnectionRepository;
  readonly clients: ConnectorClients;
  readonly oauth: ConnectorOAuth;
  readonly mcp: McpTools;
  readonly box: SecretSealer & SecretOpener;
  readonly audit: Pick<AuditLog, "record">;
  /** Enables write tools, each call under an approval from the thread. */
  readonly approvals?: Pick<ToolApprovalRepository, "claim" | "finish">;
  readonly now: () => Date;
  readonly limits?: { readonly callMs?: number; readonly resultChars?: number };
};

export const toolName = (connectorId: string, tool: string): string =>
  `${connectorId}${SEPARATOR}${tool}`;

/** The connector and tool of a `<connector>__<tool>` name. */
export function parseToolName(name: string): { connectorId: string; tool: string } | undefined {
  const at = name.indexOf(SEPARATOR);
  if (at <= 0) return undefined;
  return { connectorId: name.slice(0, at), tool: name.slice(at + SEPARATOR.length) };
}

/** Cuts at most `max` UTF-16 units, without splitting a surrogate pair. */
function cut(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return { text: text.slice(0, end), truncated: true };
}

export function connectorGateway(deps: ConnectorGatewayDeps): ConnectorGateway {
  const limits = {
    callMs: deps.limits?.callMs ?? TOOL_LIMITS.callMs,
    resultChars: deps.limits?.resultChars ?? TOOL_LIMITS.resultChars,
  };
  const { connections, box } = deps;

  const manifestOf = (connectorId: string) =>
    deps.catalog.manifests.find((m) => m.id === connectorId);

  const open = (
    scope: ConnectionScope,
    connectorId: string,
    value: string,
    kind: "access" | "refresh",
  ) =>
    box.open(value as SealedSecret, tokenContext(scope.tenantId, scope.userId, connectorId, kind));
  const seal = (
    scope: ConnectionScope,
    connectorId: string,
    value: string,
    kind: "access" | "refresh",
  ) => box.seal(value, tokenContext(scope.tenantId, scope.userId, connectorId, kind));

  /** Refreshes the stored tokens, unless another reply already did; returns an access token. */
  async function refresh(scope: ConnectionScope, manifest: ConnectorManifest): Promise<string> {
    const stored = await connections.tokens(scope, manifest.id);
    if (stored === undefined) throw new Error(`connector ${manifest.id}: not connected`);
    if (stored.refreshToken === undefined) throw new RefreshRefusedError(manifest.id);
    const registration = await deps.clients.find(
      manifest.id,
      stored.serverId,
      deps.catalog.redirectUri,
    );
    if (registration === undefined) {
      throw new Error(`connector ${manifest.id}: no client registration for ${stored.serverId}`);
    }
    const next = await deps.oauth.refresh(
      manifest,
      registration,
      open(scope, manifest.id, stored.refreshToken, "refresh"),
    );
    const replaced = await connections.replaceTokens(
      scope,
      manifest.id,
      stored.accessToken,
      {
        accessToken: seal(scope, manifest.id, next.accessToken, "access"),
        ...(next.refreshToken === undefined
          ? {}
          : { refreshToken: seal(scope, manifest.id, next.refreshToken, "refresh") }),
        ...(next.expiresAt === undefined ? {} : { expiresAt: next.expiresAt }),
        ...(next.scope === undefined ? {} : { scope: next.scope }),
      },
      deps.now(),
    );
    if (replaced) return next.accessToken;
    // Another reply refreshed first; with rotating refresh tokens ours may now be void.
    const current = await connections.tokens(scope, manifest.id);
    if (current === undefined) throw new Error(`connector ${manifest.id}: disconnected`);
    return open(scope, manifest.id, current.accessToken, "access");
  }

  /** The connected server and a usable access token, or undefined when not connected. */
  async function access(
    scope: ConnectionScope,
    manifest: ConnectorManifest,
  ): Promise<{ server: ConnectorServer; token: string } | undefined> {
    const connection = (await connections.list(scope)).find(
      (c) => c.connectorId === manifest.id && c.status === "connected",
    );
    if (connection === undefined) return undefined;
    const stored = await connections.tokens(scope, manifest.id);
    const server = manifest.servers.find((s) => s.id === stored?.serverId);
    if (stored === undefined || server === undefined) return undefined;
    const stale =
      stored.expiresAt !== undefined &&
      stored.expiresAt.getTime() - REFRESH_SKEW_MS <= deps.now().getTime();
    const token = stale
      ? await refresh(scope, manifest)
      : open(scope, manifest.id, stored.accessToken, "access");
    return { server, token };
  }

  /** Runs `fn` with the token; on 401, refreshes once and runs it again. */
  async function withToken<T>(
    scope: ConnectionScope,
    manifest: ConnectorManifest,
    granted: { server: ConnectorServer; token: string },
    fn: (token: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(granted.token);
    } catch (error) {
      if (!(error instanceof McpUnauthorizedError)) throw error;
      return fn(await refresh(scope, manifest));
    }
  }

  const expire = async (scope: ConnectionScope, connectorId: string) => {
    await connections.markExpired(scope, connectorId, deps.now());
  };

  return {
    async tools(scope, signal) {
      const tools: GatewayTool[] = [];
      const unavailable: UnavailableConnector[] = [];
      for (const manifest of deps.catalog.manifests) {
        const allowed = new Map(
          manifest.tools
            .filter((t) => t.class === "read" || deps.approvals !== undefined)
            .map((t) => [t.name, t.class]),
        );
        try {
          const granted = await access(scope, manifest);
          if (granted === undefined) continue;
          const listed = await withToken(scope, manifest, granted, (token) =>
            deps.mcp.list(
              manifest,
              granted.server,
              token,
              AbortSignal.any([signal, AbortSignal.timeout(limits.callMs)]),
            ),
          );
          for (const info of listed) {
            const name = toolName(manifest.id, info.name);
            // Only what the manifest allows, whatever else the server offers.
            const toolClass = allowed.get(info.name);
            if (toolClass === undefined || !TOOL_NAME.test(name)) continue;
            const approval =
              toolClass === "write"
                ? " Can change data: the person must approve each call, and the reply waits for them."
                : "";
            tools.push({
              name,
              connectorId: manifest.id,
              tool: info.name,
              toolClass,
              description: `${manifest.name}, through the person's own connection.${approval} ${cut(info.description, MAX_DESCRIPTION).text}`,
              inputSchema: info.inputSchema,
            });
          }
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof RefreshRefusedError) {
            await expire(scope, manifest.id);
            unavailable.push({ connectorId: manifest.id, reason: "expired" });
          } else {
            unavailable.push({ connectorId: manifest.id, reason: "failed" });
          }
        }
      }
      return { tools, unavailable };
    },

    async call(scope, request, signal) {
      const parsed = parseToolName(request.name);
      const manifest = parsed === undefined ? undefined : manifestOf(parsed.connectorId);
      const connectorId = parsed?.connectorId ?? "";
      const tool = parsed?.tool ?? request.name;
      const started = Date.now();
      const done = async (
        outcome: ToolCallOutcome,
        content: string,
        details: { truncated?: boolean; toolClass?: string; resultChars?: number } = {},
      ): Promise<GatewayCallResult> => {
        await deps.audit.record(scope.tenantId, {
          type: "connector.tool_called",
          actorId: scope.userId,
          subjectId: scope.userId,
          payload: {
            connectorId,
            tool,
            class: details.toolClass ?? null,
            outcome,
            threadId: request.threadId,
            durationMs: Date.now() - started,
            approvalId: request.approvalId ?? null,
            resultChars: details.resultChars ?? 0,
          },
        });
        return { connectorId, tool, outcome, content, truncated: details.truncated ?? false };
      };

      if (manifest === undefined) return done("refused", "No such tool.");
      const declared = checkToolCall(manifest, tool);
      if (!declared.ok) return done("refused", "This tool is not allowed for this connector.");
      const toolClass = declared.value.class;
      const run = async (): Promise<GatewayCallResult> => {
        const timeout = AbortSignal.timeout(limits.callMs);
        try {
          const granted = await access(scope, manifest);
          if (granted === undefined) {
            return await done("not_connected", `${manifest.name} is not connected.`, { toolClass });
          }
          const result = await withToken(scope, manifest, granted, (token) =>
            deps.mcp.call(
              manifest,
              granted.server,
              token,
              { name: tool, input: request.input },
              AbortSignal.any([signal, timeout]),
            ),
          );
          const { text, truncated } = cut(result.text, limits.resultChars);
          return await done(result.isError ? "tool_error" : "ok", text, {
            truncated,
            toolClass,
            resultChars: result.text.length,
          });
        } catch (error) {
          if (signal.aborted) throw error;
          if (timeout.aborted) {
            return done(
              "timeout",
              `The tool did not answer within ${String(limits.callMs / 1000)} seconds.`,
              {
                toolClass,
              },
            );
          }
          if (error instanceof RefreshRefusedError) {
            await expire(scope, manifest.id);
            return done(
              "expired",
              `The connection to ${manifest.name} has expired; the person must connect again.`,
              { toolClass },
            );
          }
          return done("failed", "The tool call failed.", { toolClass });
        }
      };
      let claimed = false;
      if (toolClass === "write") {
        claimed =
          deps.approvals !== undefined &&
          request.approvalId !== undefined &&
          (await deps.approvals.claim(scope, request.approvalId, {
            connectorId,
            tool,
            input: request.input,
          }));
        if (!claimed) {
          return done(
            "refused",
            "This tool can change data and runs only with the person's approval of this exact call.",
            { toolClass },
          );
        }
      }
      try {
        return await run();
      } finally {
        // At most once: a claimed approval is spent whatever the call's outcome.
        if (claimed && request.approvalId !== undefined && deps.approvals !== undefined) {
          await deps.approvals.finish(scope, request.approvalId, deps.now());
        }
      }
    },
  };
}
