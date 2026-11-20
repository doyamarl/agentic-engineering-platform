import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

// Egress proxy for allowlist sandboxes. It runs in its own container, the only one on the sandbox's
// internal network that also has a route out, and lets through HTTP CONNECT tunnels to allowlisted
// host:port pairs only. TLS stays end to end: the proxy sees the host name, never the traffic.
// Plain HTTP requests are refused, so an allowed host cannot be reached without TLS.
//
// This file runs directly under Node's type stripping inside the proxy container, so it may import
// only node: built-ins.

export type EgressProxyOptions = {
  /** Exact host names (lowercase) a tunnel may open to. */
  readonly hosts: readonly string[];
  /** Destination ports a tunnel may open to. */
  readonly ports: readonly number[];
  /** Called once per CONNECT request with the decision; the proxy logs it in the container. */
  readonly onDecision?: (decision: EgressDecision) => void;
};

export type EgressDecision = {
  readonly allowed: boolean;
  readonly authority: string;
};

/** Host and port of a CONNECT target if the allowlist permits it. */
export function allowedTarget(
  authority: string,
  hosts: readonly string[],
  ports: readonly number[],
): { host: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
  // Anything beyond host:port (userinfo, path, query) means the request is not a plain authority.
  if (url.host !== authority.toLowerCase() || url.port === "") return undefined;
  const port = Number(url.port);
  if (!hosts.includes(url.hostname) || !ports.includes(port)) return undefined;
  return { host: url.hostname, port };
}

export function createEgressProxy(options: EgressProxyOptions): Server {
  const server = createServer((_req, res) => {
    res.writeHead(403, { connection: "close" }).end("only CONNECT is allowed\n");
  });
  server.on("connect", (req, client: Socket, head: Buffer) => {
    const authority = req.url ?? "";
    const target = allowedTarget(authority, options.hosts, options.ports);
    options.onDecision?.({ allowed: target !== undefined, authority });
    client.on("error", () => client.destroy());
    if (target === undefined) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = connect(target.port, target.host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      if (client.writable && upstream.bytesRead === 0 && upstream.bytesWritten === 0) {
        client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      } else {
        client.destroy();
      }
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  return server;
}

/** Container entrypoint: configuration comes from the environment the Docker adapter sets. */
function main(): void {
  const hosts = (process.env["AEP_EGRESS_HOSTS"] ?? "").split(",").filter((h) => h !== "");
  const port = Number(process.env["AEP_EGRESS_PORT"] ?? "3128");
  const ttlSec = Number(process.env["AEP_EGRESS_TTL_SEC"] ?? "0");
  const server = createEgressProxy({
    hosts,
    ports: [443],
    onDecision: (d) => {
      process.stderr.write(
        `${JSON.stringify({ egress: d.allowed ? "allow" : "deny", authority: d.authority })}\n`,
      );
    },
  });
  server.listen(port, "0.0.0.0", () => {
    const { port: bound } = server.address() as AddressInfo;
    process.stderr.write(`${JSON.stringify({ listening: bound, hosts })}\n`);
  });
  // Exit with the sandbox's TTL so a crashed control plane does not leave the proxy behind.
  if (ttlSec > 0) setTimeout(() => process.exit(0), ttlSec * 1000);
  process.on("SIGTERM", () => process.exit(0));
}

if (process.env["AEP_EGRESS_PROXY_MAIN"] === "1") main();
