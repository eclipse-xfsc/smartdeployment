#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

bash -n deploy.sh
bash -n uninstall.sh
bash -n preflight.sh
bash -n test/runtime-health.sh
bash -n test/bdd/run.sh
bash -n test/evidence/collect-runtime-evidence.sh
node -c ocmwstack.js >/dev/null
node -c Didcomm/didcomm-post-renderer.js >/dev/null

if grep -nE 'base64[[:space:]]+(--decode|-decode)' deploy.sh uninstall.sh; then
  echo 'GNU-only base64 decode flag found; ORCE uses BusyBox base64.' >&2
  exit 1
fi

if ! grep -q 'base64 -d' deploy.sh || ! grep -q 'base64 -d' uninstall.sh; then
  echo 'Portable base64 decoder is missing.' >&2
  exit 1
fi

if ! grep -q 'id="node-input-useCustomCaBundle"' ocmwstack.html; then
  echo 'Custom CA bundle opt-in checkbox is missing from the Node-RED editor.' >&2
  exit 1
fi

if ! grep -q 'useCustomCaBundle:[[:space:]]*{ value: false }' ocmwstack.html; then
  echo 'Custom CA bundle must default to disabled.' >&2
  exit 1
fi

if ! grep -q 'useCustomCaBundle.*true.*false' ocmwstack.js; then
  echo 'Custom CA bundle opt-in is not passed to deploy.sh.' >&2
  exit 1
fi

if ! grep -q 'USE_CUSTOM_CA_BUNDLE' deploy.sh || ! grep -q 'ca.crt' deploy.sh; then
  echo 'deploy.sh does not conditionally apply the custom CA bundle.' >&2
  exit 1
fi

if ! grep -q 'CA bundle is enabled but no CA bundle path was provided' preflight.sh; then
  echo 'preflight.sh does not enforce a bundle when the opt-in is enabled.' >&2
  exit 1
fi

for checkbox in enableIngressNginxClusterConfig deleteIngressNginxAdmissionWebhook; do
  if ! grep -q "id=\"node-input-${checkbox}\"" ocmwstack.html; then
    echo "Ingress opt-in checkbox is missing: ${checkbox}" >&2
    exit 1
  fi
  if ! grep -q "${checkbox}:[[:space:]]*{ value: false }" ocmwstack.html; then
    echo "Ingress option must default to disabled: ${checkbox}" >&2
    exit 1
  fi
done

if ! grep -q "enableIngressNginxClusterConfig ? 'true' : 'false'" ocmwstack.js; then
  echo 'Ingress controller management opt-in is not passed to deploy.sh.' >&2
  exit 1
fi

if ! grep -q "deleteIngressNginxAdmissionWebhook ? 'true' : 'false'" ocmwstack.js; then
  echo 'Ingress admission webhook deletion opt-in is not passed to deploy.sh.' >&2
  exit 1
fi

python3 - <<'PYTEST'
from pathlib import Path
s = Path('deploy.sh').read_text()
checks = {
    'controller guard': 'if [[ "$ENABLE_INGRESS_NGINX_CLUSTER_CONFIG" == "true" ]]; then',
    'controller disabled branch': 'Ingress controller management is disabled; validating the existing shared controller without modifying it.',
    'controller manifest apply': 'curl -fsSL "$ING_URL" | kubectl apply -f -',
    'controller namespace creation': 'kubectl get namespace ingress-nginx >/dev/null 2>&1 || kubectl create namespace ingress-nginx',
    'controller config patch': 'kubectl -n ingress-nginx patch configmap ingress-nginx-controller',
    'controller restart': 'kubectl -n ingress-nginx rollout restart deployment/ingress-nginx-controller',
    'existing deployment validation': 'kubectl -n ingress-nginx get deployment/ingress-nginx-controller >/dev/null',
    'existing service validation': 'kubectl -n ingress-nginx get service/ingress-nginx-controller >/dev/null',
    'existing class validation': 'kubectl get ingressclass nginx >/dev/null',
    'webhook guard': 'if [[ "$DELETE_INGRESS_NGINX_ADMISSION_WEBHOOK" == "true" ]]; then',
    'webhook deletion': 'kubectl delete validatingwebhookconfiguration ingress-nginx-admission --ignore-not-found',
    'snippet setting': '"allow-snippet-annotations":"true"',
    'risk setting': '"annotations-risk-level":"Critical"',
}
for name, text in checks.items():
    if text not in s:
        raise SystemExit(f'Missing ingress opt-in implementation: {name}')

guard = s.index(checks['controller guard'])
disabled = s.index(checks['controller disabled branch'], guard)
controller_end = s.index('\nfi\n\n# Webhook deletion remains', disabled)

for name in ('controller manifest apply', 'controller namespace creation', 'controller config patch', 'controller restart', 'snippet setting', 'risk setting'):
    position = s.index(checks[name])
    if not guard < position < disabled:
        raise SystemExit(f'Cluster-wide ingress mutation is not inside the controller opt-in: {name}')

for name in ('existing deployment validation', 'existing service validation', 'existing class validation'):
    position = s.index(checks[name], disabled)
    if not disabled < position < controller_end:
        raise SystemExit(f'Existing-controller validation is missing from the disabled branch: {name}')

disabled_block = s[disabled:controller_end]
for forbidden in ('kubectl apply', 'kubectl patch', 'kubectl create', 'rollout restart', 'kubectl delete'):
    if forbidden in disabled_block:
        raise SystemExit(f'Disabled ingress-management branch mutates shared infrastructure: {forbidden}')

webhook_delete = s.rindex(checks['webhook deletion'])
webhook_guard = s.rfind(checks['webhook guard'], 0, webhook_delete)
if webhook_guard < 0:
    raise SystemExit('Webhook deletion is not guarded by its opt-in.')
PYTEST

if grep -RInE 'devRootToken:[[:space:]]*root|VAULT_TOKEN=root|from-literal=token="?root"?' deploy.sh Vault/values.yaml; then
  echo 'Hard-coded Vault root token remains.' >&2
  exit 1
fi

for expected in \
  'VAULT_ROOT_TOKEN="$(openssl rand -hex 32)"' \
  'kubectl create secret generic vault' \
  'devRootToken: "${VAULT_ROOT_TOKEN}"' \
  'Reusing the persisted generated Vault root token'; do
  if ! grep -Fq "$expected" deploy.sh; then
    echo "Generated Vault token implementation is incomplete: $expected" >&2
    exit 1
  fi
done

for asset in \
  test/runtime-health.sh \
  test/bdd/run.sh \
  test/bdd/features/ocmwstack-health.feature \
  test/bdd/traceability.csv \
  test/evidence/collect-runtime-evidence.sh; do
  [[ -f "$asset" ]] || { echo "Missing acceptance asset: $asset" >&2; exit 1; }
done

for executable in test/runtime-health.sh test/bdd/run.sh test/evidence/collect-runtime-evidence.sh; do
  [[ -x "$executable" ]] || { echo "Acceptance runner is not executable: $executable" >&2; exit 1; }
done

if ! grep -q '"version": "11.0.2"' package.json; then
  echo 'Package version is not 11.0.2.' >&2
  exit 1
fi

if command -v busybox >/dev/null 2>&1; then
  decoded="$(printf 'b2s=' | busybox base64 -d)"
  [[ "$decoded" == 'ok' ]] || {
    echo 'BusyBox base64 decode regression test failed.' >&2
    exit 1
  }
fi

node <<'NODE'
const fs = require('fs');

const schema = JSON.parse(fs.readFileSync('schema/ocm-output.schema.json', 'utf8'));
const requiredKeys = ['ocmUrl', 'keycloakUrl', 'clientSecretRef', 'uiUrl', 'namespace', 'externalIp', 'status'];
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
