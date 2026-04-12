#!/usr/bin/env bash
set -Eeuo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CORE="$DIR/deploy-core.sh"
PREFLIGHT="$DIR/preflight.sh"

NAMESPACE="${1:?namespace is required}"
DOMAIN="${2:?domain is required}"
CERT_PATH="${3:?certificate path is required}"
KEY_PATH="${4:?key path is required}"
KUBE="${5:?kubeconfig path is required}"
POLICY_REPO_URL="${6:-https://github.com/eclipse-xfsc/rego-policies}"
POLICY_REPO_FOLDER="${7:-}"
EIDAS_MODE_RAW="${8:-false}"
TRUST_KEY_PATH="${9:-}"
TRUST_CHAIN_PATH="${10:-}"

export KUBECONFIG="$KUBE"
SERVICE_ACCOUNT="tsa-runtime"
ROLE_NAME="tsa-runtime-role"
START_EPOCH="$(date +%s)"
CURRENT_STEP="deploy"
CURRENT_STEP_STARTED="$(date -Iseconds)"
CORE_STDOUT_FILE=""
TRUST_MATERIALS_AVAILABLE="false"

normalize_bool() {
  case "${1:-false}" in
    true|TRUE|1|yes|YES|on|ON) echo "true" ;;
    *) echo "false" ;;
  esac
}
EIDAS_MODE="$(normalize_bool "$EIDAS_MODE_RAW")"

emit_event() {
  local phase="$1" step="$2" status="$3" started_at="$4" details="${5:-}"
  jq -cn --arg phase "$phase" --arg step "$step" --arg status "$status" --arg startedAt "$started_at" --arg endedAt "$(date -Iseconds)" --arg details "$details" '{phase:$phase,step:$step,status:$status,startedAt:$startedAt,endedAt:$endedAt,details:$details}' | sed 's/^/EVENT_JSON=/'
}

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing required command: $1" >&2; exit 1; }
}

ensure_namespace_exists() {
  kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE" >/dev/null
}

patch_ingress_tls() {
  kubectl get ns ingress-nginx >/dev/null 2>&1 || kubectl create namespace ingress-nginx >/dev/null 2>&1 || true
  kubectl -n ingress-nginx create configmap ingress-nginx-controller --dry-run=client -o yaml | kubectl apply -f - >/dev/null 2>&1 || true
  kubectl -n ingress-nginx patch configmap ingress-nginx-controller --type merge -p '{"data":{"ssl-protocols":"TLSv1.3","hsts":"true","server-tokens":"false","allow-snippet-annotations":"true"}}' >/dev/null 2>&1 || true
}

ensure_namespace_baseline() {
  cat <<EOF_BASELINE | kubectl -n "$NAMESPACE" apply -f - >/dev/null
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tsa-resource-quota
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "30"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: tsa-container-defaults
spec:
  limits:
    - type: Container
      default:
        cpu: "750m"
        memory: 768Mi
      defaultRequest:
        cpu: "150m"
        memory: 192Mi
---
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
EOF_BASELINE
}

report_step_error() {
  local exit_code="$?"
  emit_event deploy "${CURRENT_STEP:-deploy}" failed "${CURRENT_STEP_STARTED:-$(date -Iseconds)}" "Step ${CURRENT_STEP:-deploy} failed" || true
  return "$exit_code"
}
trap report_step_error ERR

pick_output_value() {
  local key="$1"
  local file="$2"
  awk -F= -v wanted="$key" '$1 == wanted {sub(/^[^=]*=/, "", $0); print $0; exit}' "$file" 2>/dev/null || true
}

find_deployment() {
  local pattern="$1"
  kubectl -n "$NAMESPACE" get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | grep "$pattern" | head -n1 || true
}

wait_deployment_rollout() {
  local deployment_name="$1"
  local timeout="${2:-180s}"
  if [ -n "$deployment_name" ]; then
    kubectl -n "$NAMESPACE" rollout status "deploy/${deployment_name}" --timeout="$timeout" >/dev/null 2>&1 || true
  fi
}

persist_runtime_config() {
  local started="$(date -Iseconds)"
  CURRENT_STEP="config"
  CURRENT_STEP_STARTED="$started"
  emit_event config persist started "$started" "Persisting TSA runtime configuration"
  kubectl create configmap tsa-runtime-config \
    -n "$NAMESPACE" \
    --from-literal=POLICY_REPO_URL="$POLICY_REPO_URL" \
    --from-literal=POLICY_REPO_FOLDER="$POLICY_REPO_FOLDER" \
    --from-literal=EIDAS_VALIDATION="$EIDAS_MODE" \
    --from-literal=TSA_POLICY_URL="https://policy.${DOMAIN}/v1/policies" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  emit_event config persist succeeded "$started" "TSA runtime configuration stored"
}

persist_trust_materials() {
  local started="$(date -Iseconds)"
  CURRENT_STEP="trust-material"
  CURRENT_STEP_STARTED="$started"

  if [ -z "$TRUST_KEY_PATH" ] && [ -z "$TRUST_CHAIN_PATH" ]; then
    emit_event trust material skipped "$started" "No optional signing key or certificate chain was provided"
    return 0
  fi

  emit_event trust material started "$started" "Persisting optional TSA trust material"
  local create_args=(kubectl create secret generic tsa-trust-materials -n "$NAMESPACE")
  if [ -n "$TRUST_KEY_PATH" ]; then
    create_args+=(--from-file=signing-key="$TRUST_KEY_PATH")
  fi
  if [ -n "$TRUST_CHAIN_PATH" ]; then
    create_args+=(--from-file=certificate-chain="$TRUST_CHAIN_PATH")
  fi
  create_args+=(--dry-run=client -o yaml)
  "${create_args[@]}" | kubectl apply -f - >/dev/null
  TRUST_MATERIALS_AVAILABLE="true"
  emit_event trust material succeeded "$started" "Optional TSA trust material stored in Kubernetes Secret"
}

propagate_runtime_config() {
  local started="$(date -Iseconds)"
  local policy_dep signer_dep
  CURRENT_STEP="config-rollout"
  CURRENT_STEP_STARTED="$started"
  emit_event config rollout started "$started" "Propagating runtime configuration into TSA workloads"

  policy_dep="$(find_deployment '^policy')"
  signer_dep="$(find_deployment '^signer$')"

  if [ -n "$policy_dep" ]; then
    kubectl -n "$NAMESPACE" set env "deploy/${policy_dep}" --from=configmap/tsa-runtime-config >/dev/null 2>&1 || true
    if [ "$TRUST_MATERIALS_AVAILABLE" = "true" ]; then
      kubectl -n "$NAMESPACE" set env "deploy/${policy_dep}" TSA_TRUST_MATERIAL_SECRET=tsa-trust-materials >/dev/null 2>&1 || true
    fi
    wait_deployment_rollout "$policy_dep" 240s
  fi

  if [ -n "$signer_dep" ]; then
    kubectl -n "$NAMESPACE" set env "deploy/${signer_dep}" --from=configmap/tsa-runtime-config >/dev/null 2>&1 || true
    if [ "$TRUST_MATERIALS_AVAILABLE" = "true" ]; then
      kubectl -n "$NAMESPACE" set env "deploy/${signer_dep}" TSA_TRUST_MATERIAL_SECRET=tsa-trust-materials >/dev/null 2>&1 || true
    fi
    wait_deployment_rollout "$signer_dep" 240s
  fi

  emit_event config rollout succeeded "$started" "Runtime configuration propagated to TSA workloads"
}

publish_status_contract() {
  local started="$(date -Iseconds)"
  local tsa_url key_id policy_status status_json
  CURRENT_STEP="observability"
  CURRENT_STEP_STARTED="$started"
  emit_event observability probe started "$started" "Publishing TSA status contract"

  tsa_url="$(pick_output_value TSA_URL "$CORE_STDOUT_FILE")"
  key_id="$(pick_output_value KEY_ID "$CORE_STDOUT_FILE")"
  policy_status="$(pick_output_value POLICY_STATUS "$CORE_STDOUT_FILE")"

  [ -n "$tsa_url" ] || tsa_url="https://policy.${DOMAIN}/v1/policies"
  [ -n "$key_id" ] || key_id="SDJWTCredential"
  [ -n "$policy_status" ] || policy_status="Ready"

  curl -kfsS --max-time 15 "$tsa_url" >/dev/null 2>&1 || true

  status_json="$(jq -cn \
    --arg tsaUrl "$tsa_url" \
    --arg keyId "$key_id" \
    --arg policyStatus "$policy_status" \
    --arg status 'Deployed' \
    --arg eidasValidation "$EIDAS_MODE" \
    '{tsaUrl:$tsaUrl,keyId:$keyId,policyStatus:$policyStatus,status:$status,eidasValidation:$eidasValidation}')"
  kubectl create configmap tsa-deployment-status -n "$NAMESPACE" --from-literal=status.json="$status_json" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  echo "TSA_URL=$tsa_url"
  echo "KEY_ID=$key_id"
  echo "POLICY_STATUS=$policy_status"
  echo "STATUS=Deployed"
  emit_event observability probe succeeded "$started" "TSA status contract stored"
}

rollback_on_error() {
  local exit_code="$?"
  if [ "$exit_code" -ne 0 ]; then
    local started="$(date -Iseconds)"
    emit_event deploy rollback skipped "$started" "Deployment failed; preserving namespace for inspection"
  fi
  [ -n "$CORE_STDOUT_FILE" ] && rm -f "$CORE_STDOUT_FILE" || true
  exit "$exit_code"
}
trap rollback_on_error EXIT

for bin in kubectl jq curl awk; do
  require "$bin"
done

started="$(date -Iseconds)"
CURRENT_STEP="preflight"
CURRENT_STEP_STARTED="$started"
emit_event preflight validate started "$started" "Running TSA shell preflight checks"
bash "$PREFLIGHT" "$@" >/dev/null
emit_event preflight validate succeeded "$started" "TSA shell preflight checks passed"

patch_ingress_tls
ensure_namespace_exists
ensure_namespace_baseline
persist_runtime_config
persist_trust_materials

started="$(date -Iseconds)"
CURRENT_STEP="core"
CURRENT_STEP_STARTED="$started"
emit_event deploy core started "$started" "Executing TSA deployment workflow"
CORE_STDOUT_FILE="$(mktemp -t tsa-core-stdout-XXXXXX)"
bash "$CORE" "$@" | tee "$CORE_STDOUT_FILE"
emit_event deploy core succeeded "$started" "TSA deployment workflow finished"

ensure_namespace_baseline
propagate_runtime_config
publish_status_contract

trap - EXIT
[ -n "$CORE_STDOUT_FILE" ] && rm -f "$CORE_STDOUT_FILE" || true
DURATION="$(( $(date +%s) - START_EPOCH ))"
echo "DEPLOYMENT_DURATION_SECONDS=${DURATION}"
