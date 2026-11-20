import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sql, type Kysely } from "kysely";

export type HealthServer = { readonly url: string; close(): Promise<void> };

/** Serves GET /healthz: 200 when the database answers `select 1`, 503 otherwise. */
export function startHealthServer<DB>(
  db: Kysely<DB>,
  options: { port: number; host?: string },
): Promise<HealthServer> {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/healthz") {
      response.writeHead(404).end();
      return;
    }
    sql`select 1`
      .execute(db)
      .then(
        () => [200, "ok"] as const,
        () => [503, "unavailable"] as const,
      )
      .then(
        ([status, body]) => {
          response
            .writeHead(status, { "content-type": "application/json" })
            .end(JSON.stringify({ status: body }));
        },
        () => response.writeHead(500).end(),
      );
  });

  return new Promise((resolve) => {
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        close: () =>
          new Promise((done) =>
            server.close(() => {
              done();
            }),
          ),
      });
    });
  });
}
