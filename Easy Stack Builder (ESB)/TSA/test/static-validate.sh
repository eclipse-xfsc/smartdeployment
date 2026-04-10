#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$ROOT/deploy-core.sh" ]
[ -f "$ROOT/uninstall-core.sh" ]
[ -f "$ROOT/preflight.sh" ]
[ -d "$ROOT/Keycloak" ]
[ -f "$ROOT/tsastack.schema.json" ]

bash -n "$ROOT/deploy.sh"
bash -n "$ROOT/deploy-core.sh"
bash -n "$ROOT/uninstall.sh"
bash -n "$ROOT/uninstall-core.sh"
bash -n "$ROOT/preflight.sh"
node --check "$ROOT/tsastack.js"
python3 -m json.tool "$ROOT/tsastack.schema.json" >/dev/null
if command -v helm >/dev/null 2>&1; then
  helm template keycloak "$ROOT/Keycloak" >/dev/null
fi
grep -q 'AAS_AUTH_URL=' "$ROOT/deploy.sh"
grep -q 'KEY_SERVER_URL=' "$ROOT/deploy.sh"
grep -q 'curl -kfsS' "$ROOT/deploy.sh"
grep -q 'Security' "$ROOT/tsastack.html"
grep -q 'aasAuthUrl' "$ROOT/tsastack.js"
grep -q 'EVENT_JSON=' "$ROOT/deploy.sh"

echo '[OK] TSA static validation passed'
