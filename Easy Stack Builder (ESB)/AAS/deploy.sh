#!/bin/bash
set -Eeuo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CORE="$DIR/scripts/deploy.sh"

NAMESPACE="${1:?namespace is required}"
DOMAIN="${2:?domain is required}"
CERT_PATH="${3:?certificate path is required}"
KEY_PATH="${4:?key path is required}"
KUBE="${5:?kubeconfig path is required}"
DB_TYPE="${6:-embedded}"
DB_URL="${7:-}"
DB_USERNAME="${8:-}"
DB_PASSWORD="${9:-}"

export KUBECONFIG="$KUBE"
SERVICE_ACCOUNT="aas-runtime"
ROLE_NAME="aas-runtime-role"
START_EPOCH="$(date +%s)"
AUTO_ROLLBACK_ON_FAILURE="${AUTO_ROLLBACK_ON_FAILURE:-false}"
ROLLBACK_DONE=0

emit_event() {
  local phase="$1" step="$2" status="$3" started_at="$4" details="${5:-}"
  jq -cn --arg phase "$phase" --arg step "$step" --arg status "$status" --arg startedAt "$started_at" --arg endedAt "$(date -Iseconds)" --arg details "$details" '{phase:$phase,step:$step,status:$status,startedAt:$startedAt,endedAt:$endedAt,details:$details}' | sed 's/^/EVENT_JSON=/'
}

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing required command: $1" >&2; exit 1; }
}

ensure_namespace_security() {
  cat <<EOF_SEC | kubectl -n "$NAMESPACE" apply -f - >/dev/null
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${SERVICE_ACCOUNT}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${ROLE_NAME}
rules:
  - apiGroups: [""]
    resources: ["configmaps","endpoints","events","pods","pods/log","secrets","services"]
    verbs: ["get","list","watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${SERVICE_ACCOUNT}-binding
subjects:
  - kind: ServiceAccount
    name: ${SERVICE_ACCOUNT}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${ROLE_NAME}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: aas-default-guard
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ${NAMESPACE}
  egress:
    - {}
EOF_SEC
}

health_checks() {
  local core_output="$1"
  local started="$(date -Iseconds)"
  local aas_auth_url key_server_url test_url status_json
  aas_auth_url="$(grep '^AAS_AUTH_URL=' "$core_output" | tail -n 1 | cut -d= -f2- || true)"
  key_server_url="$(grep '^KEY_SERVER_URL=' "$core_output" | tail -n 1 | cut -d= -f2- || true)"
  test_url="$(grep '^TEST_URL=' "$core_output" | tail -n 1 | cut -d= -f2- || true)"
  emit_event observability probe started "$started" "Running AAS endpoint smoke checks"
  [ -n "$aas_auth_url" ] && curl -kfsS --max-time 15 "$aas_auth_url/actuator/health" >/dev/null 2>&1 || true
  [ -n "$key_server_url" ] && curl -kfsS --max-time 15 "$key_server_url/realms/gaia-x/.well-known/openid-configuration" >/dev/null 2>&1 || true
  [ -n "$test_url" ] && curl -kfsS --max-time 15 "$test_url" >/dev/null 2>&1 || true
  status_json="$(jq -cn --arg aasAuthUrl "$aas_auth_url" --arg keyServerUrl "$key_server_url" --arg testUrl "$test_url" --arg status 'Deployed' '{aasAuthUrl:$aasAuthUrl,keyServerUrl:$keyServerUrl,testUrl:$testUrl,status:$status}')"
  kubectl create configmap aas-deployment-status -n "$NAMESPACE" --from-literal=status.json="$status_json" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  emit_event observability probe succeeded "$started" "AAS smoke checks finished and status contract stored"
}

cleanup_temp_file() {
  local temp_file="${1:-}"
  [ -n "$temp_file" ] && [ -f "$temp_file" ] && rm -f "$temp_file"
}

rollback_on_error() {
  local exit_code="$?"
  cleanup_temp_file "${CORE_OUTPUT_FILE:-}"
  if [ "$exit_code" -ne 0 ] && [ "$ROLLBACK_DONE" -eq 0 ]; then
    local started
    started="$(date -Iseconds)"
    ROLLBACK_DONE=1
    if [ "$AUTO_ROLLBACK_ON_FAILURE" = "true" ]; then
      emit_event deploy rollback started "$started" "AAS deployment failed; executing uninstall rollback"
      bash "$DIR/uninstall.sh" "$NAMESPACE" "$KUBE" >/dev/null 2>&1 || true
      emit_event deploy rollback finished "$started" "Rollback completed"
    else
      emit_event deploy rollback skipped "$started" "AAS deployment failed; preserving namespace for inspection"
    fi
  fi
  exit "$exit_code"
}

for bin in jq kubectl curl tee grep cut; do
  require "$bin"
done

started="$(date -Iseconds)"
emit_event deploy core started "$started" "Executing AAS deployment workflow"
CORE_OUTPUT_FILE="$(mktemp)"
trap rollback_on_error EXIT
bash "$CORE" "$NAMESPACE" "$DOMAIN" "$CERT_PATH" "$KEY_PATH" "$KUBE" "$DB_TYPE" "$DB_URL" "$DB_USERNAME" "$DB_PASSWORD" | tee "$CORE_OUTPUT_FILE"
emit_event deploy core succeeded "$started" "AAS deployment workflow finished"

ensure_namespace_security
health_checks "$CORE_OUTPUT_FILE"

trap - EXIT
cleanup_temp_file "$CORE_OUTPUT_FILE"
echo "DEPLOYMENT_DURATION_SECONDS=$(( $(date +%s) - START_EPOCH ))"
