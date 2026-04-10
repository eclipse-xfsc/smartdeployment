#!/bin/bash

set -Eeuo pipefail

# Usage:
#   ./deploy.sh <namespace> <domain> <fullchain.crt> <tls.key> <kubeconfig> [db_type] [db_url] [db_username] [db_password]
#
# db_type:
#   - embedded (default): deploy PostgreSQL inside the cluster for AAS
#   - external: use an existing external PostgreSQL database for AAS

NAMESPACE="${1:?namespace is required}"
DOMAIN="${2:?domain is required}"
CERT_PATH="${3:?fullchain cert path is required}"
KEY_PATH="${4:?tls key path is required}"
KUBE="${5:?kubeconfig path is required}"
DB_TYPE_RAW="${6:-embedded}"
EXTERNAL_DB_URL="${7:-}"
EXTERNAL_DB_USERNAME="${8:-}"
EXTERNAL_DB_PASSWORD="${9:-}"

TLS_SECRET="xfsc-wildcard"
NGINX_ING_VER="controller-v1.11.1"
ING_URL="https://raw.githubusercontent.com/kubernetes/ingress-nginx/${NGINX_ING_VER}/deploy/static/provider/cloud/deploy.yaml"
POSTGRES_SELECTOR='app.kubernetes.io/instance=postgres,app.kubernetes.io/component=primary'
AAS_DB_VALUES_FILE=""

export KUBECONFIG="$KUBE"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHART_DIR="$ROOT_DIR/helm"
cd "$ROOT_DIR"

cleanup() {
  set +e
  [ -f "$CHART_DIR/Keycloak/values.yaml.bak" ] && mv "$CHART_DIR/Keycloak/values.yaml.bak" "$CHART_DIR/Keycloak/values.yaml"
  [ -f "$CHART_DIR/Keycloak/realm/gaia-x-realm.json.bak" ] && mv "$CHART_DIR/Keycloak/realm/gaia-x-realm.json.bak" "$CHART_DIR/Keycloak/realm/gaia-x-realm.json"
  [ -f "$CHART_DIR/AAS/values.yaml.bak" ] && mv "$CHART_DIR/AAS/values.yaml.bak" "$CHART_DIR/AAS/values.yaml"
  [ -n "${AAS_DB_VALUES_FILE:-}" ] && [ -f "$AAS_DB_VALUES_FILE" ] && rm -f "$AAS_DB_VALUES_FILE"
}
trap cleanup EXIT

log() {
  printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

normalize_db_type() {
  local value=""
  value="$(printf '%s' "${1:-embedded}" | tr '[:upper:]' '[:lower:]')"

  case "$value" in
    embedded|embedded-deploy|embedded_deploy|embedded\ deploy)
      printf 'embedded'
      ;;
    external|external-db|external_db|external\ db)
      printf 'external'
      ;;
    *)
      return 1
      ;;
  esac
}

wait_for_deploy() {
  local ns="$1"
  local name="$2"
  local timeout="${3:-10m}"
  kubectl -n "$ns" rollout status "deploy/$name" --timeout="$timeout"
}

wait_for_pod_by_label() {
  local ns="$1"
  local selector="$2"
  local timeout="${3:-10m}"
  kubectl -n "$ns" wait --for=condition=Ready pod -l "$selector" --timeout="$timeout"
}

current_pod_by_label() {
  local ns="$1"
  local selector="$2"
  kubectl -n "$ns" get pod -l "$selector" \
    --sort-by=.metadata.creationTimestamp \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | tail -n 1
}

wait_for_secret_field() {
  local ns="$1"
  local secret_name="$2"
  local field_name="$3"
  local encoded=""

  while true; do
    encoded="$(kubectl -n "$ns" get secret "$secret_name" -o json 2>/dev/null | jq -r --arg key "$field_name" '.data[$key] // empty' || true)"
    if [ -n "$encoded" ]; then
      printf '%s' "$encoded" | base64 -d
      return 0
    fi
    log "Waiting for secret ${secret_name}.${field_name}"
    sleep 5
  done
}

print_postgres_debug() {
  local ns="$1"
  local selector="$2"
  local pod="$3"

  kubectl -n "$ns" get pods -l "$selector" -o wide || true
  if [ -n "$pod" ]; then
    kubectl -n "$ns" describe pod "$pod" || true
    kubectl -n "$ns" logs "$pod" --all-containers --tail=100 || true
  fi
}

wait_for_postgres_accepting_connections() {
  local ns="$1"
  local selector="$2"
  local admin_password="$3"
  local attempt=0
  local pod=""

  while true; do
    pod="$(current_pod_by_label "$ns" "$selector")"

    if [ -n "$pod" ]; then
      if kubectl exec -n "$ns" "$pod" -- \
        env PGPASSWORD="$admin_password" \
        pg_isready -h 127.0.0.1 -p 5432 -U postgres -d postgres >/dev/null 2>&1 \
        && kubectl exec -n "$ns" "$pod" -- \
          env PGPASSWORD="$admin_password" \
          psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -Atqc 'select 1' >/dev/null 2>&1; then
        printf '%s' "$pod"
        return 0
      fi
    fi

    attempt=$((attempt + 1))
    if (( attempt == 1 || attempt % 12 == 0 )); then
      log "Waiting for PostgreSQL to accept local psql connections${pod:+ on ${pod}}"
      print_postgres_debug "$ns" "$selector" "$pod"
    fi
    sleep 5
  done
}

bootstrap_aas_database() {
  local ns="$1"
  local selector="$2"
  local admin_password="$3"
  local aas_db_password="$4"
  local pod=""
  local attempt=0

  while true; do
    pod="$(wait_for_postgres_accepting_connections "$ns" "$selector" "$admin_password")"

    if kubectl exec -i -n "$ns" "$pod" -- \
      env PGPASSWORD="$admin_password" \
      psql -h 127.0.0.1 -p 5432 -v ON_ERROR_STOP=1 -U postgres <<SQL
DO
\$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aas') THEN
    CREATE ROLE aas LOGIN PASSWORD '${aas_db_password}';
  ELSE
    ALTER ROLE aas WITH PASSWORD '${aas_db_password}';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE aas OWNER aas'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'aas')\gexec

ALTER DATABASE aas OWNER TO aas;
GRANT ALL PRIVILEGES ON DATABASE aas TO aas;
SQL
    then
      return 0
    fi

    attempt=$((attempt + 1))
    log "PostgreSQL bootstrap attempt ${attempt} failed; retrying until it succeeds"
    print_postgres_debug "$ns" "$selector" "$pod"
    sleep 5
  done
}

build_aas_db_values_file() {
  local db_url="$1"
  local db_username="$2"

  AAS_DB_VALUES_FILE="$(mktemp)"
  jq -n \
    --arg url "$db_url" \
    --arg username "$db_username" \
    '{
      env: {
        SPRING_DATASOURCE_URL: $url,
        SPRING_DATASOURCE_USERNAME: $username
      },
      secretEnv: {
        SPRING_DATASOURCE_PASSWORD: {
          name: "aas-db-secret",
          key: "password"
        }
      }
    }' > "$AAS_DB_VALUES_FILE"
}

for bin in kubectl helm openssl jq curl sed grep base64 mktemp tr; do
  require "$bin"
done

[ -f "$CERT_PATH" ] || die "certificate file not found: $CERT_PATH"
[ -f "$KEY_PATH" ] || die "key file not found: $KEY_PATH"
[ -f "$KUBE" ] || die "kubeconfig file not found: $KUBE"

DB_TYPE="$(normalize_db_type "$DB_TYPE_RAW")" || die "invalid db type: $DB_TYPE_RAW (expected embedded or external)"

if [ "$DB_TYPE" = "external" ]; then
  [ -n "$EXTERNAL_DB_URL" ] || die "external db url is required when db_type=external"
  [ -n "$EXTERNAL_DB_USERNAME" ] || die "external db username is required when db_type=external"
  [ -n "$EXTERNAL_DB_PASSWORD" ] || die "external db password is required when db_type=external"

  case "$EXTERNAL_DB_URL" in
    jdbc:postgresql://*) ;;
    *) die "external db url must be a PostgreSQL JDBC URL (for example jdbc:postgresql://db.example.com:5432/aas)" ;;
  esac
fi

log "Adding Helm repos"
helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null 2>&1 || true
helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
# helm repo update

log "Installing or repairing ingress-nginx"
kubectl get ns ingress-nginx >/dev/null 2>&1 || kubectl create namespace ingress-nginx
kubectl -n ingress-nginx delete job -l app.kubernetes.io/component=admission-webhook --ignore-not-found || true
curl -fsSL "$ING_URL" | kubectl apply -f -
for i in {1..30}; do
  kubectl -n ingress-nginx get deploy/ingress-nginx-controller >/dev/null 2>&1 && break
  sleep 2
done
wait_for_deploy ingress-nginx ingress-nginx-controller 10m
kubectl delete validatingwebhookconfiguration ingress-nginx-admission --ignore-not-found || true
kubectl -n ingress-nginx create configmap ingress-nginx-controller --dry-run=client -o yaml | kubectl apply -f -
kubectl -n ingress-nginx patch configmap ingress-nginx-controller \
  --type merge \
  -p '{"data":{"allow-snippet-annotations":"true","annotations-risk-level":"Critical","ssl-protocols":"TLSv1.3"}}' || true
kubectl -n ingress-nginx rollout restart deploy/ingress-nginx-controller || true
wait_for_deploy ingress-nginx ingress-nginx-controller 10m || true

log "Creating namespace and TLS secret"
kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"
cat <<EOF_NAMESPACE_POLICY | kubectl -n "$NAMESPACE" apply -f -
apiVersion: v1
kind: ResourceQuota
metadata:
  name: aas-resource-quota
  namespace: $NAMESPACE
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
  name: aas-container-defaults
  namespace: $NAMESPACE
spec:
  limits:
    - type: Container
      default:
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
EOF_NAMESPACE_POLICY
kubectl create secret tls "$TLS_SECRET" \
  --cert="$CERT_PATH" \
  --key="$KEY_PATH" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

case "$DB_TYPE" in
  embedded)
    AAS_DB_URL="jdbc:postgresql://postgres-postgresql:5432/aas"
    AAS_DB_USERNAME="aas"
    AAS_DB_PASSWORD="$(openssl rand -hex 16)"

    log "Installing PostgreSQL for AAS (embedded mode)"
    helm upgrade --install postgres \
      oci://registry-1.docker.io/bitnamicharts/postgresql \
      --namespace "$NAMESPACE" \
      --create-namespace \
      --wait \
      --timeout 15m \
      --set image.registry=docker.io \
      --set image.repository=bitnamilegacy/postgresql \
      --set global.security.allowInsecureImages=true

    POSTGRES_ADMIN_PASSWORD="$(wait_for_secret_field "$NAMESPACE" 'postgres-postgresql' 'postgres-password')"
    wait_for_pod_by_label "$NAMESPACE" "$POSTGRES_SELECTOR" 10m || true

    log "Creating AAS database and role"
    bootstrap_aas_database "$NAMESPACE" "$POSTGRES_SELECTOR" "$POSTGRES_ADMIN_PASSWORD" "$AAS_DB_PASSWORD"
    ;;
  external)
    AAS_DB_URL="$EXTERNAL_DB_URL"
    AAS_DB_USERNAME="$EXTERNAL_DB_USERNAME"
    AAS_DB_PASSWORD="$EXTERNAL_DB_PASSWORD"

    log "Using external PostgreSQL for AAS"
    log "External DB URL: $AAS_DB_URL"
    ;;
esac

kubectl create secret generic aas-db-secret \
  -n "$NAMESPACE" \
  --from-literal=username="$AAS_DB_USERNAME" \
  --from-literal=password="$AAS_DB_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

build_aas_db_values_file "$AAS_DB_URL" "$AAS_DB_USERNAME"

log "Templating Keycloak values and realm"
sed -i.bak \
  -e 's/\<DOMAIN\>/'"$DOMAIN"'/g' \
  -e 's/\<TLS_SECRET\>/'"$TLS_SECRET"'/g' \
  "$CHART_DIR/Keycloak/values.yaml"

sed -i.bak \
  -e 's/\<DOMAIN\>/'"$DOMAIN"'/g' \
  "$CHART_DIR/Keycloak/realm/gaia-x-realm.json"

kubectl -n "$NAMESPACE" create configmap gaia-x-realm-config \
  --from-file=gaia-x-realm.json="$CHART_DIR/Keycloak/realm/gaia-x-realm.json" \
  --dry-run=client -o yaml | kubectl apply -f -

log "Installing Keycloak"
helm dependency build "$CHART_DIR/Keycloak"
helm upgrade --install keycloak "$CHART_DIR/Keycloak" \
  --namespace "$NAMESPACE" \
  -f "$CHART_DIR/Keycloak/values.yaml" \
  --set keycloak.image.registry=docker.io \
  --set keycloak.image.repository=bitnamilegacy/keycloak \
  --set keycloak.image.tag=26.3.2-debian-12-r0 \
  --set keycloak.auth.adminUser=admin \
  --set keycloak.keycloakConfigCli.enabled=true \
  --set keycloak.resources.requests.cpu=500m \
  --set keycloak.resources.requests.memory=1Gi \
  --set keycloak.resources.limits.cpu=1 \
  --set keycloak.resources.limits.memory=2Gi \
  --set keycloak.postgresql.primary.resources.requests.cpu=250m \
  --set keycloak.postgresql.primary.resources.requests.memory=256Mi \
  --set keycloak.postgresql.primary.resources.limits.cpu=500m \
  --set keycloak.postgresql.primary.resources.limits.memory=512Mi \
  --set global.security.allowInsecureImages=true \
  --wait \
  --timeout 30m

KC_POD="$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=keycloak -o jsonpath='{.items[0].metadata.name}')"
[ -n "$KC_POD" ] || die "keycloak pod not found"
PASS="$(kubectl -n "$NAMESPACE" get secret keycloak-init-secrets -o jsonpath='{.data.password}' | base64 -d)"
KCADM_DIR="/tmp/kcadm"
KCADM_CFG="$KCADM_DIR/kcadm.config"

log "Waiting for Keycloak admin API"
ok=""
for i in {1..60}; do
  if kubectl -n "$NAMESPACE" exec -i "$KC_POD" -- sh -lc "
    mkdir -p '$KCADM_DIR' &&
    HOME='$KCADM_DIR' /opt/bitnami/keycloak/bin/kcadm.sh config credentials \
      --config '$KCADM_CFG' \
      --server http://localhost:8080/ \
      --realm master \
      --user admin \
      --password '$PASS'
  " >/dev/null 2>&1; then
    ok="y"
    break
  fi
  sleep 5
done
[ -n "$ok" ] || die "Keycloak admin not ready"

log "Checking imported gaia-x realm"
ok=""
for i in {1..60}; do
  if kubectl -n "$NAMESPACE" exec "$KC_POD" -- sh -lc "
    HOME='$KCADM_DIR' /opt/bitnami/keycloak/bin/kcadm.sh get realms/gaia-x --config '$KCADM_CFG'
  " >/dev/null 2>&1; then
    ok="y"
    break
  fi
  sleep 5
done
[ -n "$ok" ] || die "Realm gaia-x not found (realm import failed)"

kubectl -n "$NAMESPACE" exec -i "$KC_POD" -- sh -lc "
  HOME='$KCADM_DIR' /opt/bitnami/keycloak/bin/kcadm.sh update realms/gaia-x \
    --config '$KCADM_CFG' \
    -s registrationAllowed=true
" >/dev/null 2>&1 || true

log "Creating Keycloak initial access token"
IAT_JSON="$(kubectl -n "$NAMESPACE" exec "$KC_POD" -- sh -lc "
  HOME='$KCADM_DIR' /opt/bitnami/keycloak/bin/kcadm.sh create clients-initial-access -r gaia-x \
    --config '$KCADM_CFG' \
    -s expiration=0 \
    -s count=1 \
    -o
")"

IAT_TOKEN="$(printf '%s\n' "$IAT_JSON" | jq -r '.token')"
[ -n "$IAT_TOKEN" ] && [ "$IAT_TOKEN" != "null" ] || {
  printf '%s\n' "$IAT_JSON" >&2
  die "failed to create initial access token"
}

kubectl -n "$NAMESPACE" create secret generic aas-initial-access-token \
  --from-literal=token="$IAT_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -


log "Templating and installing AAS"
sed -i.bak \
  -e 's/\<DOMAIN\>/'"$DOMAIN"'/g' \
  -e 's/\<TLS_SECRET\>/'"$TLS_SECRET"'/g' \
  "$CHART_DIR/AAS/values.yaml"

JWK_SECRET="$(uuidgen 2>/dev/null || openssl rand -hex 16)"

helm dependency build "$CHART_DIR/AAS" || true
helm upgrade --install auth-server "$CHART_DIR/AAS" \
  --namespace "$NAMESPACE" \
  -f "$CHART_DIR/AAS/values.yaml" \
  -f "$AAS_DB_VALUES_FILE" \
  --set-string secrets.keys.iat="$IAT_TOKEN" \
  --set-string secrets.keys.jwk="$JWK_SECRET" \
  --wait \
  --timeout 15m

log "Checking AAS deployment"
wait_for_deploy "$NAMESPACE" auth-server 10m || true
kubectl -n "$NAMESPACE" get ingress,svc,deploy,pods

AUTH_SERVER_URL="https://auth-server.${DOMAIN}"
KEY_SERVER_URL="https://key-server.${DOMAIN}"
TEST_URL="https://test-server.${DOMAIN}/demo"
KEYCLOAK_ADMIN_USERNAME="admin"
KEYCLOAK_REALM="gaia-x"
STATUS="Deployed"

echo
printf 'AAS_AUTH_URL=%s\n' "$AUTH_SERVER_URL"
printf 'KEY_SERVER_URL=%s\n' "$KEY_SERVER_URL"
printf 'TEST_URL=%s\n' "$TEST_URL"
printf 'STATUS=%s\n' "$STATUS"
printf 'KEYCLOAK_ADMIN_USERNAME=%s\n' "$KEYCLOAK_ADMIN_USERNAME"
printf 'KEYCLOAK_REALM=%s\n' "$KEYCLOAK_REALM"
printf 'INITIAL_ACCESS_TOKEN_SECRET=%s\n' "aas-initial-access-token"
echo "######################################################"
echo "###################### ALL DONE ######################"
echo "######################################################"