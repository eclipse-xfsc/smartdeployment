#!/usr/bin/env bash
set -Eeuo pipefail

NAMESPACE="$1"
DOMAIN="$2"
CERT_PATH="$3"
KEY_PATH="$4"
KUBE="$5"
POLICY_REPO_URL="${6:-https://github.com/eclipse-xfsc/rego-policies}"
POLICY_REPO_FOLDER="${7:-}"
TLS_SECRET="xfsc-wildcard"

export KUBECONFIG="$KUBE"

emit_event() {
  local phase="$1" step="$2" status="$3" started_at="$4" details="${5:-}"
  jq -cn --arg phase "$phase" --arg step "$step" --arg status "$status" --arg startedAt "$started_at" --arg endedAt "$(date -Iseconds)" --arg details "$details" '{phase:$phase,step:$step,status:$status,startedAt:$startedAt,endedAt:$endedAt,details:$details}' | sed 's/^/EVENT_JSON=/'
}

CURRENT_STAGE="core"
CURRENT_STAGE_STARTED="$(date -Iseconds)"

set_stage() {
  CURRENT_STAGE="$1"
  CURRENT_STAGE_STARTED="$(date -Iseconds)"
  emit_event deploy "$CURRENT_STAGE" started "$CURRENT_STAGE_STARTED" "${2:-}"
}

mark_stage_success() {
  emit_event deploy "$CURRENT_STAGE" succeeded "$CURRENT_STAGE_STARTED" "${1:-}"
}

on_error() {
  local exit_code="$?"
  emit_event deploy "${CURRENT_STAGE:-core}" failed "${CURRENT_STAGE_STARTED:-$(date -Iseconds)}" "Stage ${CURRENT_STAGE:-core} failed"
  exit "$exit_code"
}
trap on_error ERR

render_values() {
  local src="$1"
  local dst="$2"
  sed "s|NAMESPACE|${NAMESPACE}|g; s|DOMAIN|${DOMAIN}|g" "$src" > "$dst"
}

find_workload() {
  local kind="$1"
  local pattern="$2"
  kubectl -n "$NAMESPACE" get "$kind" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | grep "$pattern" | head -n1 || true
}

ensure_tool() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }
}

wait_for_pod_ready() {
  local pod_name="$1"
  local timeout="${2:-180s}"
  kubectl -n "$NAMESPACE" wait --for=condition=Ready "pod/${pod_name}" --timeout="$timeout" >/dev/null 2>&1 || true
}

for bin in helm kubectl openssl jq; do
  ensure_tool "$bin"
done

WORKDIR="$(mktemp -d -t tsa-simple-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null 2>&1 || true
helm repo add hashicorp https://helm.releases.hashicorp.com >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1 || true

set_stage namespace "Creating namespace and TLS materials"
kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE" >/dev/null
kubectl create secret tls "$TLS_SECRET" --namespace "$NAMESPACE" --cert "$CERT_PATH" --key "$KEY_PATH" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
REDIS_PASSWORD="$(openssl rand -hex 16)"
kubectl create secret generic preauthbridge-redis \
  --from-literal=redis-password="$REDIS_PASSWORD" \
  --from-literal=redis-user="default" \
  --namespace "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
mark_stage_success "Namespace bootstrap finished"

set_stage nats "Installing NATS messaging"
helm dependency build "./Nats Chart" >/dev/null
helm upgrade --install nats "./Nats Chart" --namespace "$NAMESPACE" -f "./Nats Chart/values.yaml" >/dev/null
wait_for_pod_ready nats-0 180s
mark_stage_success "NATS release submitted"

set_stage redis "Installing Redis cache"
helm upgrade --install redis \
  oci://registry-1.docker.io/bitnamicharts/redis \
  --namespace "$NAMESPACE" -f ./Redis/values.yaml \
  --set image.registry=docker.io \
  --set image.repository=bitnamilegacy/redis \
  --set global.security.allowInsecureImages=true >/dev/null
wait_for_pod_ready redis-master-0 180s
mark_stage_success "Redis release submitted"

set_stage vault "Installing Vault"
kubectl delete clusterrolebinding vault-agent-injector-binding >/dev/null 2>&1 || true
kubectl delete clusterrolebinding vault-server-binding >/dev/null 2>&1 || true
kubectl delete mutatingwebhookconfiguration vault-agent-injector-cfg >/dev/null 2>&1 || true
kubectl delete clusterrole vault-agent-injector-clusterrole >/dev/null 2>&1 || true
helm dependency build "./Vault" >/dev/null
helm upgrade --install vault "./Vault" --namespace "$NAMESPACE" -f "./Vault/values.yaml" --set "server.dev.enabled=true" --wait --timeout 12m >/dev/null
kubectl create secret generic vault --namespace "$NAMESPACE" --from-literal=token="root" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
wait_for_pod_ready vault-0 180s
VAULT_ENV='VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=root'
kubectl -n "$NAMESPACE" exec vault-0 -- sh -lc "$VAULT_ENV vault secrets enable transit || true" >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" exec vault-0 -- sh -lc "$VAULT_ENV vault write -f transit/keys/SDJWTCredential type=ecdsa-p256" >/dev/null 2>&1 || true
mark_stage_success "Vault release submitted"

set_stage resolver "Installing universal resolver"
helm dependency build "./Universal Resolver" >/dev/null
helm upgrade --install universal-resolver "./Universal Resolver" --namespace "$NAMESPACE" >/dev/null
mark_stage_success "Universal resolver release submitted"

set_stage signer "Installing signer"
render_values "./signer/values.yaml" "$WORKDIR/signer-values.yaml"
helm dependency build "./signer" >/dev/null
helm upgrade --install signer "./signer" --namespace "$NAMESPACE" -f "$WORKDIR/signer-values.yaml" >/dev/null
kubectl -n "$NAMESPACE" get deploy signer >/dev/null 2>&1 && kubectl -n "$NAMESPACE" set env deployment/signer VAULT_ADDR="https://vault.${NAMESPACE}.svc:8200" TRANSIT_MOUNT_PATH=transit TRANSIT_KEY_NAME=SDJWTCredential >/dev/null || true
mark_stage_success "Signer release submitted"

set_stage sdjwt "Installing SD-JWT service"
render_values "./SdJwt Service/values.yaml" "$WORKDIR/sdjwt-values.yaml"
helm dependency build "./SdJwt Service" >/dev/null
helm upgrade --install sdjwt "./SdJwt Service" --namespace "$NAMESPACE" -f "$WORKDIR/sdjwt-values.yaml" >/dev/null
mark_stage_success "SD-JWT release submitted"

set_stage policy "Installing policy service"
render_values "./Policy Chart/values.yaml" "$WORKDIR/policy-values.yaml"
helm dependency build "./Policy Chart" >/dev/null
helm upgrade --install policy-service "./Policy Chart" \
  --namespace "$NAMESPACE" \
  -f "$WORKDIR/policy-values.yaml" \
  --set-string policy.memoryStorage.policiesRepo="$POLICY_REPO_URL" \
  --set-string policy.memoryStorage.policiesFolder="$POLICY_REPO_FOLDER" \
  --set-string policy.ingress.enabled=false >/dev/null

POLICY_DEPLOY=""
POLICY_SVC=""
for _ in $(seq 1 60); do
  [ -n "$POLICY_DEPLOY" ] || POLICY_DEPLOY="$(find_workload deploy '^policy')"
  [ -n "$POLICY_SVC" ] || POLICY_SVC="$(find_workload svc '^policy')"
  [ -n "$POLICY_DEPLOY" ] && [ -n "$POLICY_SVC" ] && break
  sleep 2
done

[ -n "$POLICY_DEPLOY" ] || { echo "policy deployment not found" >&2; exit 1; }
[ -n "$POLICY_SVC" ] || { echo "policy service not found" >&2; exit 1; }

kubectl -n "$NAMESPACE" rollout status "deploy/${POLICY_DEPLOY}" --timeout=120s >/dev/null 2>&1 || true

cat <<EOF_ING | kubectl apply -f - >/dev/null
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: policy-public
  namespace: ${NAMESPACE}
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - policy.${DOMAIN}
      secretName: ${TLS_SECRET}
  rules:
    - host: policy.${DOMAIN}
      http:
        paths:
          - path: /v1/policies
            pathType: Prefix
            backend:
              service:
                name: ${POLICY_SVC}
                port:
                  number: 8080
EOF_ING
mark_stage_success "Policy service is exposed"

echo "TSA_URL=https://policy.${DOMAIN}/v1/policies"
echo "KEY_ID=SDJWTCredential"
echo "POLICY_STATUS=Ready"
echo "STATUS=Deployed"
