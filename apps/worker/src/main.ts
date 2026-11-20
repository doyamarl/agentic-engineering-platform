// Worker: owns its database connection and health endpoint so Compose can supervise it, and runs
// the durable job loop (PostgresJobQueue + runWorker, ADR-003) when mission execution
// (execution.ts) or chat replies (chat.ts) are configured.
import { randomUUID } from "node:crypto";
import { runWorker } from "@aep/application";
import {
  connectDatabase,
  PostgresJobQueue,
  PostgresMissionRepository,
  PostgresTenantSettings,
  PostgresThreadRepository,
} from "@aep/postgres";
import { chatHandlers, chatModel } from "./chat.ts";
import { codeSetup, codeToolsFor } from "./code.ts";
import { connectorGatewayFor, connectorHandlers, connectorSetup } from "./connections.ts";
import { executionSetup } from "./execution.ts";
import { startHealthServer } from "./health.ts";

// Checked first: a model endpoint off the allowlist (PRD FR-15), an invalid connector manifest or
// a missing master key (ADR-013), or a manifest taking the code tools' id stops the worker here.
let model: ReturnType<typeof chatModel>;
let connectors: Awaited<ReturnType<typeof connectorSetup>>;
let code: ReturnType<typeof codeSetup>;
try {
  model = chatModel(process.env);
  connectors = await connectorSetup(process.env);
  code = codeSetup(process.env, connectors?.catalog);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("missing required environment variable DATABASE_URL");
  process.exit(1);
}

const log = (entry: object) => {
  console.log(JSON.stringify(entry));
};
const db = connectDatabase(databaseUrl, {
  max: 4,
  // A lost idle connection is replaced; jobs in flight fail and are retried (ADR-003).
  onError: (error) => {
    log({ msg: "database connection lost", error: error.message });
  },
});
const health = await startHealthServer(db, {
  port: Number(process.env["HEALTH_PORT"] ?? "8081"),
  host: process.env["HOST"] ?? "0.0.0.0",
});
log({ msg: "worker started", health: health.url });

const stop = new AbortController();
const queue = new PostgresJobQueue(db);
const setup = executionSetup(process.env, new PostgresMissionRepository(db), queue);
const tools =
  connectors === undefined ? undefined : connectorGatewayFor(connectors, db, process.env);
const chat =
  "missing" in model
    ? undefined
    : chatHandlers(
        model,
        new PostgresThreadRepository(db),
        new PostgresTenantSettings(db),
        tools,
        code === undefined ? undefined : codeToolsFor(code, db),
      );
const connectorJobs =
  connectors === undefined ? undefined : connectorHandlers(connectors, db, process.env);
const handlers = {
  ...(setup.enabled ? setup.handlers : {}),
  ...chat?.handlers,
  ...connectorJobs?.handlers,
};
const onDead = {
  ...(setup.enabled ? setup.onDead : {}),
  ...chat?.onDead,
  ...connectorJobs?.onDead,
};
const loop =
  Object.keys(handlers).length > 0
    ? runWorker({
        queue,
        handlers,
        onDead,
        workerId: `worker-${randomUUID()}`,
        leaseMs: 60_000,
        pollMs: 2_000,
        signal: stop.signal,
        log,
      })
    : Promise.resolve();
log(
  setup.enabled
    ? { msg: "mission execution enabled", kinds: Object.keys(setup.handlers) }
    : { msg: "mission execution disabled", missing: setup.missing },
);
log(
  connectors === undefined
    ? { msg: "connectors disabled" }
    : { msg: "connectors enabled", connectors: connectors.catalog.manifests.map((m) => m.id) },
);
log(code === undefined ? { msg: "code tools disabled" } : { msg: "code tools enabled" });
log(
  "missing" in model
    ? { msg: "chat replies disabled", missing: model.missing }
    : { msg: "chat replies enabled", provider: model.provider, model: model.model },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stop.abort();
    void loop.then(() => health.close()).then(() => db.destroy());
  });
}
