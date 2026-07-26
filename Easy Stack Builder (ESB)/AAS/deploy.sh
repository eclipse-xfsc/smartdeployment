#!/bin/bash
set -Eeuo pipefail


# NF-3 explicit opt-in defaults. Child scripts inherit these values.
MANAGE_INGRESS_NGINX="${MANAGE_INGRESS_NGINX:-false}"
ALLOW_INGRESS_ADMISSION_WEBHOOK_DELETION="${ALLOW_INGRESS_ADMISSION_WEBHOOK_DELETION:-false}"
export MANAGE_INGRESS_NGINX ALLOW_INGRESS_ADMISSION_WEBHOOK_DELETION


# Verified TLS helper. Private CAs are supplied by the Node-RED editor as base64 PEM
# or by direct callers through ESB_CA_BUNDLE_FILE. Insecure TLS is never enabled.
esb_curl() {
  local ca_file="" rc=0
  if [[ -n "${ESB_CA_BUNDLE_B64:-}" ]]; then
    ca_file="$(mktemp)"
    chmod 600 "$ca_file"
    if ! printf '%s' "$ESB_CA_BUNDLE_B64" | base64 --decode >"$ca_file" 2>/dev/null; then
      if ! printf '%s' "$ESB_CA_BUNDLE_B64" | base64 -d >"$ca_file" 2>/dev/null; then
        rm -f "$ca_file"
        printf '%s\n' 'Invalid trusted CA bundle supplied to deployment' >&2
        return 2
      fi
    fi
    command curl --cacert "$ca_file" "$@" || rc=$?
    rm -f "$ca_file"
    return "$rc"
  fi
  if [[ -n "${ESB_CA_BUNDLE_FILE:-}" ]]; then
    [[ -r "$ESB_CA_BUNDLE_FILE" ]] || { printf 'CA bundle is not readable: %s\n' "$ESB_CA_BUNDLE_FILE" >&2; return 2; }
    command curl --cacert "$ESB_CA_BUNDLE_FILE" "$@"
    return $?
  fi
  command curl "$@"
}


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
  local started
  local aas_auth_url key_server_url test_url status_json
  started="$(date -Iseconds)"
  aas_auth_url="$(grep '^AAS_AUTH_URL=' "$core_output" | tail -n 1 | cut -d= -f2-)"
  key_server_url="$(grep '^KEY_SERVER_URL=' "$core_output" | tail -n 1 | cut -d= -f2-)"
  test_url="$(grep '^TEST_URL=' "$core_output" | tail -n 1 | cut -d= -f2-)"

  [[ -n "$aas_auth_url" ]] || { printf '%s\n' 'AAS auth URL was not emitted' >&2; return 1; }
  [[ -n "$key_server_url" ]] || { printf '%s\n' 'AAS key-server URL was not emitted' >&2; return 1; }
  [[ -n "$test_url" ]] || { printf '%s\n' 'AAS test-server URL was not emitted' >&2; return 1; }

  emit_event observability probe started "$started" "Running AAS service health checks"
  esb_curl --fail --silent --show-error --connect-timeout 10 --max-time 60 \
    "$aas_auth_url/actuator/health" >/dev/null
  esb_curl --fail --silent --show-error --connect-timeout 10 --max-time 60 \
    "$key_server_url/realms/gaia-x/.well-known/openid-configuration" >/dev/null
  kubectl -n "$NAMESPACE" rollout status deployment/test-server --timeout=300s >/dev/null
  [[ -n "$(kubectl -n "$NAMESPACE" get endpoints test-server -o jsonpath='{.subsets[*].addresses[*].ip}')" ]] \
    || { printf '%s\n' 'AAS test-server Service has no ready endpoints' >&2; return 1; }

  status_json="$(jq -cn \
    --arg aasAuthUrl "$aas_auth_url" \
    --arg keyServerUrl "$key_server_url" \
    --arg testUrl "$test_url" \
    --arg status 'Deployed' \
    '{aasAuthUrl:$aasAuthUrl,keyServerUrl:$keyServerUrl,testUrl:$testUrl,status:$status}')"
  kubectl create configmap aas-deployment-status -n "$NAMESPACE" \
    --from-literal=status.json="$status_json" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  emit_event observability probe succeeded "$started" "AAS service health checks passed"
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
      # Best-effort rollback must not replace the original deployment failure.
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

NAMESPACE="$NAMESPACE" DOMAIN="$DOMAIN" KUBECONFIG="$KUBE" \
  "$DIR/preflight.sh" "$CERT_PATH" "$KEY_PATH"

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
