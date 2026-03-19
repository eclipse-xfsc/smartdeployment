#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${1:-}"
OCMW_NAMESPACE="${2:-}"
DOMAIN="${3:-}"
CERT_PATH="${4:-}"
KEY_PATH="${5:-}"
KUBE="${6:-}"
REGISTRY_IMAGE_PREFIX="${7:-}"
REGISTRY_USERNAME="${8:-}"
REGISTRY_PASSWORD="${9:-}"
EMAIL="${10:-}"
OCM_ADDR="${11:-}"
DEPLOY_LOGIN="${12:-true}"

if [ -z "$NAMESPACE" ] || [ -z "$OCMW_NAMESPACE" ] || [ -z "$DOMAIN" ] || [ -z "$CERT_PATH" ] || [ -z "$KEY_PATH" ] || [ -z "$KUBE" ] || [ -z "$REGISTRY_IMAGE_PREFIX" ] || [ -z "$REGISTRY_USERNAME" ] || [ -z "$REGISTRY_PASSWORD" ]; then
  echo "usage: deploy.sh <tsa-namespace> <ocmw-namespace> <domain> <cert> <key> <kubeconfig> <registry-prefix> <registry-user> <registry-password> [email] [ocm-addr] [deploy-login]" >&2
  exit 1
fi

export KUBECONFIG="$KUBE"

TLS_SECRET="xfsc-wildcard"
IMAGE_TAG="$(date +%Y%m%d%H%M%S)"
WORKDIR="$(mktemp -d -t tsa-ocmw-XXXXXX)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PF_PIDS=()

STACK_HOST="${NAMESPACE}.${DOMAIN}"
PUBLIC_BASE_URL="https://${STACK_HOST}"
PUBLIC_INFOHUB_URL="${PUBLIC_BASE_URL}/infohub"
PUBLIC_LOGIN_URL="${PUBLIC_BASE_URL}/login"
KEYCLOAK_REALM="tsa-${NAMESPACE}"
WORKSPACE_CLIENT_ID="tsa-${NAMESPACE}"
WORKSPACE_CLIENT_SECRET=""
MONGO_ROOT_USER="root"
MONGO_ROOT_PASSWORD=""
KEYCLOAK_ADMIN_USER="admin"
KEYCLOAK_ADMIN_PASSWORD=""
OAUTH_SECRET_PREEXISTED="false"
MONGO_SECRET_PREEXISTED="false"

KEYCLOAK_SERVICE=""
SIGNER_SERVICE=""
NATS_SERVICE=""
DID_RESOLVER_SERVICE=""
KEYCLOAK_HTTP_ADDR=""
SIGNER_HTTP_ADDR=""
NATS_ENDPOINT=""
DID_RESOLVER_HTTP_ADDR=""
KEYCLOAK_SERVICE_PORT=""
SIGNER_SERVICE_PORT=""
NATS_SERVICE_PORT=""
DID_RESOLVER_SERVICE_PORT=""

if [ -z "$OCM_ADDR" ]; then
  OCM_ADDR="https://cloud-wallet.${DOMAIN}"
fi

log() {
  printf '[tsa-stack] %s\n' "$*"
}

die() {
  printf '[tsa-stack] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local pid
  for pid in "${PF_PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  done
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool not found on PATH: $1"
}

for tool in kubectl helm docker git curl openssl base64; do
  require_tool "$tool"
done

parse_registry_server() {
  local prefix="$1"
  local first_segment
  first_segment="${prefix%%/*}"
  if [[ "$first_segment" == "$prefix" ]]; then
    echo "docker.io"
    return 0
  fi
  if [[ "$first_segment" == *.* || "$first_segment" == *:* || "$first_segment" == "localhost" ]]; then
    echo "$first_segment"
  else
    echo "docker.io"
  fi
}

rand_token() {
  local length="$1"
  openssl rand -base64 48 | tr -d '\n' | tr '/+' 'AZ' | cut -c1-"$length"
}

REGISTRY_SERVER="$(parse_registry_server "$REGISTRY_IMAGE_PREFIX")"
REGISTRY_SECRET_SERVER="$REGISTRY_SERVER"
if [ "$REGISTRY_SERVER" = "docker.io" ]; then
  REGISTRY_SECRET_SERVER="https://index.docker.io/v1/"
fi

mkdir -p "$WORKDIR/src"
declare -A IMAGES

ensure_namespace() {
  kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"
}

ensure_ingress_nginx() {
  if kubectl get ingressclass nginx >/dev/null 2>&1 && kubectl -n ingress-nginx get deployment ingress-nginx-controller >/dev/null 2>&1; then
    log "ingress-nginx already present"
    return 0
  fi

  log "installing ingress-nginx"
  kubectl get ns ingress-nginx >/dev/null 2>&1 || kubectl create namespace ingress-nginx
  kubectl -n ingress-nginx delete job -l app.kubernetes.io/component=admission-webhook --ignore-not-found >/dev/null 2>&1 || true
  curl -fsSL "https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.15.0/deploy/static/provider/cloud/deploy.yaml" | kubectl apply -f -
  for _ in $(seq 1 60); do
    kubectl -n ingress-nginx get deployment ingress-nginx-controller >/dev/null 2>&1 && break
    sleep 2
  done
  kubectl -n ingress-nginx rollout status deployment ingress-nginx-controller --timeout=10m
  kubectl delete validatingwebhookconfiguration ingress-nginx-admission --ignore-not-found >/dev/null 2>&1 || true
}

ensure_cert_manager() {
  if kubectl -n cert-manager get deployment cert-manager >/dev/null 2>&1; then
    log "cert-manager already present"
    return 0
  fi

  log "installing cert-manager"
  helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
  helm repo update >/dev/null
  kubectl apply --validate=false -f "https://github.com/cert-manager/cert-manager/releases/download/v1.20.0/cert-manager.crds.yaml"
  helm upgrade --install cert-manager jetstack/cert-manager \
    --namespace cert-manager \
    --create-namespace \
    --version v1.20.0 \
    --set installCRDs=false
  kubectl -n cert-manager rollout status deployment cert-manager --timeout=10m
  kubectl -n cert-manager rollout status deployment cert-manager-cainjector --timeout=10m
  kubectl -n cert-manager rollout status deployment cert-manager-webhook --timeout=10m
}

create_tls_secret() {
  log "creating TLS secret"
  kubectl -n "$NAMESPACE" create secret tls "$TLS_SECRET" \
    --cert="$CERT_PATH" \
    --key="$KEY_PATH" \
    --dry-run=client -o yaml | kubectl apply -f -
}

create_registry_secret() {
  log "creating image pull secret"
  kubectl -n "$NAMESPACE" create secret docker-registry regcred \
    --docker-server="$REGISTRY_SECRET_SERVER" \
    --docker-username="$REGISTRY_USERNAME" \
    --docker-password="$REGISTRY_PASSWORD" \
    --dry-run=client -o yaml | kubectl apply -f -
}

docker_login() {
  log "logging in to registry ${REGISTRY_SERVER}"
  if [ "$REGISTRY_SERVER" = "docker.io" ]; then
    echo "$REGISTRY_PASSWORD" | docker login -u "$REGISTRY_USERNAME" --password-stdin >/dev/null
  else
    echo "$REGISTRY_PASSWORD" | docker login "$REGISTRY_SERVER" -u "$REGISTRY_USERNAME" --password-stdin >/dev/null
  fi
}

clone_repo() {
  local dest="$1"
  shift
  local urls=("$@")
  rm -rf "$dest"
  mkdir -p "$dest"
  for url in "${urls[@]}"; do
    [ -z "$url" ] && continue
    log "trying clone: $url"
    if git clone --depth 1 "$url" "$dest" >/dev/null 2>&1; then
      git -C "$dest" submodule update --init --recursive >/dev/null 2>&1 || true
      return 0
    fi
    rm -rf "$dest"
    mkdir -p "$dest"
  done
  return 1
}

detect_dockerfile() {
  local dir="$1"
  local candidate
  for candidate in \
    "$dir/deployment/docker/Dockerfile" \
    "$dir/deployment/compose/Dockerfile" \
    "$dir/docker/Dockerfile" \
    "$dir/Dockerfile"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  candidate="$(find "$dir" -type f -name Dockerfile | sort | head -n 1 || true)"
  [ -n "$candidate" ] || return 1
  printf '%s\n' "$candidate"
}

build_component() {
  local image_name="$1"
  shift
  local repo_dir="$WORKDIR/src/${image_name}"
  clone_repo "$repo_dir" "$@" || die "failed to clone source for ${image_name}"
  local dockerfile
  dockerfile="$(detect_dockerfile "$repo_dir")" || die "failed to find Dockerfile for ${image_name}"
  local image_ref="${REGISTRY_IMAGE_PREFIX}/${image_name}:${IMAGE_TAG}"
  log "building ${image_name} using $(realpath --relative-to="$repo_dir" "$dockerfile" 2>/dev/null || echo "$dockerfile")"
  docker build --pull -f "$dockerfile" -t "$image_ref" "$repo_dir"
  log "pushing ${image_name} -> ${image_ref}"
  docker push "$image_ref"
  IMAGES["$image_name"]="$image_ref"
}

secret_value() {
  local namespace="$1"
  local secret_name="$2"
  local key="$3"
  local raw
  raw="$(kubectl -n "$namespace" get secret "$secret_name" -o "jsonpath={.data['$key']}" 2>/dev/null || true)"
  if [ -n "$raw" ]; then
    printf '%s' "$raw" | base64 -d 2>/dev/null || true
  fi
}

service_exists() {
  kubectl -n "$1" get svc "$2" >/dev/null 2>&1
}

first_matching_service() {
  local namespace="$1"
  shift
  local pattern
  local names
  names="$(kubectl -n "$namespace" get svc -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  for pattern in "$@"; do
    local match
    match="$(printf '%s\n' "$names" | grep -E "$pattern" | head -n 1 || true)"
    if [ -n "$match" ]; then
      printf '%s\n' "$match"
      return 0
    fi
  done
  return 1
}

get_service_port() {
  local namespace="$1"
  local service="$2"
  local preferred_name="$3"
  local port
  if [ -n "$preferred_name" ]; then
    port="$(kubectl -n "$namespace" get svc "$service" -o "jsonpath={.spec.ports[?(@.name=='$preferred_name')].port}" 2>/dev/null || true)"
    port="${port%% *}"
    if [ -n "$port" ]; then
      printf '%s
' "$port"
      return 0
    fi
  fi
  port="$(kubectl -n "$namespace" get svc "$service" -o 'jsonpath={.spec.ports[0].port}' 2>/dev/null || true)"
  [ -n "$port" ] || return 1
  printf '%s
' "$port"
}

discover_ocmw_shared_services() {
  kubectl get namespace "$OCMW_NAMESPACE" >/dev/null 2>&1 || die "OCMW namespace not found: $OCMW_NAMESPACE"

  if service_exists "$OCMW_NAMESPACE" keycloak; then
    KEYCLOAK_SERVICE="keycloak"
  else
    KEYCLOAK_SERVICE="$(first_matching_service "$OCMW_NAMESPACE" '^keycloak$' 'keycloak')" || true
  fi
  [ -n "$KEYCLOAK_SERVICE" ] || die "could not find shared Keycloak service in namespace $OCMW_NAMESPACE"

  if service_exists "$OCMW_NAMESPACE" signer; then
    SIGNER_SERVICE="signer"
  else
    SIGNER_SERVICE="$(first_matching_service "$OCMW_NAMESPACE" '^signer$' 'signer')" || true
  fi
  [ -n "$SIGNER_SERVICE" ] || die "could not find shared signer service in namespace $OCMW_NAMESPACE"

  if service_exists "$OCMW_NAMESPACE" nats; then
    NATS_SERVICE="nats"
  else
    NATS_SERVICE="$(first_matching_service "$OCMW_NAMESPACE" '^nats$' 'nats')" || true
  fi
  [ -n "$NATS_SERVICE" ] || die "could not find shared NATS service in namespace $OCMW_NAMESPACE"

  if service_exists "$OCMW_NAMESPACE" universal-resolver-service; then
    DID_RESOLVER_SERVICE="universal-resolver-service"
  elif service_exists "$OCMW_NAMESPACE" didresolver; then
    DID_RESOLVER_SERVICE="didresolver"
  else
    DID_RESOLVER_SERVICE="$(first_matching_service "$OCMW_NAMESPACE" 'universal-resolver' 'resolver' '^didresolver$')" || true
  fi
  [ -n "$DID_RESOLVER_SERVICE" ] || die "could not find shared DID resolver service in namespace $OCMW_NAMESPACE"

  KEYCLOAK_SERVICE_PORT="$(get_service_port "$OCMW_NAMESPACE" "$KEYCLOAK_SERVICE" http)" || die "could not determine Keycloak service port"
  SIGNER_SERVICE_PORT="$(get_service_port "$OCMW_NAMESPACE" "$SIGNER_SERVICE" http)" || die "could not determine signer service port"
  NATS_SERVICE_PORT="$(get_service_port "$OCMW_NAMESPACE" "$NATS_SERVICE" client)" || die "could not determine NATS client port"
  DID_RESOLVER_SERVICE_PORT="$(get_service_port "$OCMW_NAMESPACE" "$DID_RESOLVER_SERVICE" http)" || die "could not determine DID resolver service port"

  KEYCLOAK_HTTP_ADDR="http://${KEYCLOAK_SERVICE}.${OCMW_NAMESPACE}.svc.cluster.local:${KEYCLOAK_SERVICE_PORT}"
  SIGNER_HTTP_ADDR="http://${SIGNER_SERVICE}.${OCMW_NAMESPACE}.svc.cluster.local:${SIGNER_SERVICE_PORT}"
  NATS_ENDPOINT="${NATS_SERVICE}.${OCMW_NAMESPACE}.svc.cluster.local:${NATS_SERVICE_PORT}"
  DID_RESOLVER_HTTP_ADDR="http://${DID_RESOLVER_SERVICE}.${OCMW_NAMESPACE}.svc.cluster.local:${DID_RESOLVER_SERVICE_PORT}"

  log "reusing shared OCMW services"
  log "  keycloak: ${KEYCLOAK_HTTP_ADDR}"
  log "  signer: ${SIGNER_HTTP_ADDR}"
  log "  nats: ${NATS_ENDPOINT}"
  log "  did resolver: ${DID_RESOLVER_HTTP_ADDR}"
}

load_stateful_values() {
  local existing

  existing="$(secret_value "$NAMESPACE" mongo-auth username)"
  if [ -n "$existing" ]; then
    MONGO_ROOT_USER="$existing"
    MONGO_SECRET_PREEXISTED="true"
  fi
  existing="$(secret_value "$NAMESPACE" mongo-auth password)"
  if [ -n "$existing" ]; then
    MONGO_ROOT_PASSWORD="$existing"
    MONGO_SECRET_PREEXISTED="true"
  fi
  if [ -z "$MONGO_ROOT_PASSWORD" ]; then
    MONGO_ROOT_PASSWORD="$(rand_token 24)"
  fi

  existing="$(secret_value "$NAMESPACE" tsa-oauth-client client-id)"
  if [ -n "$existing" ]; then
    WORKSPACE_CLIENT_ID="$existing"
    OAUTH_SECRET_PREEXISTED="true"
  fi
  existing="$(secret_value "$NAMESPACE" tsa-oauth-client client-secret)"
  if [ -n "$existing" ]; then
    WORKSPACE_CLIENT_SECRET="$existing"
    OAUTH_SECRET_PREEXISTED="true"
  fi
  if [ -z "$WORKSPACE_CLIENT_SECRET" ]; then
    WORKSPACE_CLIENT_SECRET="$(rand_token 32)"
  fi
}

create_runtime_secrets_and_config() {
  log "creating runtime secrets and configmaps"

  kubectl -n "$NAMESPACE" create secret generic mongo-auth \
    --from-literal=username="$MONGO_ROOT_USER" \
    --from-literal=password="$MONGO_ROOT_PASSWORD" \
    --dry-run=client -o yaml | kubectl apply -f -

  kubectl -n "$NAMESPACE" create secret generic tsa-oauth-client \
    --from-literal=client-id="$WORKSPACE_CLIENT_ID" \
    --from-literal=client-secret="$WORKSPACE_CLIENT_SECRET" \
    --dry-run=client -o yaml | kubectl apply -f -

  if [ "$DEPLOY_LOGIN" = "true" ] && ! kubectl -n "$NAMESPACE" get secret login-jwt >/dev/null 2>&1; then
    log "generating login RSA keys"
    openssl genrsa -out "$WORKDIR/login-private.pem" 2048 >/dev/null 2>&1
    openssl rsa -in "$WORKDIR/login-private.pem" -pubout -out "$WORKDIR/login-public.pem" >/dev/null 2>&1
    kubectl -n "$NAMESPACE" create secret generic login-jwt \
      --from-file=private.pem="$WORKDIR/login-private.pem" \
      --from-file=public.pem="$WORKDIR/login-public.pem" \
      --dry-run=client -o yaml | kubectl apply -f -
  fi

  kubectl -n "$NAMESPACE" create configmap tsa-mongo-init \
    --from-file=mongo-init.js="$SCRIPT_DIR/templates/mongo-init.js" \
    --dry-run=client -o yaml | kubectl apply -f -
}

apply_infra() {
  log "applying infrastructure manifests"
  cat >"$WORKDIR/infra.yaml" <<EOF_INFRA
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: redis-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        args: ["redis-server", "--appendonly", "yes"]
        ports:
        - containerPort: 6379
          name: redis
        volumeMounts:
        - name: redis-data
          mountPath: /data
        readinessProbe:
          tcpSocket:
            port: 6379
          initialDelaySeconds: 5
          periodSeconds: 5
        livenessProbe:
          tcpSocket:
            port: 6379
          initialDelaySeconds: 15
          periodSeconds: 10
      volumes:
      - name: redis-data
        persistentVolumeClaim:
          claimName: redis-data
---
apiVersion: v1
kind: Service
metadata:
  name: redis
spec:
  selector:
    app: redis
  ports:
  - name: redis
    port: 6379
    targetPort: 6379
---
apiVersion: v1
kind: Service
metadata:
  name: mongo-headless
spec:
  clusterIP: None
  selector:
    app: mongo
  ports:
  - name: mongo
    port: 27017
    targetPort: 27017
---
apiVersion: v1
kind: Service
metadata:
  name: mongo
spec:
  selector:
    app: mongo
  ports:
  - name: mongo
    port: 27017
    targetPort: 27017
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongo
spec:
  serviceName: mongo-headless
  replicas: 1
  selector:
    matchLabels:
      app: mongo
  template:
    metadata:
      labels:
        app: mongo
    spec:
      containers:
      - name: mongo
        image: mongo:6.0
        args: ["--bind_ip_all", "--replSet", "rs0"]
        env:
        - name: MONGO_INITDB_ROOT_USERNAME
          valueFrom:
            secretKeyRef:
              name: mongo-auth
              key: username
        - name: MONGO_INITDB_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mongo-auth
              key: password
        ports:
        - containerPort: 27017
          name: mongo
        volumeMounts:
        - name: mongo-data
          mountPath: /data/db
        - name: mongo-init
          mountPath: /docker-entrypoint-initdb.d/mongo-init.js
          subPath: mongo-init.js
        readinessProbe:
          tcpSocket:
            port: 27017
          initialDelaySeconds: 10
          periodSeconds: 5
        livenessProbe:
          tcpSocket:
            port: 27017
          initialDelaySeconds: 30
          periodSeconds: 10
      volumes:
      - name: mongo-init
        configMap:
          name: tsa-mongo-init
  volumeClaimTemplates:
  - metadata:
      name: mongo-data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 5Gi
EOF_INFRA

  if [ "$DEPLOY_LOGIN" = "true" ]; then
    cat >>"$WORKDIR/infra.yaml" <<'EOF_LOGIN_INFRA'
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mailhog
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mailhog
  template:
    metadata:
      labels:
        app: mailhog
    spec:
      containers:
      - name: mailhog
        image: mailhog/mailhog:v1.0.1
        ports:
        - containerPort: 1025
          name: smtp
        - containerPort: 8025
          name: web
        readinessProbe:
          httpGet:
            path: /
            port: 8025
          initialDelaySeconds: 10
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /
            port: 8025
          initialDelaySeconds: 30
          periodSeconds: 15
---
apiVersion: v1
kind: Service
metadata:
  name: mailhog
spec:
  selector:
    app: mailhog
  ports:
  - name: smtp
    port: 1025
    targetPort: 1025
  - name: web
    port: 8025
    targetPort: 8025
EOF_LOGIN_INFRA
  fi

  kubectl -n "$NAMESPACE" apply -f "$WORKDIR/infra.yaml"
}

wait_infra() {
  log "waiting for infrastructure"
  kubectl -n "$NAMESPACE" rollout status deployment/redis --timeout=10m
  kubectl -n "$NAMESPACE" rollout status statefulset/mongo --timeout=15m
  if [ "$DEPLOY_LOGIN" = "true" ]; then
    kubectl -n "$NAMESPACE" rollout status deployment/mailhog --timeout=10m
  fi
}

mongo_shell_exec() {
  local pod="$1"
  local script="$2"
  if kubectl -n "$NAMESPACE" exec "$pod" -- sh -lc 'command -v mongosh >/dev/null 2>&1'; then
    kubectl -n "$NAMESPACE" exec "$pod" -- sh -lc "mongosh --quiet -u '$MONGO_ROOT_USER' -p '$MONGO_ROOT_PASSWORD' --authenticationDatabase admin --eval \"$script\""
  else
    kubectl -n "$NAMESPACE" exec "$pod" -- sh -lc "mongo --quiet -u '$MONGO_ROOT_USER' -p '$MONGO_ROOT_PASSWORD' --authenticationDatabase admin --eval \"$script\""
  fi
}

init_mongo_replica_set() {
  log "initializing mongo replica set"
  local pod
  pod="$(kubectl -n "$NAMESPACE" get pod -l app=mongo -o jsonpath='{.items[0].metadata.name}')"
  for _ in $(seq 1 40); do
    if mongo_shell_exec "$pod" 'db.adminCommand({ ping: 1 }).ok' >/dev/null 2>&1; then
      break
    fi
    sleep 3
  done
  mongo_shell_exec "$pod" "try { rs.status().ok } catch (e) { rs.initiate({_id:'rs0',members:[{_id:0,host:'mongo-0.mongo-headless.${NAMESPACE}.svc.cluster.local:27017'}]}) }" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    if mongo_shell_exec "$pod" 'rs.status().ok' 2>/dev/null | grep -q '1'; then
      log "mongo replica set ready"
      return 0
    fi
    sleep 3
  done
  die "mongo replica set did not become ready"
}

run_port_forward_ns() {
  local namespace="$1"
  local service="$2"
  local local_port="$3"
  local remote_port="$4"
  local log_file="$WORKDIR/pf-${namespace}-${service}-${local_port}.log"
  kubectl -n "$namespace" port-forward "svc/${service}" "${local_port}:${remote_port}" >"$log_file" 2>&1 &
  local pid=$!
  PF_PIDS+=("$pid")
  sleep 4
  printf '%s\n' "$pid"
}

stop_port_forward() {
  local pid="$1"
  kill "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
}

bootstrap_shared_keycloak() {
  log "bootstrapping shared Keycloak realm ${KEYCLOAK_REALM}"
  KEYCLOAK_ADMIN_PASSWORD="$(secret_value "$OCMW_NAMESPACE" keycloak-init-secrets admin-password)"
  if [ -z "$KEYCLOAK_ADMIN_PASSWORD" ]; then
    KEYCLOAK_ADMIN_PASSWORD="$(secret_value "$OCMW_NAMESPACE" keycloak-init-secrets password)"
  fi
  [ -n "$KEYCLOAK_ADMIN_PASSWORD" ] || die "could not read Keycloak admin password from ${OCMW_NAMESPACE}/keycloak-init-secrets"

  local pid admin_token token_json realm_status client_json client_uuid regen_json regen_secret payload
  pid="$(run_port_forward_ns "$OCMW_NAMESPACE" "$KEYCLOAK_SERVICE" 18500 "$KEYCLOAK_SERVICE_PORT")"
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:18500/realms/master/.well-known/openid-configuration" >/dev/null 2>&1; then
      break
    fi
    sleep 3
  done

  token_json="$(curl -fsS -X POST "http://127.0.0.1:18500/realms/master/protocol/openid-connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=${KEYCLOAK_ADMIN_USER}" \
    -d "password=${KEYCLOAK_ADMIN_PASSWORD}" \
    -d "grant_type=password" \
    -d "client_id=admin-cli")"
  admin_token="$(printf '%s' "$token_json" | tr -d '\n' | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
  [ -n "$admin_token" ] || { stop_port_forward "$pid"; die "failed to obtain Keycloak admin token"; }

  realm_status="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${admin_token}" "http://127.0.0.1:18500/admin/realms/${KEYCLOAK_REALM}")"
  if [ "$realm_status" = "404" ]; then
    payload="{\"realm\":\"${KEYCLOAK_REALM}\",\"enabled\":true,\"registrationAllowed\":true}"
    curl -fsS -X POST "http://127.0.0.1:18500/admin/realms" \
      -H "Authorization: Bearer ${admin_token}" \
      -H "Content-Type: application/json" \
      -d "$payload" >/dev/null
  fi

  client_json="$(curl -fsS -H "Authorization: Bearer ${admin_token}" "http://127.0.0.1:18500/admin/realms/${KEYCLOAK_REALM}/clients?clientId=${WORKSPACE_CLIENT_ID}")"
  client_uuid="$(printf '%s' "$client_json" | tr -d '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n1)"

  if printf '%s' "$client_json" | grep -q "\"clientId\":\"${WORKSPACE_CLIENT_ID}\""; then
    payload="{\"clientId\":\"${WORKSPACE_CLIENT_ID}\",\"enabled\":true,\"protocol\":\"openid-connect\",\"publicClient\":false,\"serviceAccountsEnabled\":true,\"standardFlowEnabled\":false,\"directAccessGrantsEnabled\":false}"
    curl -fsS -X PUT "http://127.0.0.1:18500/admin/realms/${KEYCLOAK_REALM}/clients/${client_uuid}" \
      -H "Authorization: Bearer ${admin_token}" \
      -H "Content-Type: application/json" \
      -d "$payload" >/dev/null || true

    if [ "$OAUTH_SECRET_PREEXISTED" != "true" ]; then
      regen_json="$(curl -fsS -X POST "http://127.0.0.1:18500/admin/realms/${KEYCLOAK_REALM}/clients/${client_uuid}/client-secret" \
        -H "Authorization: Bearer ${admin_token}" \
        -H "Content-Type: application/json")"
      regen_secret="$(printf '%s' "$regen_json" | tr -d '\n' | sed -n 's/.*"value":"\([^"]*\)".*/\1/p')"
      [ -n "$regen_secret" ] || { stop_port_forward "$pid"; die "failed to refresh existing Keycloak client secret"; }
      WORKSPACE_CLIENT_SECRET="$regen_secret"
      kubectl -n "$NAMESPACE" create secret generic tsa-oauth-client \
        --from-literal=client-id="$WORKSPACE_CLIENT_ID" \
        --from-literal=client-secret="$WORKSPACE_CLIENT_SECRET" \
        --dry-run=client -o yaml | kubectl apply -f -
    fi
  else
    payload="{\"clientId\":\"${WORKSPACE_CLIENT_ID}\",\"enabled\":true,\"protocol\":\"openid-connect\",\"publicClient\":false,\"serviceAccountsEnabled\":true,\"standardFlowEnabled\":false,\"directAccessGrantsEnabled\":false,\"secret\":\"${WORKSPACE_CLIENT_SECRET}\"}"
    curl -fsS -X POST "http://127.0.0.1:18500/admin/realms/${KEYCLOAK_REALM}/clients" \
      -H "Authorization: Bearer ${admin_token}" \
      -H "Content-Type: application/json" \
      -d "$payload" >/dev/null
  fi

  stop_port_forward "$pid"
}

apply_apps() {
  log "applying TSA application manifests"
  cat >"$WORKDIR/apps.yaml" <<EOF_APPS
apiVersion: apps/v1
kind: Deployment
metadata:
  name: policy
spec:
  replicas: 1
  selector:
    matchLabels:
      app: policy
  template:
    metadata:
      labels:
        app: policy
    spec:
      imagePullSecrets:
      - name: regcred
      containers:
      - name: policy
        image: ${IMAGES[policy]}
        imagePullPolicy: Always
        ports:
        - containerPort: 8080
          name: http
        env:
        - name: LOG_LEVEL
          value: debug
        - name: EXTERNAL_HTTP_ADDR
          value: http://policy.${NAMESPACE}.svc.cluster.local:8080
        - name: HTTP_HOST
          value: ""
        - name: HTTP_PORT
          value: "8080"
        - name: HTTP_IDLE_TIMEOUT
          value: 120s
        - name: HTTP_READ_TIMEOUT
          value: 10s
        - name: HTTP_WRITE_TIMEOUT
          value: 10s
        - name: MONGO_ADDR
          value: mongodb://mongo:27017/policy?replicaSet=rs0&authSource=admin
        - name: MONGO_USER
          valueFrom:
            secretKeyRef:
              name: mongo-auth
              key: username
        - name: MONGO_PASS
          valueFrom:
            secretKeyRef:
              name: mongo-auth
              key: password
        - name: MONGO_DBNAME
          value: policy
        - name: MONGO_COLLECTION
          value: policies
        - name: CACHE_ADDR
          value: http://cache:8080
        - name: TASK_ADDR
          value: http://task:8080
        - name: SIGNER_ADDR
          value: ${SIGNER_HTTP_ADDR}
        - name: DID_RESOLVER_ADDR
          value: ${DID_RESOLVER_HTTP_ADDR}
        - name: OCM_ADDR
          value: ${OCM_ADDR}
        - name: AUTH_ENABLED
          value: "true"
        - name: AUTH_JWK_URL
          value: ${KEYCLOAK_HTTP_ADDR}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs
        - name: AUTH_REFRESH_INTERVAL
          value: 1h
        - name: OAUTH_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: tsa-oauth-client
              key: client-id
        - name: OAUTH_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: tsa-oauth-client
              key: client-secret
        - name: OAUTH_TOKEN_URL
          value: ${KEYCLOAK_HTTP_ADDR}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token
        - name: IP_FILTER_ENABLE
          value: "false"
        - name: IP_FILTER_ALLOWED_IPS
          value: 0.0.0.0/0
        - name: NATS_ADDR
          value: ${NATS_ENDPOINT}
        readinessProbe:
          httpGet:
            path: /liveness
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /liveness
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 15
---
apiVersion: v1
kind: Service
metadata:
  name: policy
spec:
  selector:
    app: policy
  ports:
  - name: http
    port: 8080
    targetPort: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: task
spec:
  replicas: 1
  selector:
    matchLabels:
      app: task
  template:
    metadata:
      labels:
        app: task
    spec:
      imagePullSecrets:
      - name: regcred
      containers:
      - name: task
        image: ${IMAGES[task]}
        imagePullPolicy: Always
        ports:
        - containerPort: 8080
          name: http
        env:
        - name: LOG_LEVEL
          value: debug
        - name: HTTP_HOST
          value: ""
        - name: HTTP_PORT
          value: "8080"
        - name: HTTP_IDLE_TIMEOUT
          value: 120s
        - name: HTTP_READ_TIMEOUT
          value: 10s
        - name: HTTP_WRITE_TIMEOUT
          value: 10s
        - name: MONGO_ADDR
          value: mongodb://mongo:27017/task?replicaSet=rs0&authSource=admin
        - name: MONGO_USER
          valueFrom:
            secretKeyRef:
              name: mongo-auth
              key: username
        - name: MONGO_PASS
          valueFrom:
            secretKeyRef:
              name: mongo-auth
              key: password
        - name: POLICY_ADDR
          value: http://policy:8080
        - name: CACHE_ADDR
          value: http://cache:8080
        - name: AUTH_ENABLED
          value: "true"
        - name: AUTH_JWK_URL
          value: ${KEYCLOAK_HTTP_ADDR}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs
        - name: AUTH_REFRESH_INTERVAL
          value: 1h
        - name: OAUTH_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: tsa-oauth-client
              key: client-id
        - name: OAUTH_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: tsa-oauth-client
              key: client-secret
        - name: OAUTH_TOKEN_URL
          value: ${KEYCLOAK_HTTP_ADDR}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token
        - name: NATS_ADDR
          value: ${NATS_ENDPOINT}
        readinessProbe:
          httpGet:
            path: /liveness
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /liveness
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 15
---
apiVersion: v1
kind: Service
metadata:
  name: task
spec:
  selector:
    app: task
  ports:
  - name: http
    port: 8080
    targetPort: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cache
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cache
  template:
    metadata:
      labels:
        app: cache
    spec:
      imagePullSecrets:
      - name: regcred
      containers:
      - name: cache
        image: ${IMAGES[cache]}
        imagePullPolicy: Always
        ports:
        - containerPort: 8080
          name: http
        env:
        - name: LOG_LEVEL
          value: debug
        - name: HTTP_HOST
          value: ""
        - name: HTTP_PORT
          value: "8080"
        - name: HTTP_IDLE_TIMEOUT
          value: 120s
        - name: HTTP_READ_TIMEOUT
          value: 10s
        - name: HTTP_WRITE_TIMEOUT
          value: 10s
        - name: REDIS_ADDR
          value: redis:6379
        - name: REDIS_USER
          value: ""
        - name: REDIS_PASS
          value: ""
        - name: REDIS_DB
          value: "0"
        - name: REDIS_EXPIRATION
          value: 1h
        - name: NATS_ADDR
          value: ${NATS_ENDPOINT}
        - name: AUTH_ENABLED
          value: "true"
        - name: AUTH_JWK_URL
          value: ${KEYCLOAK_HTTP_ADDR}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs
        - name: AUTH_REFRESH_INTERVAL
          value: 1h
        - name: OAUTH_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: tsa-oauth-client
              key: client-id
        - name: OAUTH_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: tsa-oauth-client
              key: client-secret
        - name: OAUTH_TOKEN_URL
          value: ${KEYCLOAK_HTTP_ADDR}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token
        readinessProbe:
          httpGet:
            path: /liveness
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /liveness
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 15
---
apiVersion: v1
kind: Service
metadata:
  name: cache
spec:
  selector:
    app: cache
  ports:
  - name: http
    port: 8080
    targetPort: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: infohub
spec:
  replicas: 1
  selector:
    matchLabels:
      app: infohub
  template:
    metadata:
      labels:
        app: infohub
    spec:
      imagePullSecrets:
      - name: regcred
      containers:
      - name: infohub
        image: ${IMAGES[infohub]}
        imagePullPolicy: Always
        ports:
        - containerPort: 8080
          name: http
        env:
        - name: LOG_LEVEL
          value: debug
        - name: HTTP_HOST
          value: ""
        - name: HTTP_PORT
          value: "8080"
        - name: HTTP_IDLE_TIMEOUT
          value: 120s
        - name: HTTP_READ_TIMEOUT
          value: 10s
        - name: HTTP_WRITE_TIMEOUT
          value: 10s
        - name: MONGO_ADDR
          value: mongodb://mongo:27017/infohub?replicaSet=rs0&authSource=admin
        - name: MONGO_USER
          valueFrom:
            secretKeyRef:
              name: mongo-auth
              key: username
        - name: MONGO_PASS
          valueFrom:
            secretKeyRef:
              name: mongo-auth
              key: password
        - name: CACHE_ADDR
          value: http://cache:8080
        - name: POLICY_ADDR
          value: http://policy:8080
        - name: SIGNER_ADDR
          value: ${SIGNER_HTTP_ADDR}
        - name: ISSUER_URI
          value: did:web:${STACK_HOST}:infohub
        - name: AUTH_ENABLED
          value: "true"
        - name: AUTH_JWK_URL
          value: ${KEYCLOAK_HTTP_ADDR}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs
        - name: AUTH_REFRESH_INTERVAL
          value: 1h
        - name: OAUTH_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: tsa-oauth-client
              key: client-id
        - name: OAUTH_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: tsa-oauth-client
              key: client-secret
        - name: OAUTH_TOKEN_URL
          value: ${KEYCLOAK_HTTP_ADDR}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token
        readinessProbe:
          httpGet:
            path: /liveness
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /liveness
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 15
---
apiVersion: v1
kind: Service
metadata:
  name: infohub
spec:
  selector:
    app: infohub
  ports:
  - name: http
    port: 8080
    targetPort: 8080
EOF_APPS

  if [ "$DEPLOY_LOGIN" = "true" ]; then
    cat >>"$WORKDIR/apps.yaml" <<EOF_LOGIN_APPS
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: login
spec:
  replicas: 1
  selector:
    matchLabels:
      app: login
  template:
    metadata:
      labels:
        app: login
    spec:
      imagePullSecrets:
      - name: regcred
      containers:
      - name: login
        image: ${IMAGES[login]}
        imagePullPolicy: Always
        ports:
        - containerPort: 8080
          name: http
        env:
        - name: LOG_LEVEL
          value: debug
        - name: HTTP_HOST
          value: ""
        - name: HTTP_PORT
          value: "8080"
        - name: HTTP_IDLE_TIMEOUT
          value: 2m
        - name: HTTP_READ_TIMEOUT
          value: 10s
        - name: HTTP_WRITE_TIMEOUT
          value: 1m
        - name: ALLOWED_ORIGINS
          value: ${PUBLIC_BASE_URL}
        - name: POLICY_ADDR
          value: http://policy:8080
        - name: POLICY_LOGIN_PATH
          value: /example/loginEmail/1.0/evaluation
        - name: LINK_LOCATION
          value: ${PUBLIC_LOGIN_URL}
        - name: MAIL_ADDR
          value: mailhog:1025
        - name: MAIL_USER
          value: ""
        - name: MAIL_PASS
          value: ""
        - name: MAIL_FROM
          value: no-reply@${STACK_HOST}
        - name: TOKEN_ISSUER
          value: ${PUBLIC_LOGIN_URL}
        - name: TOKEN_AUDIENCE
          value: ${PUBLIC_LOGIN_URL}
        - name: TOKEN_EXPIRATION
          value: 1h
        - name: OCM_ADDR
          value: ${OCM_ADDR}
        - name: OCM_POLL_INTERVAL
          value: 1s
        - name: OCM_POLL_TIMEOUT
          value: 1m
        - name: OCM_LOGIN_SCHEMA_ID
          value: BsfUfTECZPVRnoCgHUfB3p:2:LoginCredentials:1.0
        - name: OCM_LOGIN_CRED_DEF_ID
          value: BsfUfTECZPVRnoCgHUfB3p:3:CL:50014:LoginCredentials2
        - name: PUBLIC_KEY_RSA
          valueFrom:
            secretKeyRef:
              name: login-jwt
              key: public.pem
        - name: PRIVATE_KEY_RSA
          valueFrom:
            secretKeyRef:
              name: login-jwt
              key: private.pem
        readinessProbe:
          httpGet:
            path: /liveness
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /liveness
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 15
---
apiVersion: v1
kind: Service
metadata:
  name: login
spec:
  selector:
    app: login
  ports:
  - name: http
    port: 8080
    targetPort: 8080
EOF_LOGIN_APPS
  fi

  cat >>"$WORKDIR/apps.yaml" <<EOF_PUBLIC_INGRESS
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tsa-public
  annotations:
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: /\$2
spec:
  ingressClassName: nginx
  tls:
  - hosts: [${STACK_HOST}]
    secretName: ${TLS_SECRET}
  rules:
  - host: ${STACK_HOST}
    http:
      paths:
      - path: /infohub(/|\$)(.*)
        pathType: ImplementationSpecific
        backend:
          service:
            name: infohub
            port:
              number: 8080
EOF_PUBLIC_INGRESS

  if [ "$DEPLOY_LOGIN" = "true" ]; then
    cat >>"$WORKDIR/apps.yaml" <<EOF_PUBLIC_LOGIN
      - path: /login(/|\$)(.*)
        pathType: ImplementationSpecific
        backend:
          service:
            name: login
            port:
              number: 8080
EOF_PUBLIC_LOGIN
  fi

  kubectl -n "$NAMESPACE" apply -f "$WORKDIR/apps.yaml"
}

wait_apps() {
  log "waiting for TSA applications"
  kubectl -n "$NAMESPACE" rollout status deployment/policy --timeout=15m
  kubectl -n "$NAMESPACE" rollout status deployment/task --timeout=15m
  kubectl -n "$NAMESPACE" rollout status deployment/cache --timeout=15m
  kubectl -n "$NAMESPACE" rollout status deployment/infohub --timeout=15m
  if [ "$DEPLOY_LOGIN" = "true" ]; then
    kubectl -n "$NAMESPACE" rollout status deployment/login --timeout=15m
  fi
}

assert_http_local() {
  local service="$1"
  local local_port="$2"
  local remote_port="$3"
  local path="$4"
  local pid ok=""
  pid="$(run_port_forward_ns "$NAMESPACE" "$service" "$local_port" "$remote_port")"
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${local_port}${path}" >/dev/null 2>&1; then
      ok="yes"
      break
    fi
    sleep 3
  done
  stop_port_forward "$pid"
  [ -n "$ok" ] || die "smoke check failed for ${service}${path}"
}

assert_keycloak_token() {
  local pid ok=""
  pid="$(run_port_forward_ns "$OCMW_NAMESPACE" "$KEYCLOAK_SERVICE" 18501 "$KEYCLOAK_SERVICE_PORT")"
  for _ in $(seq 1 40); do
    if curl -fsS -X POST "http://127.0.0.1:18501/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      -d "grant_type=client_credentials&client_id=${WORKSPACE_CLIENT_ID}&client_secret=${WORKSPACE_CLIENT_SECRET}" | grep -q access_token; then
      ok="yes"
      break
    fi
    sleep 3
  done
  stop_port_forward "$pid"
  [ -n "$ok" ] || die "failed to obtain Keycloak access token from shared realm ${KEYCLOAK_REALM}"
}

assert_signer_sign() {
  local pid ok="" key payload
  pid="$(run_port_forward_ns "$OCMW_NAMESPACE" "$SIGNER_SERVICE" 18085 "$SIGNER_SERVICE_PORT")"
  for key in SDJWTCredential signerkey key1; do
    payload="{\"key\":\"${key}\",\"namespace\":\"transit\",\"data\":\"SGVsbG8gd29ybGQ=\"}"
    for _ in $(seq 1 12); do
      if curl -fsS -X POST "http://127.0.0.1:18085/v1/sign" \
        -H "Content-Type: application/json" \
        -d "$payload" >/dev/null 2>&1; then
        ok="yes"
        break 2
      fi
      sleep 2
    done
  done
  stop_port_forward "$pid"
  [ -n "$ok" ] || die "shared signer smoke check failed"
}

smoke_tests() {
  log "running smoke tests"
  assert_http_local policy 18081 8080 /liveness
  assert_http_local task 18082 8080 /liveness
  assert_http_local cache 18083 8080 /liveness
  assert_http_local infohub 18084 8080 /liveness
  if [ "$DEPLOY_LOGIN" = "true" ]; then
    assert_http_local login 18087 8080 /liveness
  fi
  assert_keycloak_token
  assert_signer_sign
}

summary_output() {
  echo "######################################################"
  echo "############### TSA READY (OCMW SHARED) ##############"
  echo "######################################################"
  echo "tsa namespace: ${NAMESPACE}"
  echo "ocmw namespace: ${OCMW_NAMESPACE}"
  echo "registry prefix: ${REGISTRY_IMAGE_PREFIX}"
  echo "image tag: ${IMAGE_TAG}"
  echo ""
  echo "public host: ${PUBLIC_BASE_URL}"
  echo "public routes:"
  echo "  infohub: ${PUBLIC_INFOHUB_URL}"
  if [ "$DEPLOY_LOGIN" = "true" ]; then
    echo "  login:   ${PUBLIC_LOGIN_URL}"
  fi
  echo ""
  echo "internal shared services:"
  echo "  keycloak: ${KEYCLOAK_HTTP_ADDR}"
  echo "  signer:   ${SIGNER_HTTP_ADDR}"
  echo "  nats:     ${NATS_ENDPOINT}"
  echo "  resolver: ${DID_RESOLVER_HTTP_ADDR}"
  echo ""
  echo "local internal services:"
  echo "  policy:  http://policy.${NAMESPACE}.svc.cluster.local:8080"
  echo "  task:    http://task.${NAMESPACE}.svc.cluster.local:8080"
  echo "  cache:   http://cache.${NAMESPACE}.svc.cluster.local:8080"
  echo "  infohub: http://infohub.${NAMESPACE}.svc.cluster.local:8080"
  if [ "$DEPLOY_LOGIN" = "true" ]; then
    echo "  login:   http://login.${NAMESPACE}.svc.cluster.local:8080"
    echo "  mailhog: http://mailhog.${NAMESPACE}.svc.cluster.local:8025"
  fi
  echo ""
  echo "auth:"
  echo "  keycloak realm: ${KEYCLOAK_REALM}"
  echo "  keycloak client id: ${WORKSPACE_CLIENT_ID}"
  echo "  keycloak client secret: ${WORKSPACE_CLIENT_SECRET}"
  echo ""
  echo "database:"
  echo "  mongo root user: ${MONGO_ROOT_USER}"
  echo "  mongo root password: ${MONGO_ROOT_PASSWORD}"
  echo ""
  echo "notes:"
  echo "  OCM address: ${OCM_ADDR}"
  if [ -n "$EMAIL" ]; then
    echo "  email: ${EMAIL}"
  fi
  echo "  shared OCMW services are not modified on uninstall."
}

main() {
  ensure_namespace
  discover_ocmw_shared_services
  ensure_ingress_nginx
  ensure_cert_manager
  create_tls_secret
  load_stateful_values
  create_runtime_secrets_and_config
  create_registry_secret
  docker_login

  build_component policy \
    https://github.com/eclipse-xfsc/custom-policy-agent.git \
    https://gitlab.eclipse.org/eclipse/xfsc/tsa/policy.git

  build_component cache \
    https://github.com/eclipse-xfsc/redis-cache-service.git \
    https://gitlab.eclipse.org/eclipse/xfsc/tsa/cache.git

  build_component infohub \
    https://github.com/eclipse-xfsc/trusted-info-hub.git \
    https://gitlab.eclipse.org/eclipse/xfsc/tsa/infohub.git

  build_component task \
    https://github.com/eclipse-xfsc/task-sheduler.git \
    https://gitlab.eclipse.org/eclipse/xfsc/tsa/task.git

  if [ "$DEPLOY_LOGIN" = "true" ]; then
    build_component login https://gitlab.eclipse.org/eclipse/xfsc/tsa/login.git
  fi

  apply_infra
  wait_infra
  init_mongo_replica_set
  bootstrap_shared_keycloak
  apply_apps
  wait_apps
  smoke_tests
  summary_output
}

main "$@"
