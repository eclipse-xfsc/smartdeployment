#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

required_files=(
  deploy.sh deploy-core.sh uninstall.sh uninstall-core.sh preflight.sh
  tsastack.js tsastack.html tsastack.schema.json
  test/runtime-health.sh test/bdd/run-bdd.sh
  test/bdd/features/tsa_deployment_health.feature
  test/TRACEABILITY_MATRIX.md test/evidence/README.md
)
for file in "${required_files[@]}"; do
  [ -f "$ROOT/$file" ] || { echo "missing required file: $file" >&2; exit 1; }
done

for script in deploy.sh deploy-core.sh uninstall.sh uninstall-core.sh preflight.sh test/runtime-health.sh test/bdd/run-bdd.sh test/static-validate.sh; do
  bash -n "$ROOT/$script"
done
node --check "$ROOT/tsastack.js"
python3 -m json.tool "$ROOT/tsastack.schema.json" >/dev/null

[ -x "$ROOT/test/runtime-health.sh" ]
[ -x "$ROOT/test/bdd/run-bdd.sh" ]

grep -q 'patchIngressNginx: { value: false }' "$ROOT/tsastack.html"
grep -q 'PATCH_INGRESS_NGINX_RAW="${11:-false}"' "$ROOT/deploy.sh"
grep -q 'Global ingress-nginx changes were not requested' "$ROOT/deploy.sh"

if grep -RInE --include='*.sh' --include='*.js' 'curl[[:space:]][^\n]*([[:space:]]-k([[:space:]]|$)|--insecure)' "$ROOT" >/dev/null; then
  echo 'insecure curl option found' >&2
  exit 1
fi

# No rollout watcher, kubectl wait, ingress probe, HTTP probe, or process-timeout gate.
if grep -RInE --include='deploy*.sh' --include='runtime-health.sh' 'kubectl[[:space:]]+wait|rollout[[:space:]]+status|(^|[[:space:]])timeout([[:space:]]|$)|--cacert|--resolve|--connect-to|curl[[:space:]]' "$ROOT" >/dev/null; then
  echo 'obsolete rollout/timeout/endpoint gate found' >&2
  exit 1
fi

if grep -q 'STATUS=Deployed' "$ROOT/deploy-core.sh"; then
  echo 'core deployer must not publish Deployed before health acceptance' >&2
  exit 1
fi
acceptance_line="$(grep -n '^run_runtime_acceptance$' "$ROOT/deploy.sh" | cut -d: -f1)"
publish_line="$(grep -n '^publish_status_contract$' "$ROOT/deploy.sh" | cut -d: -f1)"
[ -n "$acceptance_line" ] && [ -n "$publish_line" ] && [ "$acceptance_line" -lt "$publish_line" ]

grep -q 'get endpointslices.discovery.k8s.io' "$ROOT/test/runtime-health.sh"
grep -q 'get endpoints "$service_name"' "$ROOT/test/runtime-health.sh"
grep -q 'Every selector-backed TSA Service' "$ROOT/test/runtime-health.sh"
grep -q 'TSA_HEALTH_WAIT_SECONDS:-300' "$ROOT/test/runtime-health.sh"
grep -q 'tsa-runtime-evidence' "$ROOT/deploy.sh"

# Runtime evidence must be recreated directly, not applied, because kubectl apply
# serializes ConfigMap data into a last-applied annotation capped at 256 KiB.
acceptance_block="$(sed -n '/^run_runtime_acceptance()/,/^}/p' "$ROOT/deploy.sh")"
printf '%s\n' "$acceptance_block" | grep -q 'delete configmap tsa-runtime-evidence'
printf '%s\n' "$acceptance_block" | grep -q 'create configmap tsa-runtime-evidence'
if printf '%s\n' "$acceptance_block" | grep -q 'kubectl apply'; then
  echo 'runtime evidence must not use kubectl apply' >&2
  exit 1
fi
if printf '%s\n' "$acceptance_block" | grep -Eq 'services\.json|pods\.json|events\.txt'; then
  echo 'large diagnostic snapshots must not be persisted in the runtime evidence ConfigMap' >&2
  exit 1
fi
if ! printf '%s\n' "$acceptance_block" | grep -q 'Runtime evidence persistence is best-effort'; then
  echo 'runtime evidence persistence must not gate Service readiness' >&2
  exit 1
fi
grep -q 'runtime-health.json' "$ROOT/test/runtime-health.sh"
grep -q 'BDD-TSA-03' "$ROOT/test/bdd/run-bdd.sh"

! grep -RIn --exclude='static-validate.sh' -E 'devRootToken:[[:space:]]*root|from-literal=token=.?root|VAULT_TOKEN=root' "$ROOT" >/dev/null
grep -q 'openssl rand -hex 32' "$ROOT/deploy-core.sh"
grep -q 'from-file=token=' "$ROOT/deploy-core.sh"


echo '[OK] TSA static validation passed'
