#!/usr/bin/env bash
set -Eeuo pipefail

NAMESPACE="${1:?namespace is required}"
DOMAIN="${2:?domain is required}"
KUBECONFIG_PATH="${3:?kubeconfig path is required}"
CERT_PATH="${4:?certificate path is required}"
EVIDENCE_DIR="${5:?evidence directory is required}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HEALTH_RUNNER="$ROOT/test/runtime-health.sh"
mkdir -p "$EVIDENCE_DIR"

set +e
bash "$HEALTH_RUNNER" "$NAMESPACE" "$DOMAIN" "$KUBECONFIG_PATH" "$CERT_PATH" "$EVIDENCE_DIR"
HEALTH_RC=$?
set -e

if [ "$HEALTH_RC" -eq 0 ]; then
  STATUS="passed"
else
  STATUS="failed"
fi

jq -cn \
  --arg status "$STATUS" \
  --argjson exitCode "$HEALTH_RC" \
  '{suite:"TSA Service-readiness BDD",status:$status,exitCode:$exitCode,scenarios:[
    {id:"BDD-TSA-01",name:"TSA namespace is available",status:$status},
    {id:"BDD-TSA-02",name:"TSA Services have ready backends",status:$status},
    {id:"BDD-TSA-03",name:"Deployment status fails closed",status:$status}
  ]}' > "$EVIDENCE_DIR/bdd-results.json"

{
  printf '# TSA Service-readiness BDD Results\n\n'
  printf -- '- Result: **%s**\n' "$STATUS"
  printf -- '- Runtime health exit code: `%s`\n\n' "$HEALTH_RC"
  printf 'The executable BDD pack verifies namespace availability, Kubernetes Service endpoint readiness, and fail-closed publication. It does not test ingress or TSA application functionality.\n'
} > "$EVIDENCE_DIR/bdd-results.md"

exit "$HEALTH_RC"
