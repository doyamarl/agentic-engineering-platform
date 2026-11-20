# Sourced by smoke.sh and e2e.sh: gives the stack an access token signing secret (ADR-011) when
# neither the shell nor infra/compose/.env sets one, so the scripts run on a fresh checkout and
# in CI. A random value per run; sessions do not survive it, which the tests do not need.
if [ -z "${AEP_ACCESS_TOKEN_SECRET:-}" ] && ! grep -qs '^AEP_ACCESS_TOKEN_SECRET=' .env; then
  AEP_ACCESS_TOKEN_SECRET=$(node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64"))')
  export AEP_ACCESS_TOKEN_SECRET
fi
