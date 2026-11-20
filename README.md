# Agentic Software Engineering Platform

A self-hosted, agent-agnostic software delivery platform. A person shapes an initiative with an AI in a chat thread, turns it into a GitHub Issue, and a coding agent implements it as a reviewed PR.

Status: Sprints 1–4 (missions, approvals, accounts and login) are done; the chat and connector work of PRD v0.2 is in progress. See the [roadmap](docs/03_ROADMAP.md).

## Documentation

| Document                                              | Contents                                                |
| ----------------------------------------------------- | ------------------------------------------------------- |
| [01_PRD.md](docs/01_PRD.md)                           | Vision, KPIs, personas, scope per release               |
| [02_ARCHITECTURE_ADR.md](docs/02_ARCHITECTURE_ADR.md) | Architecture and technology decisions (ADRs)            |
| [03_ROADMAP.md](docs/03_ROADMAP.md)                   | Plan from MVP to OSS v1.0                               |
| [04_AGENT_BENCHMARK.md](docs/04_AGENT_BENCHMARK.md)   | Go/no-go benchmark for the first agent adapter (Claude) |

## Quick start (Docker Compose)

Requires Docker and Docker Compose v2. This setup is for trusted local users (T0 in ADR §7) and binds ports to `127.0.0.1` only.

```bash
# Access-token signing key (at least 32 bytes). First run only.
echo "AEP_ACCESS_TOKEN_SECRET=$(openssl rand -base64 48)" >> infra/compose/.env

docker compose -f infra/compose/compose.yaml up -d --build --wait

# Create a tenant, workspace and admin. Prints the admin's API token and initial password once.
docker compose -f infra/compose/compose.yaml run --rm migrate \
  node apps/api/src/cli/bootstrap.ts --tenant Demo --workspace Growth --admin Operator \
  --email admin@example.com
```

Open http://127.0.0.1:3001 and log in with the `email` and `initialPassword` from the bootstrap output. You are asked to change the password first.

| Service | URL                   | Purpose                                                       |
| ------- | --------------------- | ------------------------------------------------------------- |
| api     | http://127.0.0.1:3000 | REST API under `/v1`, `/healthz`                              |
| web     | http://127.0.0.1:3001 | Web UI                                                        |
| worker  | not exposed           | Mission planning and execution, chat replies, connector calls |

To change the local database passwords, copy `infra/compose/.env.example` to `infra/compose/.env` and edit it.

### Using the API

Scripts can call the API with the token from the bootstrap output:

```bash
TOKEN=aep_...        # token from the bootstrap output
WORKSPACE=...        # workspaceId from the bootstrap output
curl -s -X POST http://127.0.0.1:3000/v1/missions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WORKSPACE\",\"title\":\"Improve signup conversion\"}"
curl -s http://127.0.0.1:3000/v1/missions -H "authorization: Bearer $TOKEN"
```

## Features and configuration

### Missions

A mission is created from a GitHub Issue in a workspace. Its detail page shows the state, the plan, approve/reject actions, an event feed that refreshes every few seconds, the acceptance summary and a cancel action. Buttons for actions the user's role does not allow are hidden.

Planning and execution need the worker's agent settings. The variables are read in `apps/worker/src/execution.ts`: `AEP_GITHUB_APP_ID`, `AEP_GITHUB_PRIVATE_KEY_PATH`, `AEP_CLAUDE_MODEL`, `AEP_SANDBOX_IMAGE`, `AEP_WORK_ROOT`, and budget, time and network limits (`AEP_AGENT_*`, `AEP_VERIFY_*`).

### Chat threads

The worker answers thread messages with `AEP_CHAT_MODEL` when `ANTHROPIC_API_KEY` is set in `infra/compose/.env`. Without a key, replies stay off. `AEP_MODEL_PROVIDER=fake` echoes each message back, for demos without a key.

### Accounts and login (ADR-011)

Password login is on when the API gets `AEP_AUTH_METHODS=password` and `AEP_ACCESS_TOKEN_SECRET_FILE`. Compose turns it on and passes the key from `AEP_ACCESS_TOKEN_SECRET` in `.env`.

Admins manage members in the web UI (`/admin/members`) or via `/v1/members`: add a member (the initial password is shown once), change roles, deactivate, and reissue passwords. These changes and login results appear in the audit log (`/admin/audit`, `/v1/audit-events`).

To log in through a company IdP (OIDC), add `oidc` to `AEP_AUTH_METHODS` and set:

| Variable                      | Value                                                                    |
| ----------------------------- | ------------------------------------------------------------------------ |
| `AEP_OIDC_ISSUER`             | Issuer URL                                                               |
| `AEP_OIDC_CLIENT_ID`          | Client ID                                                                |
| `AEP_OIDC_CLIENT_SECRET_FILE` | Path to the client secret                                                |
| `AEP_OIDC_REDIRECT_URI`       | The web app's `/login/oidc/callback`; register the same value at the IdP |
| `AEP_OIDC_NAME`               | Display name on the login page                                           |

Only members an admin has added can log in. They are matched by an email address the IdP returns with `email_verified: true`.

The web app keeps the session in an HttpOnly cookie. Compose serves plain HTTP on `127.0.0.1`, so it sets `AEP_SECURE_COOKIES=false`. Remove that setting when running behind TLS.

### Connectors (ADR-013)

Connectors to external tools are off by default. To turn them on, add to `infra/compose/.env`:

```bash
COMPOSE_FILE=compose.yaml:compose.connectors.yaml
AEP_MASTER_KEY=...   # output of: openssl rand -base64 32
```

The worker encrypts connection tokens with `AEP_MASTER_KEY` before storing them in the database. If the key is lost, every member has to reconnect, so keep a copy somewhere other than the database backups.

Each member connects their own account under `/connections`. Admins see connection status and can force a disconnect under `/admin/connections`. The default redirect URI is `http://127.0.0.1:3001/connections/oauth/callback`; set `AEP_CONNECTOR_REDIRECT_URI` when serving from another address.

## Testing

| Command                  | What it runs                                                             |
| ------------------------ | ------------------------------------------------------------------------ |
| `pnpm verify`            | Format, lint, typecheck, dependency-boundary check, unit tests           |
| `infra/compose/smoke.sh` | Starts the stack and checks it end to end, through tenant isolation (CI) |
| `infra/compose/e2e.sh`   | Playwright browser tests in `tools/e2e` (CI)                             |

`e2e.sh` starts the stack, seeds tenants A and B (admins for both; a viewer, an engineer and a member still on the initial password for A) and a mission in A, then covers:

- the main UI flows
- login: first password change, logout, role-based buttons
- connecting to and disconnecting from a mock MCP server (`tools/mock-mcp`)
- security regressions: tenant isolation, HTML injection, link schemes, framing, cross-site form posts, cookie and token exposure

Before the first run, install the browser with `pnpm --filter @aep/e2e exec playwright install chromium`.

## Development

Node 24 and pnpm 10 are pinned in `mise.toml` and installed with [mise](https://mise.jdx.dev/).

```bash
mise install
pnpm install
pnpm verify
```

The tests in `adapters/persistence/postgres` start PostgreSQL 18 with Testcontainers, so they need Docker.

Module boundary rules live in `.dependency-cruiser.cjs`. `architecture/dependency-rules.test.ts` checks that each rule catches a violating fixture.

## License

[Apache License 2.0](LICENSE)
