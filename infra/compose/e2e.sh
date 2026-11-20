#!/usr/bin/env bash
# Browser tests (tools/e2e) against the Compose stack: boots it, bootstraps tenants A and B,
# prepares accounts (each tenant's admin, a viewer and an engineer in A with a known password,
# and a newcomer in A who still has the admin-issued one) and tenant A's missions, then runs
# Playwright against the web UI, where every test logs in. The Compose worker has no agent
# credentials, so the states an agent would reach (a plan awaiting approval, an acceptance packet)
# are written to the database directly.
# compose.e2e.yaml adds an OIDC provider and turns on OIDC login next to passwords, and points
# the connectors (compose.connectors.yaml) at the mock MCP server. After Playwright passes, the
# platform's container logs are checked for the tokens the mock server issued (PRD scenario H).
# Leaves the stack running; `docker compose -f compose.yaml -f compose.e2e.yaml down -v` cleans up.
set -euo pipefail
cd "$(dirname "$0")"
export COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}:compose.connectors.yaml:compose.e2e.yaml"
# The mock provider accepts any client secret; the API still reads one from a file.
export AEP_E2E_OIDC_CLIENT_SECRET="${AEP_E2E_OIDC_CLIENT_SECRET:-e2e-mock-provider-accepts-any}"

field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }

source ./access-token-secret.sh
# A throwaway key: the e2e connections are to the mock server and need not survive the run.
export AEP_MASTER_KEY="${AEP_MASTER_KEY:-$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))')}"
docker compose up -d --build --wait

# Unique per run, so the script also works against a stack left from an earlier run.
run=$(date +%s%N)
password="e2e-password-$run"
bootstrap() { docker compose run --rm -q migrate node apps/api/src/cli/bootstrap.ts --tenant "$1" --email "$2" 2>/dev/null; }
tenant_a=$(bootstrap "E2E A" "admin-a-$run@example.com")
tenant_b=$(bootstrap "E2E B" "admin-b-$run@example.com")
token_a=$(field token <<<"$tenant_a")
workspace_a=$(field workspaceId <<<"$tenant_a")

# Calls the API from inside the api container (the host's port 3000 may belong to something
# else) and prints the JSON body. Usage: api METHOD PATH [TOKEN] [BODY]
api() {
  docker compose exec -T -e METHOD="$1" -e URL_PATH="$2" -e TOKEN="${3:-}" -e BODY="${4:-}" api \
    node --input-type=module -e '
    const { METHOD, URL_PATH, TOKEN, BODY } = process.env;
    const r = await fetch(`http://127.0.0.1:3000${URL_PATH}`, {
      method: METHOD,
      headers: {
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(BODY ? { "content-type": "application/json" } : {}),
      },
      ...(BODY ? { body: BODY } : {}),
    });
    if (!r.ok) { console.error(METHOD, URL_PATH, r.status); process.exit(1); }
    console.log(r.status === 204 ? "{}" : await r.text());
  '
}
json() { node -e 'console.log(JSON.stringify(Object.fromEntries(process.argv.slice(1).map(a => a.split("=")))))' "$@"; }

# Logs in with the issued password and replaces it with the known test password.
set_password() {
  local access
  access=$(api POST /v1/auth/login "" "$(json "email=$1" "password=$2")" | field accessToken)
  api POST /v1/auth/password "$access" "$(json "currentPassword=$2" "newPassword=$password")" >/dev/null
}
set_password "admin-a-$run@example.com" "$(field initialPassword <<<"$tenant_a")"
set_password "admin-b-$run@example.com" "$(field initialPassword <<<"$tenant_b")"

member() { api POST /v1/members "$token_a" "$(json "displayName=$1" "email=$2" "role=$3")"; }
viewer=$(member "E2E viewer" "viewer-a-$run@example.com" viewer)
set_password "viewer-a-$run@example.com" "$(field initialPassword <<<"$viewer")"
engineer=$(member "E2E engineer" "engineer-a-$run@example.com" engineer)
set_password "engineer-a-$run@example.com" "$(field initialPassword <<<"$engineer")"
newcomer=$(member "E2E newcomer" "newcomer-a-$run@example.com" engineer)

# Creates a mission as tenant A through the API and prints its id.
mission() {
  api POST /v1/missions "$token_a" "$(node -e 'console.log(JSON.stringify({ workspaceId: process.argv[1], title: process.argv[2],
    source: { kind: "github_issue", owner: "acme", repo: "shop", issueNumber: 7, baseBranch: "main" } }))' \
    "$workspace_a" "$1")" | field id
}

sql() { docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U postgres -d aep "$@"; }

# The mock MCP server keeps its client registrations in memory and starts empty whenever the stack
# is rebuilt; forget the platform's registrations with it, so a rerun registers again.
sql -c 'truncate connector_clients'

# Stores plan version 1 and moves the mission to AWAITING_PLAN_APPROVAL, as mission.plan would.
submit_plan() {
  sql -v mission="$1" -v body="$2" <<'SQL'
begin;
insert into plans (tenant_id, mission_id, version, body, checksum_sha256, author_kind, author_id)
  select tenant_id, id, 1, :'body', encode(sha256(convert_to(:'body', 'UTF8')), 'hex'), 'agent', 'e2e'
  from missions where id = :'mission';
update missions set status = 'AWAITING_PLAN_APPROVAL',
  state = '{"status":"AWAITING_PLAN_APPROVAL","planVersion":1}', version = version + 1
  where id = :'mission';
commit;
SQL
}

# Stores acceptance packet version 1 and moves the mission to ACCEPTANCE_READY.
accept() {
  local content
  content=$(node -e '
    const [id, pr, check] = process.argv.slice(1);
    console.log(JSON.stringify({
      schemaVersion: 1,
      mission: { id, title: "packet" },
      source: { kind: "github_issue", owner: "acme", repo: "shop", issueNumber: 7, baseBranch: "main" },
      plan: { version: 1, checksumSha256: "0".repeat(64),
        acceptanceCriteria: "- node --test passes", risks: null },
      approvals: [],
      pullRequest: { number: 9, url: pr, branch: `aep/${id}`, commitSha: "c".repeat(40) },
      diff: { files: [{ path: "src/truncate.js", additions: 10, deletions: 0 }],
        additions: 10, deletions: 0, truncated: false },
      ci: { state: "success", checks: [{ name: "evil-check", state: "success", url: check }] },
      costUsd: 0.101728,
      residualRisks: ["The plan acceptance criteria have not been checked automatically."],
    }));' "$1" "$2" "$3")
  sql -v mission="$1" -v content="$content" <<'SQL'
begin;
insert into acceptance_packets (tenant_id, mission_id, version, content, checksum_sha256)
  select tenant_id, id, 1, :'content', encode(sha256(convert_to(:'content', 'UTF8')), 'hex')
  from missions where id = :'mission';
update missions set status = 'ACCEPTANCE_READY',
  state = '{"status":"ACCEPTANCE_READY","approvedPlanVersion":1,"packetVersion":1}',
  version = version + 1
  where id = :'mission';
commit;
SQL
}

PLAN=$'## Summary\nAdd truncate.\n\n## Acceptance criteria\n- node --test passes\n\n## Risks and assumptions\n- none'
approve=$(mission "E2E awaiting approval")
submit_plan "$approve" "$PLAN"
reject=$(mission "E2E awaiting rejection")
submit_plan "$reject" "$PLAN"
viewed=$(mission "E2E viewer view")
submit_plan "$viewed" "$PLAN"
accepted=$(mission "E2E accepted")
submit_plan "$accepted" "$PLAN"
accept "$accepted" "https://github.com/acme/shop/pull/9" "https://github.com/acme/shop/actions/runs/1"
hostile=$(mission '<img src=x onerror="window.__xss=1">E2E hostile')
submit_plan "$hostile" $'## Summary\n<script>alert(\'plan\')</script><img src=x onerror="window.__xss=2">\n[click](javascript:alert(3))'
accept "$hostile" "javascript:alert(4)" "javascript:alert(5)"
draft=$(mission "E2E draft")

docker compose up -d --wait web

cd ../..
E2E_PASSWORD=$password \
E2E_ADMIN_A=admin-a-$run@example.com E2E_ADMIN_B=admin-b-$run@example.com \
E2E_VIEWER_A=viewer-a-$run@example.com E2E_ENGINEER_A=engineer-a-$run@example.com \
E2E_NEWCOMER_A=newcomer-a-$run@example.com E2E_NEWCOMER_PASSWORD="$(field initialPassword <<<"$newcomer")" \
E2E_MISSION_APPROVE=$approve E2E_MISSION_REJECT=$reject E2E_MISSION_ACCEPTED=$accepted \
E2E_MISSION_HOSTILE=$hostile E2E_MISSION_DRAFT=$draft E2E_MISSION_VIEWED=$viewed \
  pnpm --filter @aep/e2e exec playwright test "$@"


infra/compose/scan-token-leaks.sh
