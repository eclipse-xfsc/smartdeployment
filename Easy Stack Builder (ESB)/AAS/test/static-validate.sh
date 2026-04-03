#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[ -d "$ROOT/scripts" ]
[ -d "$ROOT/helm/AAS" ]
[ -d "$ROOT/helm/Keycloak" ]
[ -f "$ROOT/README.md" ]
[ -f "$ROOT/aas.schema.json" ]

bash -n "$ROOT/scripts/deploy.sh"
bash -n "$ROOT/scripts/uninstall.sh"
node --check "$ROOT/aas.js"
python3 -m json.tool "$ROOT/aas.schema.json" >/dev/null

grep -q 'AAS_AUTH_URL=' "$ROOT/scripts/deploy.sh"
grep -q 'TEST_URL=' "$ROOT/scripts/deploy.sh"
grep -q 'test-server.DOMAIN' "$ROOT/helm/AAS/values.yaml"
grep -q 'aasAuthUrl' "$ROOT/aas.js"

echo '[OK] AAS static validation passed'
