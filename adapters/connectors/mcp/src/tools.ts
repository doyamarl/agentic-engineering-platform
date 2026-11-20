import { McpUnauthorizedError, type McpToolInfo, type McpTools } from "@aep/application";
import type { ConnectorManifest, ConnectorServer } from "@aep/domain";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { guardedFetch, type McpOAuthOptions } from "./oauth.ts";

// Tool calls to an MCP server as one person (ADR-013), over Streamable HTTP with the MCP
// TypeScript SDK v2. Each operation opens a session, does its work and closes it: the gateway runs
// in short jobs, so there is no session to keep. Requests go through guardedFetch (the manifest's
// egress hosts, no redirects). The access token is sent as a bearer token and nowhere else.

const CLIENT_INFO = { name: "agentic-engineering-platform", version: "0.2.0" };
/** A server that pages its tool list forever must not keep a reply waiting. */
const MAX_PAGES = 10;

async function session<T>(
  manifest: ConnectorManifest,
  server: ConnectorServer,
  accessToken: string,
  options: McpOAuthOptions,
  signal: AbortSignal,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: guardedFetch(manifest, options),
    // No onUnauthorized: a 401 throws UnauthorizedError, which the gateway answers by refreshing.
    authProvider: { token: () => Promise.resolve(accessToken) },
  });
  try {
    await client.connect(transport, { signal });
    return await work(client);
  } catch (error) {
    if (UnauthorizedError.isInstance(error)) throw new McpUnauthorizedError(manifest.id);
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

type Content = { readonly type: string; readonly text?: unknown };

/** The text of a tool result; other kinds of content are named, not passed on. */
function textOf(content: readonly Content[]): string {
  return content
    .map((block) =>
      block.type === "text" && typeof block.text === "string"
        ? block.text
        : `[${block.type} content omitted]`,
    )
    .join("\n");
}

export function mcpTools(options: McpOAuthOptions): McpTools {
  return {
    list(manifest, server, accessToken, signal) {
      return session(manifest, server, accessToken, options, signal, async (client) => {
        const tools: McpToolInfo[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = await client.listTools(cursor === undefined ? {} : { cursor }, {
            signal,
          });
          for (const tool of result.tools) {
            // JSON values as the server sent them; the model provider validates the schema.
            const schema = JSON.parse(JSON.stringify(tool.inputSchema)) as Record<string, unknown>;
            tools.push({
              name: tool.name,
              description: tool.description ?? "",
              inputSchema: { ...schema, type: "object" },
            });
          }
          cursor = result.nextCursor;
          if (cursor === undefined) break;
        }
        return tools;
      });
    },

    call(manifest, server, accessToken, call, signal) {
      return session(manifest, server, accessToken, options, signal, async (client) => {
        const result = await client.callTool(
          {
            name: call.name,
            arguments:
              typeof call.input === "object" && call.input !== null && !Array.isArray(call.input)
                ? (call.input as Record<string, unknown>)
                : {},
          },
          { signal },
        );
        const content = Array.isArray(result.content) ? (result.content as Content[]) : [];
        return { text: textOf(content), isError: result.isError === true };
      });
    },
  };
}
