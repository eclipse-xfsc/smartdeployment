#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[ -d "$ROOT/scripts" ]
[ -d "$ROOT/helm/AAS" ]
[ -d "$ROOT/helm/Keycloak" ]
[ -f "$ROOT/README.md" ]
[ -f "$ROOT/aas.schema.json" ]

bash -n "$ROOT/deploy.sh"
bash -n "$ROOT/uninstall.sh"
bash -n "$ROOT/scripts/deploy.sh"
bash -n "$ROOT/scripts/uninstall.sh"
node --check "$ROOT/aas.js"
python3 -m json.tool "$ROOT/aas.schema.json" >/dev/null

if command -v helm >/dev/null 2>&1; then
  helm template aas "$ROOT/helm/AAS" >/dev/null
  helm template keycloak "$ROOT/helm/Keycloak" >/dev/null
fi

grep -q 'AAS_AUTH_URL=' "$ROOT/scripts/deploy.sh"
grep -q 'TEST_URL=' "$ROOT/scripts/deploy.sh"
grep -q 'NetworkPolicy' "$ROOT/deploy.sh"
grep -q 'EVENT_JSON=' "$ROOT/deploy.sh"
grep -q 'rollback' "$ROOT/deploy.sh"
grep -q 'curl -kfsS' "$ROOT/deploy.sh"
grep -q 'aasAuthUrl' "$ROOT/aas.js"

echo '[OK] AAS static validation passed'
