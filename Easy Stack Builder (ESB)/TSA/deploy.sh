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
PATCH_INGRESS_NGINX_RAW="${11:-false}"

export KUBECONFIG="$KUBE"
SERVICE_ACCOUNT="tsa-runtime"
ROLE_NAME="tsa-runtime-role"
START_EPOCH="$(date +%s)"
CURRENT_STEP="deploy"
CURRENT_STEP_STARTED="$(date -Iseconds)"
CORE_STDOUT_FILE=""
RUNTIME_EVIDENCE_DIR=""
TRUST_MATERIALS_AVAILABLE="false"
BDD_RUNNER="$DIR/test/bdd/run-bdd.sh"

normalize_bool() {
  case "${1:-false}" in
    true|TRUE|1|yes|YES|on|ON) echo "true" ;;
    *) echo "false" ;;
  esac
}
EIDAS_MODE="$(normalize_bool "$EIDAS_MODE_RAW")"
PATCH_INGRESS_NGINX="$(normalize_bool "$PATCH_INGRESS_NGINX_RAW")"

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
  local started="$(date -Iseconds)"
  CURRENT_STEP="ingress-controller"
  CURRENT_STEP_STARTED="$started"

  if [ "$PATCH_INGRESS_NGINX" != "true" ]; then
    emit_event config ingress-controller skipped "$started" "Global ingress-nginx changes were not requested"
    return 0
  fi

  emit_event config ingress-controller started "$started" "Applying explicitly requested ingress-nginx controller settings"
  kubectl get namespace ingress-nginx >/dev/null
  kubectl -n ingress-nginx get configmap ingress-nginx-controller >/dev/null
  kubectl -n ingress-nginx get service ingress-nginx-controller >/dev/null
  kubectl -n ingress-nginx patch configmap ingress-nginx-controller --type merge \
    -p '{"data":{"ssl-protocols":"TLSv1.3","hsts":"true","server-tokens":"false","allow-snippet-annotations":"true"}}' >/dev/null
  kubectl -n ingress-nginx patch service ingress-nginx-controller --type merge \
    -p '{"spec":{"externalTrafficPolicy":"Cluster"}}' >/dev/null
  emit_event config ingress-controller succeeded "$started" "Requested ingress-nginx controller settings applied"
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

  [ -n "$policy_dep" ] || { echo "ERROR: policy deployment was not found" >&2; return 1; }
  [ -n "$signer_dep" ] || { echo "ERROR: signer deployment was not found" >&2; return 1; }

  kubectl -n "$NAMESPACE" set env "deploy/${policy_dep}" --from=configmap/tsa-runtime-config >/dev/null
  if [ "$TRUST_MATERIALS_AVAILABLE" = "true" ]; then
    kubectl -n "$NAMESPACE" set env "deploy/${policy_dep}" TSA_TRUST_MATERIAL_SECRET=tsa-trust-materials >/dev/null
  fi

  kubectl -n "$NAMESPACE" set env "deploy/${signer_dep}" --from=configmap/tsa-runtime-config >/dev/null
  if [ "$TRUST_MATERIALS_AVAILABLE" = "true" ]; then
    kubectl -n "$NAMESPACE" set env "deploy/${signer_dep}" TSA_TRUST_MATERIAL_SECRET=tsa-trust-materials >/dev/null
  fi

  emit_event config rollout succeeded "$started" "Runtime configuration propagated to TSA workloads"
}


run_runtime_acceptance() {
  local started="$(date -Iseconds)"
  CURRENT_STEP="runtime-health"
  CURRENT_STEP_STARTED="$started"
  emit_event test runtime-health started "$started" "Checking Kubernetes Service readiness"

  RUNTIME_EVIDENCE_DIR="$(mktemp -d -t tsa-runtime-evidence-XXXXXX)"
  chmod 700 "$RUNTIME_EVIDENCE_DIR"
  set +e
  bash "$BDD_RUNNER" "$NAMESPACE" "$DOMAIN" "$KUBE" "$CERT_PATH" "$RUNTIME_EVIDENCE_DIR"
  local health_rc="$?"
  set -e

  # Persist only the compact acceptance evidence. Full Pod/Service/Event snapshots stay
  # in the protected temporary directory and are used only for local diagnostics. Using
  # an apply-style update here would copy the entire ConfigMap into the
  # kubectl.kubernetes.io/last-applied-configuration annotation and can exceed Kubernetes'
  # 256 KiB annotation limit even when the ConfigMap data itself is valid.
  local evidence_args=(kubectl -n "$NAMESPACE" create configmap tsa-runtime-evidence)
  local evidence_file evidence_size evidence_total=0
  for evidence_file in runtime-health.json runtime-health.md bdd-results.json bdd-results.md service-readiness.tsv; do
    if [ -f "$RUNTIME_EVIDENCE_DIR/$evidence_file" ]; then
      evidence_size="$(wc -c < "$RUNTIME_EVIDENCE_DIR/$evidence_file")"
      evidence_total=$((evidence_total + evidence_size))
      evidence_args+=(--from-file="$evidence_file=$RUNTIME_EVIDENCE_DIR/$evidence_file")
    fi
  done

  # Runtime evidence persistence is best-effort and never changes the Service-readiness
  # result. ConfigMaps have an overall object-size limit; keep sufficient headroom for
  # object metadata and serialization overhead.
  local evidence_status="stored"
  if [ "$evidence_total" -gt 786432 ]; then
    evidence_status="skipped: compact evidence exceeds 768 KiB (${evidence_total} bytes)"
  else
    set +e
    kubectl -n "$NAMESPACE" delete configmap tsa-runtime-evidence --ignore-not-found --wait=true >/dev/null 2>&1
    "${evidence_args[@]}" >/dev/null 2>&1
    local evidence_rc="$?"
    if [ "$evidence_rc" -eq 0 ]; then
      kubectl -n "$NAMESPACE" label configmap tsa-runtime-evidence \
        app.kubernetes.io/name=tsa-runtime-evidence \
        app.kubernetes.io/part-of=tsa \
        --overwrite >/dev/null 2>&1
      evidence_rc="$?"
    fi
    set -e
    if [ "$evidence_rc" -ne 0 ]; then
      evidence_status="warning: evidence ConfigMap could not be persisted"
    fi
  fi

  if [ "$health_rc" -ne 0 ]; then
    emit_event test runtime-health failed "$started" "Kubernetes Service readiness failed; evidence status: ${evidence_status}"
    return "$health_rc"
  fi

  emit_event test runtime-health succeeded "$started" "Kubernetes Services have ready backends; evidence status: ${evidence_status}"
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
  if [ -n "$CORE_STDOUT_FILE" ]; then rm -f "$CORE_STDOUT_FILE"; fi
  if [ -n "$RUNTIME_EVIDENCE_DIR" ]; then rm -rf "$RUNTIME_EVIDENCE_DIR"; fi
  exit "$exit_code"
}
trap rollback_on_error EXIT

for bin in kubectl jq awk; do
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
set +e
bash "$CORE" "$@" | tee "$CORE_STDOUT_FILE"
core_rc="${PIPESTATUS[0]}"
set -e
if [ "$core_rc" -ne 0 ]; then
  echo "ERROR: TSA deploy:core failed with exit code ${core_rc}" >&2
  exit "$core_rc"
fi
emit_event deploy core succeeded "$started" "TSA deployment workflow finished"

ensure_namespace_baseline
propagate_runtime_config
run_runtime_acceptance
publish_status_contract

trap - EXIT
if [ -n "$CORE_STDOUT_FILE" ]; then rm -f "$CORE_STDOUT_FILE"; fi
if [ -n "$RUNTIME_EVIDENCE_DIR" ]; then rm -rf "$RUNTIME_EVIDENCE_DIR"; fi
DURATION="$(( $(date +%s) - START_EPOCH ))"
echo "DEPLOYMENT_DURATION_SECONDS=${DURATION}"
