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

grep -q 'TSA_URL=' "$ROOT/deploy.sh"
grep -q 'KEY_ID=' "$ROOT/deploy.sh"
grep -q 'POLICY_STATUS=' "$ROOT/deploy.sh"
grep -q 'tsaUrl' "$ROOT/tsastack.js"
grep -q 'trustKeyContent' "$ROOT/tsastack.js"
grep -q 'eIDAS validation' "$ROOT/tsastack.html"
grep -q 'tsa-runtime-config' "$ROOT/deploy.sh"
grep -q 'ENGINE_PATH' "$ROOT/deploy-core.sh"
grep -q 'EVENT_JSON=' "$ROOT/deploy.sh"
! grep -q 'AAS_AUTH_URL=' "$ROOT/deploy.sh"
! grep -q 'aasAuthUrl' "$ROOT/tsastack.js"

echo '[OK] TSA static validation passed'
