#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

bash -n deploy.sh
bash -n uninstall.sh
bash -n preflight.sh
node -c ocmwstack.js >/dev/null

node <<'NODE'
const fs = require('fs');

const schema = JSON.parse(fs.readFileSync('schema/ocm-output.schema.json', 'utf8'));
const requiredKeys = ['ocmUrl', 'keycloakUrl', 'clientSecret', 'externalIp', 'status'];
for (const key of requiredKeys) {
  if (!(schema.required || []).includes(key)) {
    throw new Error(`Missing schema key: ${key}`);
  }
}

const deploySh = fs.readFileSync('deploy.sh', 'utf8');
const nodeJs = fs.readFileSync('ocmwstack.js', 'utf8');
if (!deploySh.includes('EVENT_JSON=')) throw new Error('deploy.sh does not emit EVENT_JSON lines.');
if (!deploySh.includes('OUTPUT_JSON=')) throw new Error('deploy.sh does not emit OUTPUT_JSON lines.');
if (!nodeJs.includes('OUTPUT_JSON=')) throw new Error('ocmwstack.js does not parse OUTPUT_JSON lines.');
if (!nodeJs.includes('EVENT_JSON=')) throw new Error('ocmwstack.js does not parse EVENT_JSON lines.');
NODE

if command -v helm >/dev/null 2>&1; then
  TMPDIR="$(mktemp -d)"
  cleanup() {
    rm -rf "$TMPDIR"
  }
  trap cleanup EXIT

  sed 's/DOMAIN/example.com/g' "./Keycloak/values.yaml" > "$TMPDIR/keycloak-values.yaml"
  helm template keycloak "./Keycloak" -f "$TMPDIR/keycloak-values.yaml" >/dev/null

  sed 's/DOMAIN/example.com/g' "./Well Known Ingress Rules/values.yaml" > "$TMPDIR/wellknown-values.yaml"
  helm template well-known-ingress-rules "./Well Known Ingress Rules" -f "$TMPDIR/wellknown-values.yaml" >/dev/null
fi

echo "static validation passed"
