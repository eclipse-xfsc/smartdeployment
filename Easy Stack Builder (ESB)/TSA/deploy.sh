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

export KUBECONFIG="$KUBE"
SERVICE_ACCOUNT="tsa-runtime"
ROLE_NAME="tsa-runtime-role"
REALM_NAME="tsa-${NAMESPACE}"
CLIENT_SECRET=""
START_EPOCH="$(date +%s)"
CURRENT_STEP="deploy"
CURRENT_STEP_STARTED="$(date -Iseconds)"

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

render_values() {
  local src="$1" dst="$2"
  sed "s|NAMESPACE|${NAMESPACE}|g; s|DOMAIN|${DOMAIN}|g" "$src" > "$dst"
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

deploy_auth_server() {
  local started="$(date -Iseconds)"
  local values_file
  CURRENT_STEP="auth-server"
  CURRENT_STEP_STARTED="$started"
  emit_event deploy auth-server started "$started" "Deploying Keycloak-backed auth-server"
  values_file="$(mktemp)"
  sed "s|auth-cloud-wallet.DOMAIN|auth-server.${DOMAIN}|g; s|DOMAIN|${DOMAIN}|g" "$DIR/Keycloak/values.yaml" > "$values_file"
  helm dependency build "$DIR/Keycloak" >/dev/null 2>&1 || true
  helm upgrade --install auth-server "$DIR/Keycloak" \
    --namespace "$NAMESPACE" \
    -f "$values_file" \
    --set keycloak.auth.adminUser=admin \
    --set keycloak.image.registry=docker.io \
    --set keycloak.image.repository=bitnamilegacy/keycloak \
    --set global.security.allowInsecureImages=true >/dev/null
  rm -f "$values_file"
  emit_event deploy auth-server succeeded "$started" "auth-server is deployed"
}

deploy_key_server() {
  local started="$(date -Iseconds)"
  local values_file
  CURRENT_STEP="key-server"
  CURRENT_STEP_STARTED="$started"
  emit_event deploy key-server started "$started" "Deploying key-server compatibility signer"
  values_file="$(mktemp)"
  render_values "$DIR/signer/values.yaml" "$values_file"
  printf '\nnameOverride: key-server\n' >> "$values_file"
  helm dependency build "$DIR/signer" >/dev/null 2>&1 || true
  helm upgrade --install key-server "$DIR/signer" --namespace "$NAMESPACE" -f "$values_file" >/dev/null
  rm -f "$values_file"
  cat <<EOF_ING | kubectl -n "$NAMESPACE" apply -f - >/dev/null
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: key-server-public
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - key-server.${DOMAIN}
      secretName: xfsc-wildcard
  rules:
    - host: key-server.${DOMAIN}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: key-server
                port:
                  number: 8080
EOF_ING
  emit_event deploy key-server succeeded "$started" "key-server compatibility endpoint is deployed"
}


reconcile_keycloak() {
  local started="$(date -Iseconds)"
  local kc_pod="" pass="" oidc_cid="" ready=""
  CURRENT_STEP="identity"
  CURRENT_STEP_STARTED="$started"
  emit_event identity reconcile started "$started" "Creating TSA Keycloak realm and authentication clients"

  for _ in $(seq 1 36); do
    kc_pod="$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=keycloak -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    pass="$(kubectl -n "$NAMESPACE" get secret keycloak-init-secrets -o json 2>/dev/null | jq -r '.data.password // .data["admin-password"] // empty' | base64 -d 2>/dev/null || true)"
    if [ -n "$kc_pod" ] && [ -n "$pass" ] && kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "mkdir -p /tmp/kcadm && HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh config credentials --config /tmp/kcadm/config --server http://localhost:8080/ --realm master --user admin --password '$pass'" >/dev/null 2>&1; then
      ready="yes"
      break
    fi
    sleep 5
  done

  if [ -z "$ready" ]; then
    echo "WARN: auth-server Keycloak admin API is not ready yet; keeping the namespace for inspection" >&2
    emit_event identity reconcile failed "$started" "auth-server Keycloak admin API is not ready yet; continuing without realm bootstrap"
    return 0
  fi

  if ! kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh get realms/${REALM_NAME} --config /tmp/kcadm/config" >/dev/null 2>&1; then
    kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh create realms --config /tmp/kcadm/config -s realm='${REALM_NAME}' -s enabled=true" >/dev/null 2>&1 || {
      emit_event identity reconcile failed "$started" "Failed to create TSA realm ${REALM_NAME}; continuing"
      return 0
    }
  fi
  for client_name in ssi-oidc ssi-siop; do
    if ! kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh get clients -r '${REALM_NAME}' -q clientId='${client_name}' --config /tmp/kcadm/config" | jq -e 'length > 0' >/dev/null 2>&1; then
      kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh create clients -r '${REALM_NAME}' --config /tmp/kcadm/config -s clientId='${client_name}' -s name='${client_name}' -s enabled=true -s protocol=openid-connect -s publicClient=false -s clientAuthenticatorType=client-secret -s standardFlowEnabled=true -s directAccessGrantsEnabled=true" >/dev/null 2>&1 || true
    fi
  done
  for role_name in verifier operator; do
    kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh create roles -r '${REALM_NAME}' --config /tmp/kcadm/config -s name='${role_name}'" >/dev/null 2>&1 || true
  done
  oidc_cid="$(kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh get clients -r '${REALM_NAME}' -q clientId='ssi-oidc' --config /tmp/kcadm/config" | jq -r '.[0].id // empty')"
  if [ -n "$oidc_cid" ]; then
    CLIENT_SECRET="$(kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh get clients/${oidc_cid}/client-secret -r '${REALM_NAME}' --config /tmp/kcadm/config" | jq -r '.value // empty')"
  fi
  kubectl create secret generic tsa-keycloak-client -n "$NAMESPACE" --from-literal=realm="$REALM_NAME" --from-literal=client-id='ssi-oidc' --from-literal=client-secret="$CLIENT_SECRET" --from-literal=keycloak-url="https://auth-server.${DOMAIN}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null 2>&1 || true
  emit_event identity reconcile succeeded "$started" "TSA realm ${REALM_NAME} and clients are ready"
}

health_checks() {
  local started="$(date -Iseconds)"
  local aas_auth_url="https://auth-server.${DOMAIN}"
  local key_server_url="https://key-server.${DOMAIN}"
  local status_json
  CURRENT_STEP="observability"
  CURRENT_STEP_STARTED="$started"
  emit_event observability probe started "$started" "Running auth-server and key-server smoke checks"
  curl -kfsS --max-time 15 "$aas_auth_url/realms/${REALM_NAME}/.well-known/openid-configuration" >/dev/null 2>&1 || true
  curl -kfsS --max-time 15 "$key_server_url/" >/dev/null 2>&1 || true
  status_json="$(jq -cn --arg aasAuthUrl "$aas_auth_url" --arg keyServerUrl "$key_server_url" --arg status 'Deployed' '{aasAuthUrl:$aasAuthUrl,keyServerUrl:$keyServerUrl,status:$status}')"
  kubectl create configmap tsa-deployment-status -n "$NAMESPACE" --from-literal=status.json="$status_json" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  echo "AAS_AUTH_URL=$aas_auth_url"
  echo "KEY_SERVER_URL=$key_server_url"
  echo "STATUS=Deployed"
  emit_event observability probe succeeded "$started" "Smoke checks finished and status contract stored"
}

rollback_on_error() {
  local exit_code="$?"
  if [ "$exit_code" -ne 0 ]; then
    local started="$(date -Iseconds)"
    emit_event deploy rollback skipped "$started" "Deployment failed; preserving namespace for inspection"
  fi
  exit "$exit_code"
}
trap rollback_on_error EXIT

for bin in kubectl helm jq curl; do
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

started="$(date -Iseconds)"
CURRENT_STEP="core"
CURRENT_STEP_STARTED="$started"
emit_event deploy core started "$started" "Executing original TSA deployment workflow"
bash "$CORE" "$@"
emit_event deploy core succeeded "$started" "Original TSA deployment workflow finished"

ensure_namespace_baseline
deploy_auth_server
deploy_key_server
reconcile_keycloak
health_checks

trap - EXIT
DURATION="$(( $(date +%s) - START_EPOCH ))"
echo "DEPLOYMENT_DURATION_SECONDS=${DURATION}"
