#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="$1"
DOMAIN="$2"
CERT_PATH="$3"
KEY_PATH="$4"
KUBE="$5"
POLICY_REPO_URL="${6:-https://github.com/eclipse-xfsc/rego-policies}"
POLICY_REPO_FOLDER="${7:-}"
TLS_SECRET="xfsc-wildcard"

export KUBECONFIG="$KUBE"

render_values() {
  local src="$1"
  local dst="$2"
  sed "s|NAMESPACE|${NAMESPACE}|g; s|DOMAIN|${DOMAIN}|g" "$src" > "$dst"
}

find_workload() {
  local kind="$1"
  local pattern="$2"
  kubectl -n "$NAMESPACE" get "$kind" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | grep "$pattern" | head -n1 || true
}

ensure_tool() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }
}

ensure_tool helm
ensure_tool kubectl
ensure_tool curl
ensure_tool openssl

WORKDIR="$(mktemp -d -t tsa-simple-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null 2>&1 || true
helm repo add hashicorp https://helm.releases.hashicorp.com >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1 || true

kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"

kubectl create secret tls "$TLS_SECRET" --namespace "$NAMESPACE" --cert "$CERT_PATH" --key "$KEY_PATH" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

REDIS_PASSWORD="$(openssl rand -hex 16)"
kubectl create secret generic preauthbridge-redis \
  --from-literal=redis-password="$REDIS_PASSWORD" \
  --from-literal=redis-user="default" \
  --namespace "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

helm dependency build "./Nats Chart" >/dev/null
helm upgrade --install nats "./Nats Chart" --namespace "$NAMESPACE" -f "./Nats Chart/values.yaml" --wait

helm upgrade --install redis \
  oci://registry-1.docker.io/bitnamicharts/redis \
  --namespace "$NAMESPACE" -f ./Redis/values.yaml \
  --set image.registry=docker.io \
  --set image.repository=bitnamilegacy/redis \
  --set global.security.allowInsecureImages=true \
  --wait

kubectl delete clusterrolebinding vault-agent-injector-binding >/dev/null 2>&1 || true
kubectl delete clusterrolebinding vault-server-binding >/dev/null 2>&1 || true
kubectl delete mutatingwebhookconfiguration vault-agent-injector-cfg >/dev/null 2>&1 || true
kubectl delete clusterrole vault-agent-injector-clusterrole >/dev/null 2>&1 || true
helm dependency build "./Vault" >/dev/null
helm upgrade --install vault "./Vault" --namespace "$NAMESPACE" -f "./Vault/values.yaml" --set "server.dev.enabled=true" --wait

kubectl create secret generic vault --namespace "$NAMESPACE" --from-literal=token="root" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$NAMESPACE" wait --for=condition=ready pod vault-0 --timeout=10m >/dev/null
VAULT_ENV='VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=root'
kubectl -n "$NAMESPACE" exec vault-0 -- sh -lc "$VAULT_ENV vault secrets enable transit || true" >/dev/null
kubectl -n "$NAMESPACE" exec vault-0 -- sh -lc "$VAULT_ENV vault write -f transit/keys/SDJWTCredential type=ecdsa-p256" >/dev/null

helm dependency build "./Universal Resolver" >/dev/null
helm upgrade --install universal-resolver "./Universal Resolver" --namespace "$NAMESPACE" --wait

render_values "./signer/values.yaml" "$WORKDIR/signer-values.yaml"
helm dependency build "./signer" >/dev/null
helm upgrade --install signer "./signer" --namespace "$NAMESPACE" -f "$WORKDIR/signer-values.yaml" --wait
kubectl -n "$NAMESPACE" set env deployment/signer VAULT_ADDR="https://vault.${NAMESPACE}.svc:8200" TRANSIT_MOUNT_PATH=transit TRANSIT_KEY_NAME=SDJWTCredential >/dev/null

render_values "./SdJwt Service/values.yaml" "$WORKDIR/sdjwt-values.yaml"
helm dependency build "./SdJwt Service" >/dev/null
helm upgrade --install sdjwt "./SdJwt Service" --namespace "$NAMESPACE" -f "$WORKDIR/sdjwt-values.yaml" --wait

render_values "./Policy Chart/values.yaml" "$WORKDIR/policy-values.yaml"
helm dependency build "./Policy Chart" >/dev/null
helm upgrade --install policy-service "./Policy Chart" \
  --namespace "$NAMESPACE" \
  -f "$WORKDIR/policy-values.yaml" \
  --set-string policy.memoryStorage.policiesRepo="$POLICY_REPO_URL" \
  --set-string policy.memoryStorage.policiesFolder="$POLICY_REPO_FOLDER" \
  --set-string policy.ingress.enabled=false \
  --wait

POLICY_DEPLOY="$(find_workload deploy '^policy')"
[ -n "$POLICY_DEPLOY" ] || { echo "policy deployment not found" >&2; exit 1; }
kubectl -n "$NAMESPACE" rollout status "deploy/${POLICY_DEPLOY}" --timeout=10m >/dev/null
POLICY_SVC="$(find_workload svc '^policy')"
[ -n "$POLICY_SVC" ] || { echo "policy service not found" >&2; exit 1; }

cat <<EOF_ING | kubectl apply -f - >/dev/null
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: policy-public
  namespace: ${NAMESPACE}
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
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

echo "TSA_URL=https://policy.${DOMAIN}/v1/policies"
echo "KEY_ID=SDJWTCredential"
echo "POLICY_STATUS=Ready"
echo "STATUS=Deployed"
