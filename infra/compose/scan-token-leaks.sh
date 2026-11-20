#!/usr/bin/env bash
# PRD scenario H: no token the mock MCP server issued may appear in the platform's logs. Run after
# the e2e tests against the stack they used (e2e.sh does). The mock lists the tokens its tool calls
# carried and the tokens revoked on disconnect; the mock_at_ and mock_rt_ prefixes also catch
# tokens it issued that no call used (a refreshed one, for example). The mock MCP server's own logs
# and the OIDC provider's are not the platform's and are left out.
set -euo pipefail
cd "$(dirname "$0")"
export COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml:compose.connectors.yaml:compose.e2e.yaml}"
docker compose logs --no-color --no-log-prefix db migrate api worker web 2>&1 |
  node --input-type=module -e '
    let logs = "";
    for await (const chunk of process.stdin) logs += chunk;
    const state = await (await fetch("http://127.0.0.1:8090/_mock/state")).json();
    const tokens = [...new Set([...state.toolCalls.map((c) => c.token), ...state.revoked])];
    const leaked = tokens.filter((t) => t !== "" && logs.includes(t));
    const prefixed = logs.match(/mock_(at|rt)_[A-Za-z0-9_-]{8}/g) ?? [];
    if (leaked.length > 0 || prefixed.length > 0) {
      console.error(`scenario H: ${String(leaked.length + prefixed.length)} connector token(s) in the logs`);
      process.exit(1);
    }
    console.log(`scenario H: none of ${String(tokens.length)} issued tokens in ${String(logs.split("\n").length)} log lines`);
  '
