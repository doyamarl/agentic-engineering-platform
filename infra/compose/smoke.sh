#!/usr/bin/env bash
# End-to-end check of the Compose quickstart (docs/03_ROADMAP.md §3 exit criteria):
# boot the stack, bootstrap two tenants, create and read a mission over HTTP, confirm the other
# tenant gets 404 for it, and that password login and the web UI's login wall work. The browser
# tests (e2e.sh) cover the web UI per tenant. Leaves the stack running; `docker compose down -v`
# to clean up.
set -euo pipefail
cd "$(dirname "$0")"

api=${AEP_SMOKE_API:-http://127.0.0.1:3000}
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect() { if [ "$2" != "$3" ]; then echo "FAIL: $1 (expected $2, got $3)" >&2; exit 1; fi; echo "ok: $1"; }

source ./access-token-secret.sh
docker compose up -d --build --wait

bootstrap() { docker compose run --rm -q migrate node apps/api/src/cli/bootstrap.ts --tenant "$1" --email "$2" 2>/dev/null; }
suffix=$(date +%s%N)
tenant_a=$(bootstrap "Smoke A" "smoke-a-$suffix@example.com")
tenant_b=$(bootstrap "Smoke B" "smoke-b-$suffix@example.com")
token_a=$(json token <<<"$tenant_a")
token_b=$(json token <<<"$tenant_b")
workspace_a=$(json workspaceId <<<"$tenant_a")

expect "healthz without auth" 200 "$(status "$api/healthz")"
expect "missions without token" 401 "$(status "$api/v1/missions")"

created=$(curl -sf -X POST "$api/v1/missions" -H "authorization: Bearer $token_a" \
  -H 'content-type: application/json' -d "{\"workspaceId\":\"$workspace_a\",\"title\":\"Smoke mission\"}")
mission=$(json id <<<"$created")
expect "created mission status" DRAFT "$(json status <<<"$created")"
expect "owner reads mission" 200 "$(status "$api/v1/missions/$mission" -H "authorization: Bearer $token_a")"
expect "other tenant reads mission" 404 "$(status "$api/v1/missions/$mission" -H "authorization: Bearer $token_b")"
expect "web healthz" 200 "$(status http://127.0.0.1:3001/healthz)"

# Password login: the bootstrap admin's initial password works and must be changed first.
login=$(curl -sf -X POST "$api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$(json email <<<"$tenant_a")\",\"password\":\"$(json initialPassword <<<"$tenant_a")\"}")
expect "login asks for a password change" true "$(json mustChangePassword <<<"$login")"
expect "missions before the password change" 403 \
  "$(status "$api/v1/missions" -H "authorization: Bearer $(json accessToken <<<"$login")")"

# The web UI shows nothing without a session and sends the browser to the login page.
web=http://127.0.0.1:3001
expect "web without a session" 307 "$(status "$web/missions/$mission")"
expect "web login page" 200 "$(status "$web/login")"
expect "web refuses framing" DENY "$(curl -sI "$web/login" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-frame-options"{print $2}')"
echo "smoke test passed"
