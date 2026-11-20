# Delivery Roadmap — Fast MVP to OSS v1.0
Version: 0.2 | 2026-11-15 | 1–2 builders using Claude and Codex

Status: Day 0 and Sprints 1–3 are done (handoff #31), and Sprint 4, accounts and login, is done too (#33, handoff #40). PRD v0.2 (2026-11-15) moves the centre from Issue-to-PR to the initiative loop; the plan for v0.2 is §1a. Sections 2–7 are kept as the record of the v0.1 plan.

## 1a. v0.2 plan (chat → Issue → existing engine)
Before Sprint 5: decide how UI/UX design is done for the chat screen (who decides, whether to set a small design baseline first). PRD §15 open item.

Sprint 5 — chat foundation
- Threads and messages with owner and visibility; RLS keyed on tenant and user (`app.user_id` next to `app.tenant_id`) (ADR-014).
- Model calls through a `ModelPort` separate from the coding `AgentPort`; endpoint allowlist and key attestation (PRD FR-15); streaming replies to the web (ADR-012).
- Chat screen: personal threads, a minimal share action.
- #31 constraint: workspace list API so screens stop asking for a Workspace ID (#29).
Exit: a member chats with the model in a personal thread another member cannot read; tests prove it at API and database level.

Sprint 6 — connector base
- Connector manifest schema; credential store (AES-256-GCM, instance master key from a file, shared with ADR-007); per-user OAuth for MCP servers; connector gateway that attaches tokens; per-tool allow; audit (ADR-013).
- A mock MCP server shaped like Amplitude's tools for tests and CI; Amplitude manifest; GitHub code read through the existing GitHub App.
Exit: the chat reads a mock funnel through a personal connection; the token never leaves the gateway (PRD scenario H); a write-class tool is refused without approval.

Sprint 7 — initiative spec to Issue
- Structured initiative spec (hypothesis, metrics, guardrails, acceptance criteria) drafted from the thread; source labels and the share/Issue confirmation (PRD §9); create the Issue and the mission in the existing engine.
- #31 constraints on this path: approval and execution start in one transaction (#25); failure and rejection reasons hidden from viewers (#26); acceptance criteria matched against the change in the packet (#27).
Exit: thread → Issue → approved plan → PR → acceptance packet, end to end, with Amplitude mocked.

v0.3–v0.5 follow PRD §10.

## 1. Schedule philosophy
Target a **14–28 day thin MVP**, not a 3-month feature-complete platform. AI agents accelerate implementation, not architectural decisions, threat modeling or validation. Enterprise-grade mutually untrusted tenant isolation is a later release gate; never label early Docker Compose deployment as secure public multi-tenant hosting.

## 2. Day 0: decisions and benchmark (0.5–1 day)
- Fix minimum threat model, first supported host OS, repository license proposal and demo repo.
- Run same five small tasks through Claude and Codex; record acceptance, cost, runtime, auth feasibility and API limitations.
- Freeze MVP non-goals and publish ADRs.
Exit: chosen first agent, fallback agent, documented credentials strategy, baseline benchmark.

## 3. Sprint 1: foundations (days 1–4)
- Monorepo, strict TS, lint/format, dependency boundary tests, CI, unit test harness.
- PostgreSQL schema for tenant/workspace/mission/approval/event/artifact, migrations, seeded demo.
- Auth principal and tenant-scoped authorization middleware, negative cross-tenant tests.
- Compose boot with API/Web/worker/DB and health checks.
Exit: a new contributor boots locally and creates a tenant-scoped mission through API; CI blocks forbidden dependencies.

## 4. Sprint 2: isolated execution (days 5–9)
- Docker sandbox with TTL, limits, safe mounts, non-root process and cleanup.
- First AgentPort adapter, stream events, cancellation and timeout.
- GitHub adapter for checkout/worktree, branch and draft PR; ephemeral token handling.
- Durable job/outbox and idempotency keys; worker restart tests.
Exit: sample Issue → isolated agent execution → draft PR with no production credentials.

## 5. Sprint 3: approval and acceptance (days 10–14)
- Plan artifact with immutable versions; PM approval gate; rejection/revision loop.
- CI status ingestion, test evidence, acceptance packet, audit trail.
- Minimal UI: Mission list/detail, live event stream, plan approval, cancel, artifacts.
- Playwright smoke and security regression tests.
Exit: complete local demo from mission to acceptance-ready PR; forbidden cross-tenant access blocked.

## 6. Optional hardening sprint (days 15–21)
- Second agent adapter with capability negotiation and auth-mode checks.
- Independent QA run; retry/backoff/dead-letter; observability/cost dashboard.
- Basic Growth workflow pack: PM brief → structured spec → approved implementation.
- Public quickstart, sample app, contribution guide, SECURITY.md, threat model and dependency/license audit.
Exit: external contributor can reproduce demo without company secrets.

## 7. Stretch sprint (days 22–28)
- Read-only funnel connector with mock/demo dataset; competitor change detector using permitted public pages.
- Agent evaluation harness across representative UI, feature, analytics, experiment tasks.
- OSS beta release with known limitations and migration guidance.
Exit: 10–20 benchmark missions evaluated with categorized failure analysis; public beta ready if security gates pass.

## 8. Parallel AI-assisted development workflow
Human owns architecture, security policy, acceptance criteria and final merges. Claude and Codex work on independent branches/worktrees with narrowly scoped tickets. For each ticket: human writes behavior/contract → agent writes failing tests → agent implements → second agent reviews adversarially → CI runs → human merges. Avoid two agents editing the same files simultaneously. Each PR includes ADR impact, tests, threat impact, migration impact and screenshots/log evidence when relevant.

Recommended parallel lanes:
Lane A: domain, persistence, auth and policy.
Lane B: sandbox, agent adapters and GitHub integration.
Lane C (when capacity permits): UI, acceptance and documentation.
Synchronize on typed contracts and merge at least daily to prevent integration drift.

## 9. Milestones and metrics
M0 (day 1): decision log + passing baseline CI.
M1 (day 4): tenant-safe mission CRUD, Compose quickstart.
M2 (day 9): isolated issue-to-draft-PR path.
M3 (day 14): approval + acceptance packet end-to-end.
M4 (day 21): two adapters + reproducible OSS quickstart (conditional).
M5 (day 28): beta and evaluation report (conditional).

Minimum release gates: zero known critical/high exploitable vulnerabilities, no hard-coded secrets, cross-tenant tests green, no direct production release permission, cancel/timeout/restart exercised, clean-install demo reproducible, documented unsupported auth modes. Target 80% of chosen smoke tasks to produce a valid draft PR for early engineering evaluation, not as a universal benchmark.

## 10. v0.2 → v1.0 backlog (priority order; superseded for v0.2–v0.5 by PRD §10 and §1a)
P0: robust QA/acceptance, provider portability, tenant isolation audit, provider auth and credential lifecycle.
P1: Growth discovery, funnel semantic layer, experiment/feature flag adapters, reusable workflow packs.
P1: external OIDC/SSO, VM/microVM runner, secret manager, quotas, backups and disaster recovery.
P2: Temporal adapter, Kubernetes runner, visual workflow editor, community plugin registry, Go/Rust optimization where measured.

## 11. Risks and mitigation
- Scope inflation: hold v0.1 to issue-to-PR plus approval; move discovery/experimentation to v0.2+.
- Multi-tenant security: distinguish T1 internal multi-user from T2 hostile SaaS tenants; no premature safety claims. The primary deployment is one organization per instance (ADR-015), so T1 is the target; T2 is not planned.
- Provider login restrictions: verify current terms and official SDK flows before shipping auth mode.
- AI-generated code quality: mandatory TDD, second-agent review, independent security gates and human merge.
- Long-running instability: durable state, idempotency, cancellation and bounded retries.
- OSS leakage: only synthetic/demo data; scan history and build artifacts before publication.

## 12. Immediate backlog (first 12 tickets)
1. Architecture dependency rule and CI test.
2. Tenant-aware domain schema and migrations.
3. Authentication principal + permission matrix tests.
4. Mission state machine with property tests.
5. Approval version binding and invalidation tests.
6. Durable jobs/outbox and idempotency.
7. SandboxPort and Docker implementation.
8. AgentPort and first adapter with contract tests.
9. GitHub checkout/branch/draft PR integration.
10. Event stream + audit + redaction.
11. Acceptance packet + CI evidence ingestion.
12. Minimal mission UI and Playwright smoke.

## 13. Outstanding decisions requiring owner input
- UI/UX design approach for the v0.2 chat screen (2026-11-15).
- Where non-repository context lives (v0.3).
- ADR-007: whose personal key runs a mission, whether a tenant may forbid the instance key, cost per key owner.
- ~~First agent~~ — Claude (2026-11-13), confirmed by the benchmark the same day (docs/benchmarks/2026-11-agent-selection.md). Credentials: API key only.
- ~~Target tenants at launch~~ — internal, mutually trusted (T1) (2026-11-13).
- GitHub-only first release versus GitLab demand.
- OSS name, repo ownership, contribution and security disclosure policy. (License: Apache-2.0, decided 2026-11-13.)
- Availability of real anonymized Growth missions. Analytics, monitoring and deploy integrations: connectors are generic and infrastructure stays the user's (PRD v0.2, 2026-11-15).
