#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$ROOT/deploy-core.sh" ]
[ -f "$ROOT/uninstall-core.sh" ]
[ -f "$ROOT/preflight.sh" ]
[ -f "$ROOT/pcmcloud.schema.json" ]
[ -d "$ROOT/Web-UI Service" ]

bash -n "$ROOT/deploy.sh"
bash -n "$ROOT/deploy-core.sh"
bash -n "$ROOT/uninstall.sh"
bash -n "$ROOT/uninstall-core.sh"
bash -n "$ROOT/preflight.sh"
node --check "$ROOT/pcmcloud.js"
python3 -m json.tool "$ROOT/pcmcloud.schema.json" >/dev/null

if command -v helm >/dev/null 2>&1; then
  helm template web-ui "$ROOT/Web-UI Service" >/dev/null
fi

grep -q 'PCM_URL=' "$ROOT/deploy.sh"
grep -q 'ISSUER_ID=' "$ROOT/deploy.sh"
grep -q 'curl -kfsS' "$ROOT/deploy.sh"
grep -q 'Credential Policy' "$ROOT/pcmcloud.html"
grep -q 'credentialType' "$ROOT/pcmcloud.js"
grep -q 'resources:' "$ROOT/Web-UI Service/values.yaml"
grep -q 'serviceAccountName' "$ROOT/Web-UI Service/templates/deployment.yaml"
grep -q 'EVENT_JSON=' "$ROOT/deploy.sh"

echo '[OK] PCM static validation passed'
