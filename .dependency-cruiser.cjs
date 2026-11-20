// Module boundary rules from docs/02_ARCHITECTURE_ADR.md §4 and §8.
// architecture/dependency-rules.test.ts proves each rule rejects a violating fixture.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies are forbidden (ADR §8).",
      from: {},
      to: { circular: true },
    },
    {
      name: "domain-is-pure",
      severity: "error",
      comment:
        "Domain may import Node core modules and its own code only. No frameworks, ORM, SDK or Docker clients (ADR §4).",
      from: { path: "^packages/domain/", pathNot: "\\.test\\.ts$" },
      to: { pathNot: "^packages/domain/", dependencyTypesNot: ["core"] },
    },
    {
      name: "application-uses-ports",
      severity: "error",
      comment: "Application depends on ports; adapters and apps implement or call it (ADR §4).",
      from: { path: "^packages/application/", pathNot: "\\.test\\.ts$" },
      to: { path: "^(adapters|apps|workflow-packs)/" },
    },
    {
      name: "web-uses-contracts-only",
      severity: "error",
      comment: "UI depends on public API contracts only (ADR §4).",
      from: { path: "^apps/web/" },
      to: { path: "^(packages/(?!contracts/)|adapters/|workflow-packs/|apps/(?!web/))" },
    },
    {
      name: "adapters-do-not-depend-on-apps",
      severity: "error",
      comment: "Adapters implement ports and must not reach into application entrypoints.",
      from: { path: "^adapters/" },
      to: { path: "^apps/" },
    },
    {
      name: "chat-never-reaches-a-sandbox",
      severity: "error",
      comment:
        "Thread replies, connector tools and code tools run in the worker without a sandbox or a coding agent, so a connector token cannot reach one (PRD scenario H, #52).",
      from: {
        path: "^packages/application/src/(threads|connectors|models|git/code-)",
        pathNot: "\\.test\\.ts$",
      },
      to: { path: "^packages/application/src/(sandboxes|agents)/", reachable: true },
    },
    {
      name: "worker-chat-never-reaches-a-sandbox",
      severity: "error",
      comment:
        "The worker's chat, connector and code-tool wiring imports no sandbox or agent adapter and not the mission execution wiring (PRD scenario H, #52).",
      from: { path: "^apps/worker/src/(chat|connections|code)\\.ts$" },
      to: {
        path: "^(adapters/(sandboxes|agents)/|apps/worker/src/execution\\.ts$)",
        reachable: true,
      },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "Every import must resolve; a missing dependency declaration fails here.",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: "(^|/)(node_modules|dist|coverage|\\.next)/|next-env\\.d\\.ts$|^architecture/fixtures/",
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs"],
    },
  },
};
