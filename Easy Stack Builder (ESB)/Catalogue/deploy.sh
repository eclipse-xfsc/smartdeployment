#!/usr/bin/env bash
set -euo pipefail

#----------------------------------------
# Functions
#----------------------------------------
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

usage() {
  echo "Usage: $0 <kubeconfig> <private_key_path> <crt_path> <domain> <path> <admin_user> <admin_pass> <new_user> <new_pass>"
  echo "Optional: set CA_BUNDLE_FILE=/path/to/ca-bundle.pem for private/internal CAs."
  exit 1
}

#----------------------------------------
# Input validation
#----------------------------------------
if [ "$#" -ne 9 ]; then
  usage
fi

KUBECONFIG_FILE="$1"
KEY_FILE="$2"
CRT_FILE="$3"
DOMAIN="$4"
URL_PATH="$5"
ADMIN_USER="$6"
ADMIN_PASS="$7"
NEW_USER="$8"
NEW_PASS="$9"
export KUBECONFIG="$KUBECONFIG_FILE"

# Verified TLS is the default. For private/internal PKI, provide a CA bundle
# through CA_BUNDLE_FILE instead of disabling certificate verification.
CURL_TLS_ARGS=(--silent --show-error)
if [[ -n "${CA_BUNDLE_FILE:-}" ]]; then
  if [[ ! -r "$CA_BUNDLE_FILE" ]]; then
    log "❌ CA bundle is not readable: $CA_BUNDLE_FILE"
    exit 1
  fi
  CURL_TLS_ARGS+=(--cacert "$CA_BUNDLE_FILE")
fi

# cleanup local helm artifacts
if [ -f Chart.lock ]; then
  rm Chart.lock
  log "✅ Removed Chart.lock"
fi

if [ -d charts ]; then
  rm -rf charts
  log "✅ Removed charts/ directory"
fi

#----------------------------------------
# Check dependencies
#----------------------------------------
for cmd in kubectl helm jq curl openssl; do
  if ! command -v "$cmd" &>/dev/null; then
    log "❌ '$cmd' is not installed. Please install it and retry."
    exit 1
  else
    log "✅ Found '$cmd'"
  fi
done

#----------------------------------------
# Verify ingress-nginx is installed
#----------------------------------------
log "ℹ Checking ingress-nginx..."
if ! kubectl get ns ingress-nginx &>/dev/null; then
  log "❌ ingress-nginx namespace not found. Please install ingress-nginx manually and retry."
  exit 1
fi
log "✅ ingress-nginx is installed"

#----------------------------------------
# Wait for ingress External-IP
#----------------------------------------
log "ℹ Waiting for ingress-nginx External-IP..."
while true; do
  EX_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
  if [[ -n "$EX_IP" && "$EX_IP" != "<pending>" ]]; then
    log "✅ ingress-nginx External-IP: $EX_IP"
    break
  fi
  log "⏳ External-IP pending, retrying in 5s..."
  sleep 5
done

#----------------------------------------
# Generate and validate namespace from path
#----------------------------------------
NAMESPACE="fed-cat-${URL_PATH}"
log "ℹ Using namespace: $NAMESPACE"

if kubectl get ns "$NAMESPACE" &>/dev/null; then
  log "⚠ Namespace '$NAMESPACE' already exists. Showing existing deployment info and exiting."

  # 1. External‐IP
  EX_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
  echo "🔹 ingress External-IP: $EX_IP"

  # 2. URLs
  echo "🔹 fc-service URL:      https://${DOMAIN}/${URL_PATH}/fcservice"
  echo "🔹 Keycloak URL:        https://${DOMAIN}/${URL_PATH}/key-server"

  TOKEN_URL="https://${DOMAIN}/${URL_PATH}/key-server/realms/master/protocol/openid-connect/token"
  ACCESS_TOKEN=$(curl "${CURL_TLS_ARGS[@]}" \
    -X POST "$TOKEN_URL" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "client_id=admin-cli" \
    -d "username=${ADMIN_USER}" \
    -d "password=${ADMIN_PASS}" \
    -d "grant_type=password" | jq -r .access_token)

  REALM_API="https://${DOMAIN}/${URL_PATH}/key-server/admin/realms/gaia-x"
  CLIENT_ID=$(curl "${CURL_TLS_ARGS[@]}" \
    -X GET "${REALM_API}/clients?clientId=federated-catalogue" \
    -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.[0].id')
  EXISTING_SECRET=$(curl "${CURL_TLS_ARGS[@]}" \
    -X GET "${REALM_API}/clients/${CLIENT_ID}/client-secret" \
    -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r .value)

  echo "🔹 Client Secret:       $EXISTING_SECRET"

  exit 0
fi

#----------------------------------------
# Prepare temporary values file
#----------------------------------------
TMP_VALUES="$(mktemp /tmp/values.XXXXXX.yaml)"
trap 'rm -f "$TMP_VALUES"' EXIT

cp values.yaml "$TMP_VALUES"
chmod 600 "$TMP_VALUES"

# Generate per-deployment credentials; no database or graph-store passwords are
# committed to values.yaml or reused between independent deployments.
POSTGRES_ADMIN_PASSWORD="$(openssl rand -hex 24)"
KEYCLOAK_DB_PASSWORD="$(openssl rand -hex 24)"
NEO4J_PASSWORD="$(openssl rand -hex 24)"

log "ℹ Replacing placeholders in $TMP_VALUES"
sed -i \
  -e "s|\[domain-name\]|${DOMAIN}|g" \
  -e "s|\[path\]|${URL_PATH}|g" \
  -e "s|\[namespace\]|${NAMESPACE}|g" \
  -e "s|\[Keycloak_Admin_Username\]|${ADMIN_USER}|g" \
  -e "s|\[Keycloak_Admin_Password\]|${ADMIN_PASS}|g" \
  -e "s|\[Postgres_Admin_Password\]|${POSTGRES_ADMIN_PASSWORD}|g" \
  -e "s|\[Keycloak_DB_Password\]|${KEYCLOAK_DB_PASSWORD}|g" \
  -e "s|\[Neo4j_Password\]|${NEO4J_PASSWORD}|g" \
  "$TMP_VALUES"
log "✅ Placeholders replaced in $TMP_VALUES"
#----------------------------------------
# Helm dependency build & install
#----------------------------------------
log "ℹ Running: helm dependency build"
helm dependency build . --kubeconfig "$KUBECONFIG"

log "ℹ Installing fc-service via Helm"
helm install fc-service . \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --kubeconfig "$KUBECONFIG" \
  -f "$TMP_VALUES"
log "✅ fc-service Helm release deployed"

#----------------------------------------
# Replace fc-neo4j service
#----------------------------------------
log "ℹ Replacing fc-neo4j-db-lb-neo4j Service"
kubectl delete svc fc-neo4j-db-lb-neo4j -n "$NAMESPACE" --ignore-not-found
cat > /tmp/fc-neo4j-db-lb-neo4j.yaml <<EOF
apiVersion: v1
kind: Service
metadata:
  name: fc-neo4j-db-lb-neo4j
  namespace: ${NAMESPACE}
  labels:
    app: fc-neo4j-db
    app.kubernetes.io/managed-by: Helm
    helm.neo4j.com/neo4j.name: fc-neo4j-db
    helm.neo4j.com/service: neo4j
spec:
  type: ClusterIP
  ports:
    - name: http
      protocol: TCP
      port: 7474
      targetPort: 7474
    - name: https
      protocol: TCP
      port: 7473
      targetPort: 7473
    - name: tcp-bolt
      protocol: TCP
      port: 7687
      targetPort: 7687
  selector:
    app: fc-neo4j-db
    helm.neo4j.com/clustering: "false"
    helm.neo4j.com/neo4j.loadbalancer: include
EOF
kubectl apply -f /tmp/fc-neo4j-db-lb-neo4j.yaml
log "✅ Custom fc-neo4j service applied"

#----------------------------------------
# Create TLS secret
#----------------------------------------
log "ℹ Creating TLS secret 'certificates'"
kubectl create secret tls certificates \
  --namespace "$NAMESPACE" \
  --key "$KEY_FILE" \
  --cert "$CRT_FILE" \
  --kubeconfig "$KUBECONFIG"
log "✅ TLS secret created"

#----------------------------------------
# Wait for Keycloak StatefulSet to be ready (10m)
#----------------------------------------
log "ℹ Waiting for Keycloak StatefulSet to be ready (max 10m)..."
if ! kubectl rollout status statefulset/fc-keycloak \
     -n "$NAMESPACE" \
     --timeout=600s; then
  log "❌ Timeout waiting for Keycloak. Pod statuses:"
  kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=fc-keycloak -o wide
  exit 1
fi
log "✅ Keycloak StatefulSet is ready"

#----------------------------------------
# Wait for HTTP endpoint
#----------------------------------------
log "ℹ Waiting for Keycloak HTTP endpoint to respond..."
until curl "${CURL_TLS_ARGS[@]}" -o /dev/null -w "%{http_code}" \
  "https://${DOMAIN}/${URL_PATH}/key-server/realms/master" | grep -q '^200$'; do
  log "⏳ Keycloak not ready yet, retrying in 5s..."
  sleep 5
done
log "✅ Keycloak HTTP endpoint is up"

#----------------------------------------
# Keycloak API: obtain token
#----------------------------------------
REALMNAME="gaia-x"
CLIENT_NAME="federated-catalogue"
CLIENT_ROLE="Ro-MU-CA"
ENCODED_PASS=$(jq -rn --arg x "$ADMIN_PASS" '$x|@uri')
TOKEN_URL="https://${DOMAIN}/${URL_PATH}/key-server/realms/master/protocol/openid-connect/token"

log "ℹ Requesting access token..."
TOKEN_RESP=$(curl "${CURL_TLS_ARGS[@]}" -w "HTTPSTATUS:%{http_code}" -X POST "$TOKEN_URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=admin-cli" \
  -d "username=${ADMIN_USER}" \
  -d "password=${ENCODED_PASS}" \
  -d "grant_type=password")
TOKEN_BODY=$(echo "$TOKEN_RESP" | sed -e 's/HTTPSTATUS:.*//g')
TOKEN_STATUS=$(echo "$TOKEN_RESP" | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')

if [[ "$TOKEN_STATUS" -ne 200 ]]; then
  log "❌ Failed to get token (HTTP $TOKEN_STATUS)"
  exit 1
fi
ACCESS_TOKEN=$(echo "$TOKEN_BODY" | jq -r .access_token)
log "✅ Access token received"

#----------------------------------------
# Keycloak API: remove passwordPolicy
#----------------------------------------
REALM_API="https://${DOMAIN}/${URL_PATH}/key-server/admin/realms/$REALMNAME"
REALM_RESP=$(curl "${CURL_TLS_ARGS[@]}" -w "HTTPSTATUS:%{http_code}" -X GET "$REALM_API" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json")
REALM_BODY=$(echo "$REALM_RESP" | sed -e 's/HTTPSTATUS:.*//g')
REALM_STATUS=$(echo "$REALM_RESP" | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')

if [[ "$REALM_STATUS" -ne 200 ]]; then
  log "❌ Failed to fetch realm settings (HTTP $REALM_STATUS)"
  exit 1
fi
REALM_NO_POLICY=$(echo "$REALM_BODY" | jq '.passwordPolicy = ""')
UPDATE_RESP=$(curl "${CURL_TLS_ARGS[@]}" -w "HTTPSTATUS:%{http_code}" -X PUT "$REALM_API" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$REALM_NO_POLICY")
UPDATE_STATUS=$(echo "$UPDATE_RESP" | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')

if [[ "$UPDATE_STATUS" -ne 204 ]]; then
  log "❌ Failed to update realm settings (HTTP $UPDATE_STATUS)"
  exit 1
else
  log "✅ Password policy removed"
fi

#----------------------------------------
# Keycloak API: client ID & secret
#----------------------------------------
CLIENT_ID=$(curl "${CURL_TLS_ARGS[@]}" -X GET \
  "${REALM_API}/clients?clientId=${CLIENT_NAME}" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.[0].id')
NEW_SECRET=$(curl "${CURL_TLS_ARGS[@]}" -X POST \
  "${REALM_API}/clients/${CLIENT_ID}/client-secret" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r .value)
if [[ -z "$NEW_SECRET" || "$NEW_SECRET" == "null" ]]; then
  log "❌ Keycloak did not return a client secret"
  exit 1
fi

kubectl create secret generic fc-keycloak-client-secret \
  --namespace "$NAMESPACE" \
  --from-literal=keycloak_client_secret="$NEW_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/fc-service -n "$NAMESPACE"
log "✅ New client secret generated and synchronized"

#----------------------------------------
# Keycloak API: create user & assign role
#----------------------------------------
CREATE_STATUS=$(curl "${CURL_TLS_ARGS[@]}" -o /dev/null -w "%{http_code}" -X POST \
  "${REALM_API}/users" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
        \"username\":\"${NEW_USER}\",
        \"enabled\":true,
        \"credentials\":[{\"type\":\"password\",\"value\":\"${NEW_PASS}\",\"temporary\":false}]
     }")
if [[ "$CREATE_STATUS" != "201" ]]; then
  log "❌ User creation failed (HTTP $CREATE_STATUS)"; exit 1
else
  log "✅ User '${NEW_USER}' created"
fi

USER_ID=$(curl "${CURL_TLS_ARGS[@]}" -X GET \
  "${REALM_API}/users?username=${NEW_USER}" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.[0].id')
ROLE_ID=$(curl "${CURL_TLS_ARGS[@]}" -X GET \
  "${REALM_API}/clients/${CLIENT_ID}/roles" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r ".[]|select(.name==\"${CLIENT_ROLE}\")|.id")
curl "${CURL_TLS_ARGS[@]}" -o /dev/null -w "%{http_code}" -X POST \
  "${REALM_API}/users/${USER_ID}/role-mappings/clients/${CLIENT_ID}" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "[{\"id\":\"${ROLE_ID}\",\"name\":\"${CLIENT_ROLE}\"}]"
log "✅ Role '${CLIENT_ROLE}' assigned to '${NEW_USER}'"

#----------------------------------------
# Wait for fc-service Deployment to be ready (max 5m)
#----------------------------------------
log "ℹ️ Waiting for fc-service deployment to be ready (max 2m)..."
if ! kubectl rollout status deployment/fc-service \
     -n "$NAMESPACE" \
     --timeout=300s \
     --kubeconfig "$KUBECONFIG"; then
  log "❌ Timeout waiting for fc-service. Pod statuses:"
  kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=fc-service -o wide
  exit 1
fi
log "✅ fc-service deployment is ready"
#----------------------------------------
# Final output
#----------------------------------------
log "🎉 All operations completed successfully!"
echo
echo "🔹 ingress External-IP: ${EX_IP}"
echo "🔹 fc-service URL:      https://${DOMAIN}/${URL_PATH}/fcservice"
echo "🔹 Keycloak URL:        https://${DOMAIN}/${URL_PATH}/key-server"
echo "🔹 Client Secret:       ${NEW_SECRET}"
