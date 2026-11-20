# PRD — Agentic Growth Engineering Platform
Version: 0.2 | 2026-11-15 | Status: accepted by the owner (Japanese working draft: `docs/drafts/01_PRD_v2_draft.md`, #41)

v0.1 (2026-11-13) put an Issue-to-PR execution engine at the centre and deferred discovery and analysis. v0.2 puts the whole initiative loop at the centre: a person shapes an initiative with an AI in chat, it becomes an Issue, the existing engine implements it, and the same thread follows the release and its effect. The engine built in Sprints 1–4 becomes one stage of that loop.

## 1. Vision
Self-host-first, open-source platform where PM and growth people work out initiatives with an AI that reads the existing code, past initiatives, funnels, feedback, heatmaps and competitors' public pages through connectors to the tools they already use; turn the result into an Issue and a reviewed PR; and watch the release and its effect in the same place. Agent-agnostic, provider-agnostic, and not tied to any one company's stack: connectors and infrastructure are the user's choice.

Principles:
1. Connectors are generic and easy to set up. Any tool can be added; permissions are explained in chat.
2. Security is a precondition. Only models whose terms exclude training on inputs; least-privilege connections; humans approve writes.
3. Tuning is cheap. Skills, documents and agent instructions are managed in one place and evaluated before adoption.

## 2. Outcomes and measurement
Business objective (unchanged from v0.1, not a release criterion): 90% of eligible growth initiatives reach acceptance-ready without human implementation edits.

Primary KPI = accepted-ready missions without manual code changes / all eligible missions started in the period (failures, timeouts and abandonments in the denominator). Also report human-touch minutes, first-pass acceptance, escaped defects, cost per accepted mission, elapsed time, rollbacks per release, and the share of initiatives whose effect was measured. Acceptance-ready is not the same as proven lift.

## 3. Personas
- PM / growth (primary): shape initiatives in chat, look at data, approve Issues, check effect.
- Engineer: review plans and PRs, tune harness and context, intervene in runs.
- Administrator: configure connectors and model keys; manage permissions, budgets, audit.
- Individual user: run it alone with own keys and tools.

## 4. Initiative loop
① consult → ② initiative spec → ③ approval → ④ implementation → ⑤ release → ⑥ watch and measure → ⑦ learn (feeds the next ①).

| Stage | What happens | Exists today |
|---|---|---|
| ① Consult | Chat about the goal. The AI gathers code, past initiatives, funnels, feedback, heatmaps and competitor pages; hypotheses and alternatives are refined together | No |
| ② Spec | Hypothesis, metrics, guardrail metrics with thresholds, acceptance criteria and measurement plan, structured into an Issue | No (Issues are input only) |
| ③ Approval | Version-bound approval | Yes |
| ④ Implementation | Isolated agent run, PR, acceptance packet | Yes (Sprints 2–3) |
| ⑤ Release | People merge and release; agents never hold production deploy credentials | No |
| ⑥ Watch and measure | Watch guardrails right after release; on an anomaly, propose a rollback that people approve. Later compare the ① metrics (treatment vs control when shipped as an A/B test, else before vs after) | No |
| ⑦ Learn | Record result and lessons on the initiative, including why a rollback happened | No |

## 5. Pillar A — connectors
- MCP is the standard. Official remote MCP servers exist for Amplitude, Atlassian, Slack, Google Workspace (preview), Sentry and Datadog (checked 2026-11-15). Local MCP servers (e.g. Grafana's `mcp-grafana`) run as containers the platform manages. Users can register any MCP server URL. Direct API adapters only where MCP is insufficient.
- A connector is a declarative manifest: server URL or image, auth method, allowed tools, each tool's read/write class, egress hosts, and a source URL for each claim. The connection UI is generated from the manifest from shared components (connect button, per-tool toggles, write-approval setting).
- Read-only by default; tools allowed one by one; write, delete and send tools need human approval on every call. Content read through connectors is untrusted data and cannot call write tools by itself.
- Credentials (ADR-013): personal connections per tenant × user × connector are the default; tenant connections exist for unattended work. OAuth tokens or admin-allowed static keys, encrypted at rest, never returned by the API, never given to agents or models: a connector gateway attaches them when it calls the MCP server. Disabling a user deletes and revokes their tokens; admins see who is connected (not values) and can force-disconnect; every tool call is audited with the connection used.
- Adding a connector from chat (v0.3): the AI researches the service, writes the manifest (and, without MCP, an adapter for the shared interface), and opens a PR against this platform's repository through the existing engine. Two skills: research-and-manifest, implement-with-the-interface. CI runs the interface contract tests and checks egress against the manifest. People merge and deploy; never automatic. The interface is extracted after two hand-built connectors (Amplitude, GitHub).

## 6. Pillar B — model keys and data
Only APIs whose terms exclude training on customer content: Anthropic API (Commercial Terms) and OpenAI API (no training by default; zero data retention for eligible orgs), including Bedrock and Vertex AI routes. Consumer-account login is not used (ADR-009). Whether an API key's org settings can be verified is unknown, so enforcement combines an endpoint allowlist, an admin attestation of contract type and retention (audited), and no consumer login. Key ownership follows ADR-007.

## 7. Pillar C — harness and context
Skills, documents, agent instructions (`AGENTS.md`, `CLAUDE.md`), prompt parts and evaluation sets, layered org → workspace → repository → initiative (lower overrides higher; the effective layers are recorded per run), converted per agent at run time. Repositories are the source of truth: edits made in the platform become PRs. Changes are compared on an evaluation set (`tools/bench`) before adoption. Where non-repository context lives is open (§11).

## 8. Pillar D — watch, rollback, effect
- Monitoring and deployment belong to the user's infrastructure; the platform only reads monitoring through connectors and never builds or drives a deploy system.
- Unattended monitoring uses a tenant connection with a read-only account scoped to the needed metrics and errors, not a person's connection.
- On an anomaly: notify the thread and configured channels; line up onset time, related PR diff and errors as a cause hint.
- Rollback, least impact first, never with production credentials in agents: turn off a feature flag (a flag service, or an app's A/B allocation set to 0%; when allocation lives in code this is a PR); a revert PR; or a deploy rollback that people perform in their own deploy system. Default is a human-approved proposal. Automatic rollback is allowed only for turning off a flag through a flag service API under pre-approved conditions; PRs are never auto-merged.
- Proposals, approvals, executions and results are audited and recorded on the initiative.

## 9. Threads and sharing
Initiative threads are personal by default (only the owner sees them, using the owner's connections). Sharing to chosen members or the whole workspace is explicit. Before sharing, and before turning a thread into an Issue (Issues are visible to everyone with repository access), the platform lists data obtained through personal connections with source and whose permission; default action is to share as-is, items can be excluded. Shared results keep their source label.

## 10. Scope by release
| Release | Scope | Loop stages |
|---|---|---|
| v0.1 (done, Sprints 1–4) | Issue → plan approval → isolated run → PR → CI → acceptance packet; tenants, roles, password/OIDC login, member admin, audit | ③ ④ |
| v0.2 | Chat workspace (personal and shared threads, Issue creation into the engine); MCP connector base (OAuth, encrypted credentials, gateway, read-only, per-tool allow, audit); Amplitude (tested against a mock MCP server) and GitHub code; #31 constraints on this path | ① → ④ |
| v0.3 | Harness/context management and evaluation; connector manifests and the two skills; Confluence, Slack, Google Workspace added with the skills; competitor public-page diff | ① deeper, A, C |
| v0.4 | Watching through monitoring connectors, alerts, cause hints; rollback by revert or allocation PR; effect check; learning | ⑤ → ⑦ |
| v0.5 | Flag-service rollback by API and pre-approved automatic rollback, once a user needs it | ⑥ deeper |
| v1.0 | Production hardening (HA, backup/recovery, RBAC, isolation assessment, stable plugin contracts) | |

First end-to-end story: shape an initiative while looking at an Amplitude funnel → Issue → PR → watch error rate and latency after release → measure the same funnel.

## 11. Non-goals
Autonomous production releases; agents holding production credentials; automatic rollback outside pre-approved conditions; fetching pages behind logins or against site terms; models that train on inputs or consumer-account login; write/delete/send tools without human approval; a shared all-access company key for chat (shared connections are scoped, read-only, for unattended work); auto-merge or auto-deploy of connector PRs; building monitoring or deploy systems; a visual workflow editor; hosted SaaS billing; a custom coding model.

## 12. Functional requirements
FR-01 Mission records immutable approved specification versions and references to source evidence.
FR-02 Workflow steps are typed, idempotent where feasible, retryable and resumable after worker restart.
FR-03 Agent adapters report capabilities; unsupported features are rejected explicitly.
FR-04 Sandbox lifecycle has TTL, CPU/memory limits, outbound network restrictions and cleanup.
FR-05 Every artifact carries tenant, mission, provenance, checksum, creation time and access policy.
FR-06 Acceptance packet includes requirements mapping, tests, CI status, diff, residual risks and manual approval history.
FR-07 Approval is version-bound; changed requirements or diff invalidate prior approval where relevant.
FR-08 Cancellation prevents further tool actions and revokes short-lived credentials.
FR-09 Agent cannot directly bypass release policy or modify its own effective permissions.
FR-10 UI and CLI use the same versioned API.
FR-11 Threads have an owner and a visibility; a thread is readable only by its owner and the members it is shared with, enforced in the database as well as the API.
FR-12 Every connector call records tenant, user, connection, tool, read/write class and outcome; write-class calls require a recorded human approval.
FR-13 Connector credentials are encrypted at rest, never returned by the API and never placed in agent sandboxes or model context.
FR-14 Data from personal connections carries a source label; sharing a thread or creating an Issue lists it for confirmation first.
FR-15 Model endpoints are restricted to an allowlist of no-training APIs; registering a key records the admin's attestation.
FR-16 A connector manifest is validated against a schema; calls outside its allowed tools or egress hosts are refused.

## 13. Nonfunctional requirements
Security: deny-by-default authorization; tenant isolation; no shared cross-tenant secrets or workspaces; encrypted secrets; least privilege; audit every privileged action. Reliability: restart recovery, bounded retries, at-least-once delivery with deduplication. Maintainability: strict contracts, module boundaries, migration discipline, TDD, dependency tests. Portability: single-command local install, no mandatory cloud or paid services (connectors optional; tests use mocks). Observability: correlated mission/step/session traces, redacted logs, cost and token metrics. Accessibility: keyboard-navigable chat, approval and execution UI.

## 14. Acceptance scenarios
A. Tenant A cannot read Tenant B mission by guessed ID, search, websocket or artifact URL.
B. A plan approved at version 2 cannot authorize version 3 execution.
C. Worker dies mid-run; mission recovers or fails explicitly, never silently duplicates a PR.
D. Agent attempts forbidden network call or secret read; sandbox/policy blocks and audits it.
E. Unit, contract, integration and E2E tests pass; independent acceptance report links evidence.
F. Local install works without paid cloud services.
G. Member B of the same tenant cannot read member A's personal thread by ID, list, stream or export.
H. A connector token never appears in API responses, logs, agent sandboxes or model requests.
I. Text read through a connector that asks to call a write tool does not cause a write without human approval.
J. Sharing a thread with personal-connection data shows the source list before it becomes visible to others.

## 15. Decision log
- License: Apache-2.0 (2026-11-13, ADR-008).
- Identity: API tokens (Sprint 1), then password and OIDC login for people (2026-11-14, ADR-011).
- First agent: Claude (2026-11-13, ADR-009); Codex the fallback.
- Launch tenant trust: T1, internal and mutually trusted (2026-11-13).
- 2026-11-15, owner (#41): self-host first; own chat UI (ADR-012); personal connections by default, tenant connections available (ADR-013); repositories are the source of truth for context; post-release watching and rollback in scope; threads personal by default, share-as-is after a source list (ADR-014); first connectors Amplitude and GitHub, Amplitude tested with a mock MCP server; #31 constraints on the chat-to-implementation path handled alongside v0.2; monitoring and deploy left to the user's infrastructure; automatic rollback only by turning off a flag under pre-approved conditions; an app's A/B allocation counts as a flag (a PR when it lives in code).
- 2026-11-15, owner: one organization per instance is the primary deployment, with the organization's own infrastructure and keys; the tenant boundary stays in the code (ADR-015).
- Open: UI/UX design approach before or with the v0.2 chat screen; where non-repository context lives (v0.3); ADR-007's remaining two questions; GitHub only or GitLab too.
