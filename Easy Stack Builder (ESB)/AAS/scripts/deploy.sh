#!/bin/bash

set -Eeuo pipefail

# NF-3: cluster-wide ingress-nginx changes are explicit opt-in operations.
MANAGE_INGRESS_NGINX="${MANAGE_INGRESS_NGINX:-false}"
ALLOW_INGRESS_ADMISSION_WEBHOOK_DELETION="${ALLOW_INGRESS_ADMISSION_WEBHOOK_DELETION:-false}"
[[ "$MANAGE_INGRESS_NGINX" == "true" || "$MANAGE_INGRESS_NGINX" == "false" ]] \
  || { printf '%s\n' 'MANAGE_INGRESS_NGINX must be true or false' >&2; exit 2; }
[[ "$ALLOW_INGRESS_ADMISSION_WEBHOOK_DELETION" == "true" || "$ALLOW_INGRESS_ADMISSION_WEBHOOK_DELETION" == "false" ]] \
  || { printf '%s\n' 'ALLOW_INGRESS_ADMISSION_WEBHOOK_DELETION must be true or false' >&2; exit 2; }
if [[ "$ALLOW_INGRESS_ADMISSION_WEBHOOK_DELETION" == "true" && "$MANAGE_INGRESS_NGINX" != "true" ]]; then
  printf '%s\n' 'Admission-webhook deletion requires Manage ingress-nginx to be enabled' >&2
  exit 2
fi
export MANAGE_INGRESS_NGINX ALLOW_INGRESS_ADMISSION_WEBHOOK_DELETION

esb_require_ingress_nginx_prerequisites() {
  kubectl -n ingress-nginx get deployment ingress-nginx-controller >/dev/null
  local allow_snippets risk_level tls_protocols
  allow_snippets="$(kubectl -n ingress-nginx get configmap ingress-nginx-controller -o 'go-template={{index .data "allow-snippet-annotations"}}')"
  risk_level="$(kubectl -n ingress-nginx get configmap ingress-nginx-controller -o 'go-template={{index .data "annotations-risk-level"}}')"
  tls_protocols="$(kubectl -n ingress-nginx get configmap ingress-nginx-controller -o 'go-template={{index .data "ssl-protocols"}}')"
  [[ "$allow_snippets" == "true" ]] || { printf '%s\n' 'ingress-nginx prerequisite missing: allow-snippet-annotations=true. Enable Manage ingress-nginx or configure the controller.' >&2; return 1; }
  [[ "${risk_level,,}" == "critical" ]] || { printf '%s\n' 'ingress-nginx prerequisite missing: annotations-risk-level=Critical. Enable Manage ingress-nginx or configure the controller.' >&2; return 1; }
  [[ "$tls_protocols" == *TLSv1.3* ]] || { printf '%s\n' 'ingress-nginx prerequisite missing: ssl-protocols must include TLSv1.3. Enable Manage ingress-nginx or configure the controller.' >&2; return 1; }
}


ingress_admission_failure() {
  printf 'ERROR: ingress-nginx admission webhook TLS is unhealthy: %s. The Node-RED CA bundle does not affect this trust path. Repair the webhook externally or enable "Manage ingress-nginx" for automatic certificate regeneration; the separate deletion option is emergency fallback only.\n' "$1" >&2
  return 1
}

esb_check_ingress_admission_tls() {
  local webhook_name='ingress-nginx-admission'
  local webhook_json webhook_namespace secret_json secret_ca secret_cert tmp_dir webhook_ca

  if ! kubectl get validatingwebhookconfiguration "$webhook_name" >/dev/null 2>&1; then
    return 0
  fi

  webhook_json="$(kubectl get validatingwebhookconfiguration "$webhook_name" -o json)"
  webhook_namespace="$(printf '%s' "$webhook_json" | jq -r '.webhooks[0].clientConfig.service.namespace // "ingress-nginx"')"
  if ! secret_json="$(kubectl -n "$webhook_namespace" get secret ingress-nginx-admission -o json 2>/dev/null)"; then
    ingress_admission_failure "Secret ${webhook_namespace}/ingress-nginx-admission is missing"
    return 1
  fi

  secret_ca="$(printf '%s' "$secret_json" | jq -r '.data.ca // empty')"
  secret_cert="$(printf '%s' "$secret_json" | jq -r '.data.cert // .data["tls.crt"] // empty')"
  [[ -n "$secret_ca" ]] || { ingress_admission_failure 'admission Secret has no CA certificate'; return 1; }
  [[ -n "$secret_cert" ]] || { ingress_admission_failure 'admission Secret has no serving certificate'; return 1; }

  while IFS= read -r webhook_ca; do
    [[ -n "$webhook_ca" ]] || { ingress_admission_failure 'ValidatingWebhookConfiguration has an empty caBundle'; return 1; }
    [[ "$webhook_ca" == "$secret_ca" ]] || { ingress_admission_failure 'ValidatingWebhookConfiguration caBundle does not match the admission Secret CA'; return 1; }
  done < <(printf '%s' "$webhook_json" | jq -r '[.webhooks[].clientConfig.caBundle // empty] | unique[]')

  tmp_dir="$(mktemp -d)"
  chmod 700 "$tmp_dir"
  if ! printf '%s' "$secret_ca" | base64 --decode >"$tmp_dir/ca.crt" 2>/dev/null; then
    printf '%s' "$secret_ca" | base64 -d >"$tmp_dir/ca.crt" 2>/dev/null \
      || { rm -rf "$tmp_dir"; ingress_admission_failure 'admission CA data is not valid base64'; return 1; }
  fi
  if ! printf '%s' "$secret_cert" | base64 --decode >"$tmp_dir/server.crt" 2>/dev/null; then
    printf '%s' "$secret_cert" | base64 -d >"$tmp_dir/server.crt" 2>/dev/null \
      || { rm -rf "$tmp_dir"; ingress_admission_failure 'admission certificate data is not valid base64'; return 1; }
  fi
  openssl x509 -in "$tmp_dir/ca.crt" -noout -checkend 0 >/dev/null 2>&1 \
    || { rm -rf "$tmp_dir"; ingress_admission_failure 'admission CA certificate is expired or invalid'; return 1; }
  openssl x509 -in "$tmp_dir/server.crt" -noout -checkend 0 >/dev/null 2>&1 \
    || { rm -rf "$tmp_dir"; ingress_admission_failure 'admission serving certificate is expired or invalid'; return 1; }
  openssl verify -CAfile "$tmp_dir/ca.crt" "$tmp_dir/server.crt" >/dev/null 2>&1 \
    || { rm -rf "$tmp_dir"; ingress_admission_failure 'admission serving certificate is not signed by the configured CA'; return 1; }
  rm -rf "$tmp_dir"
}

esb_probe_ingress_admission() {
  local output=""
  if ! output="$(cat <<'EOF_INGRESS_PROBE' | kubectl apply --dry-run=server -f - 2>&1
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: esb-ingress-admission-probe
  namespace: default
spec:
  ingressClassName: nginx
  rules:
    - host: esb-ingress-admission-probe.invalid
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: kubernetes
                port:
                  number: 443
EOF_INGRESS_PROBE
)"; then
    printf '%s\n' "$output" >&2
    ingress_admission_failure 'the Kubernetes API server cannot complete a server-side dry-run through validate.nginx.ingress.kubernetes.io'
    return 1
  fi
}

esb_repair_ingress_admission() {
  local webhook_name='ingress-nginx-admission'
  local webhook_json webhook_namespace webhook_service tmp_dir ca_bundle patch_json

  log 'Repairing ingress-nginx admission certificate and CA bundle under explicit Manage ingress-nginx opt-in'
  webhook_json="$(kubectl get validatingwebhookconfiguration "$webhook_name" -o json)"
  webhook_namespace="$(printf '%s' "$webhook_json" | jq -r '[.webhooks[].clientConfig.service.namespace // empty] | unique | if length == 1 then .[0] else empty end')"
  webhook_service="$(printf '%s' "$webhook_json" | jq -r '[.webhooks[].clientConfig.service.name // empty] | unique | if length == 1 then .[0] else empty end')"
  [[ -n "$webhook_namespace" ]] || { printf '%s\n' 'Unable to determine a single ingress admission namespace from the ValidatingWebhookConfiguration' >&2; return 1; }
  [[ -n "$webhook_service" ]] || { printf '%s\n' 'Unable to determine a single ingress admission Service from the ValidatingWebhookConfiguration' >&2; return 1; }
  kubectl -n "$webhook_namespace" get service "$webhook_service" >/dev/null

  # The upstream certificate jobs are not a deployment prerequisite. They can
  # remain failed or unschedulable on otherwise compatible clusters, so stop
  # relying on their completion and rotate the admission trust material here.
  if ! kubectl -n "$webhook_namespace" delete job ingress-nginx-admission-create ingress-nginx-admission-patch \
      --ignore-not-found --wait=false >/dev/null 2>&1; then
    log 'Warning: could not remove old ingress-nginx admission certificate jobs; continuing with direct certificate rotation'
  fi

  tmp_dir="$(mktemp -d)"
  chmod 700 "$tmp_dir"
  cat >"$tmp_dir/ca.cnf" <<EOF_CA_CONFIG
[req]
prompt = no
distinguished_name = dn
x509_extensions = v3_ca
[dn]
CN = ingress-nginx-admission-ca
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
EOF_CA_CONFIG
  cat >"$tmp_dir/server.cnf" <<EOF_SERVER_CONFIG
[req]
prompt = no
distinguished_name = dn
req_extensions = v3_req
[dn]
CN = ${webhook_service}.${webhook_namespace}.svc
[v3_req]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
DNS.1 = ${webhook_service}
DNS.2 = ${webhook_service}.${webhook_namespace}
DNS.3 = ${webhook_service}.${webhook_namespace}.svc
DNS.4 = ${webhook_service}.${webhook_namespace}.svc.cluster.local
EOF_SERVER_CONFIG

  if ! openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
      -config "$tmp_dir/ca.cnf" -keyout "$tmp_dir/ca.key" -out "$tmp_dir/ca.crt" >/dev/null 2>&1 \
    || ! openssl req -new -newkey rsa:2048 -nodes -sha256 \
      -config "$tmp_dir/server.cnf" -keyout "$tmp_dir/server.key" -out "$tmp_dir/server.csr" >/dev/null 2>&1 \
    || ! openssl x509 -req -sha256 -days 3650 \
      -in "$tmp_dir/server.csr" -CA "$tmp_dir/ca.crt" -CAkey "$tmp_dir/ca.key" -CAcreateserial \
      -extensions v3_req -extfile "$tmp_dir/server.cnf" -out "$tmp_dir/server.crt" >/dev/null 2>&1; then
    rm -rf "$tmp_dir"
    printf '%s\n' 'Failed to generate ingress-nginx admission certificates' >&2
    return 1
  fi

  if ! kubectl -n "$webhook_namespace" create secret generic ingress-nginx-admission \
      --from-file=cert="$tmp_dir/server.crt" \
      --from-file=key="$tmp_dir/server.key" \
      --from-file=ca="$tmp_dir/ca.crt" \
      --dry-run=client -o yaml | kubectl apply -f - >/dev/null; then
    rm -rf "$tmp_dir"
    printf '%s\n' 'Failed to apply regenerated ingress-nginx admission Secret' >&2
    return 1
  fi

  ca_bundle="$(base64 <"$tmp_dir/ca.crt" | tr -d '\r\n')"
  patch_json="$(printf '%s' "$webhook_json" | jq -c --arg ca "$ca_bundle" '{webhooks: [.webhooks[] | (.clientConfig.caBundle = $ca)]}')"
  if ! kubectl patch validatingwebhookconfiguration "$webhook_name" --type=merge -p "$patch_json" >/dev/null; then
    rm -rf "$tmp_dir"
    printf '%s\n' 'Failed to patch the ingress-nginx admission CA bundle' >&2
    return 1
  fi

  rm -rf "$tmp_dir"
  log 'Ingress-nginx admission Secret and ValidatingWebhookConfiguration CA bundle were rotated directly'
}


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
ESB_GENERATED_VALUES_FILE=""
KEYCLOAK_VALUES_FILE=""
KEYCLOAK_REALM_FILE=""
AAS_VALUES_FILE=""
AAS_SECRET_VALUES_FILE=""

export KUBECONFIG="$KUBE"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHART_DIR="$ROOT_DIR/helm"
cd "$ROOT_DIR"

cleanup() {
  set +e
  local temporary_file
  for temporary_file in \
    "${AAS_DB_VALUES_FILE:-}" \
    "${ESB_GENERATED_VALUES_FILE:-}" \
    "${KEYCLOAK_VALUES_FILE:-}" \
    "${KEYCLOAK_REALM_FILE:-}" \
    "${AAS_VALUES_FILE:-}" \
    "${AAS_SECRET_VALUES_FILE:-}"; do
    [ -n "$temporary_file" ] && [ -f "$temporary_file" ] && rm -f "$temporary_file"
  done
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
    # The Secret may not exist yet while polling; an empty result is retried.
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

  # Diagnostic collection is best effort and must not hide the primary failure.
  kubectl -n "$ns" get pods -l "$selector" -o wide || true
  if [ -n "$pod" ]; then
    # Pod description and logs may be unavailable during startup; both are advisory.
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
  chmod 600 "$AAS_DB_VALUES_FILE"
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

for bin in kubectl helm openssl jq curl sed grep base64 mktemp tr python3; do
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
helm repo add bitnami https://charts.bitnami.com/bitnami --force-update >/dev/null
helm repo add jetstack https://charts.jetstack.io --force-update >/dev/null

log "Checking ingress-nginx prerequisites"
if [[ "$MANAGE_INGRESS_NGINX" == "true" ]]; then
  log "Reconciling ingress-nginx because management was explicitly enabled"
  kubectl get namespace ingress-nginx >/dev/null 2>&1 || kubectl create namespace ingress-nginx

  if ! kubectl -n ingress-nginx get deployment ingress-nginx-controller >/dev/null 2>&1; then
    log "No ingress-nginx controller Deployment was found; installing the project-pinned controller manifest"
    command curl --fail --silent --show-error --location "$ING_URL" | kubectl apply -f -
    wait_for_deploy ingress-nginx ingress-nginx-controller 10m
  else
    log "Using the existing ingress-nginx controller; no Kubernetes or kubectl minor-version gate is applied"
  fi

  ingress_admission_repair_failed="false"
  if ! esb_check_ingress_admission_tls >/dev/null 2>&1 || ! esb_probe_ingress_admission >/dev/null 2>&1; then
    log "Detected an unhealthy ingress-nginx admission certificate or API-server trust path"
    if ! esb_repair_ingress_admission; then
      ingress_admission_repair_failed="true"
    fi
  fi

  kubectl -n ingress-nginx patch configmap ingress-nginx-controller \
    --type merge \
    -p '{"data":{"allow-snippet-annotations":"true","annotations-risk-level":"Critical","ssl-protocols":"TLSv1.3"}}'
  kubectl -n ingress-nginx rollout restart deployment/ingress-nginx-controller
  wait_for_deploy ingress-nginx ingress-nginx-controller 10m

  if [[ "$ingress_admission_repair_failed" == "true" ]] \
    || ! esb_check_ingress_admission_tls \
    || ! esb_probe_ingress_admission; then
    if [[ "$ALLOW_INGRESS_ADMISSION_WEBHOOK_DELETION" == "true" ]]; then
      log "Admission repair did not validate; deleting ingress-nginx admission webhook under the separate emergency opt-in"
      kubectl delete validatingwebhookconfiguration ingress-nginx-admission --ignore-not-found
    else
      die "ingress-nginx admission webhook is still unhealthy after direct certificate rotation; enable the separate deletion opt-in only if cluster policy permits bypassing ingress admission"
    fi
  else
    log "ingress-nginx admission webhook TLS validation passed"
  fi
else
  log "Ingress-nginx management disabled; performing read-only prerequisite checks"
  esb_require_ingress_nginx_prerequisites
  esb_check_ingress_admission_tls
  esb_probe_ingress_admission
fi

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

ESB_GENERATED_SECRET_NAME="esb-aas-generated-credentials"
if ! kubectl -n "$NAMESPACE" get secret "$ESB_GENERATED_SECRET_NAME" >/dev/null 2>&1; then
  oidc_password="{noop}$(openssl rand -hex 24)"
  siop_password="{noop}$(openssl rand -hex 24)"
  aas_db_password="$(openssl rand -hex 24)"
  demo_app_secret="$(openssl rand -hex 24)"
  jwk_secret="$(openssl rand -hex 32)"
  kubectl -n "$NAMESPACE" create secret generic "$ESB_GENERATED_SECRET_NAME" \
    --from-literal=oidc-password="$oidc_password" \
    --from-literal=siop-password="$siop_password" \
    --from-literal=aas-db-password="$aas_db_password" \
    --from-literal=demo-app-secret="$demo_app_secret" \
    --from-literal=jwk-secret="$jwk_secret" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  unset oidc_password siop_password aas_db_password demo_app_secret jwk_secret
fi

if [[ -z "$(kubectl -n "$NAMESPACE" get secret "$ESB_GENERATED_SECRET_NAME" -o jsonpath='{.data.jwk-secret}' 2>/dev/null)" ]]; then
  jwk_secret="$(openssl rand -hex 32)"
  jwk_secret_b64="$(printf '%s' "$jwk_secret" | base64 | tr -d '\n')"
  kubectl -n "$NAMESPACE" get secret "$ESB_GENERATED_SECRET_NAME" -o json \
    | jq --arg value "$jwk_secret_b64" '.data["jwk-secret"]=$value' \
    | kubectl apply -f - >/dev/null
  unset jwk_secret jwk_secret_b64
fi

if ! kubectl -n "$NAMESPACE" get secret keycloak-init-secrets >/dev/null 2>&1; then
  keycloak_password="$(openssl rand -hex 24)"
  keycloak_postgres_password="$(openssl rand -hex 24)"
  keycloak_admin_password="$(openssl rand -hex 24)"
  kubectl -n "$NAMESPACE" create secret generic keycloak-init-secrets \
    --from-literal=username=admin \
    --from-literal=password="$keycloak_password" \
    --from-literal=postgres-password="$keycloak_postgres_password" \
    --from-literal=admin-password="$keycloak_admin_password" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  unset keycloak_password keycloak_postgres_password keycloak_admin_password
fi

OIDC_PASSWORD="$(kubectl -n "$NAMESPACE" get secret "$ESB_GENERATED_SECRET_NAME" -o jsonpath='{.data.oidc-password}' | base64 -d)"
SIOP_PASSWORD="$(kubectl -n "$NAMESPACE" get secret "$ESB_GENERATED_SECRET_NAME" -o jsonpath='{.data.siop-password}' | base64 -d)"
GENERATED_AAS_DB_PASSWORD="$(kubectl -n "$NAMESPACE" get secret "$ESB_GENERATED_SECRET_NAME" -o jsonpath='{.data.aas-db-password}' | base64 -d)"
JWK_SECRET="$(kubectl -n "$NAMESPACE" get secret "$ESB_GENERATED_SECRET_NAME" -o jsonpath='{.data.jwk-secret}' | base64 -d)"

ESB_GENERATED_VALUES_FILE="$(mktemp)"
chmod 600 "$ESB_GENERATED_VALUES_FILE"
cat >"$ESB_GENERATED_VALUES_FILE" <<EOF_ESB_GENERATED_VALUES
secrets:
  oidc:
    password: "${OIDC_PASSWORD}"
  siop:
    password: "${SIOP_PASSWORD}"
properties:
  aas:
    iam:
      clients:
        oidc:
          secret: "${OIDC_PASSWORD}"
        siop:
          secret: "${SIOP_PASSWORD}"
keycloak:
  auth:
    passwordSecretKey: password
EOF_ESB_GENERATED_VALUES
unset OIDC_PASSWORD SIOP_PASSWORD

case "$DB_TYPE" in
  embedded)
    AAS_DB_URL="jdbc:postgresql://postgres-postgresql:5432/aas"
    AAS_DB_USERNAME="aas"
    AAS_DB_PASSWORD="$GENERATED_AAS_DB_PASSWORD"

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
    wait_for_pod_by_label "$NAMESPACE" "$POSTGRES_SELECTOR" 10m

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

log "Rendering deployment-specific Keycloak values and realm"
KEYCLOAK_VALUES_FILE="$(mktemp)"
KEYCLOAK_REALM_FILE="$(mktemp)"
chmod 600 "$KEYCLOAK_VALUES_FILE" "$KEYCLOAK_REALM_FILE"
sed \
  -e 's/\<DOMAIN\>/'"$DOMAIN"'/g' \
  -e 's/\<TLS_SECRET\>/'"$TLS_SECRET"'/g' \
  "$CHART_DIR/Keycloak/values.yaml" >"$KEYCLOAK_VALUES_FILE"
sed \
  -e 's/\<DOMAIN\>/'"$DOMAIN"'/g' \
  "$CHART_DIR/Keycloak/realm/gaia-x-realm.json" >"$KEYCLOAK_REALM_FILE"

kubectl -n "$NAMESPACE" create configmap gaia-x-realm-config \
  --from-file=gaia-x-realm.json="$KEYCLOAK_REALM_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -

log "Installing Keycloak"
helm dependency build "$CHART_DIR/Keycloak"
helm upgrade --install keycloak "$CHART_DIR/Keycloak" \
  --namespace "$NAMESPACE" \
  -f "$KEYCLOAK_VALUES_FILE" \
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
  --timeout 30m --values "${ESB_GENERATED_VALUES_FILE}"

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
" >/dev/null 2>&1

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


log "Rendering deployment-specific AAS values and installing AAS"
AAS_VALUES_FILE="$(mktemp)"
chmod 600 "$AAS_VALUES_FILE"
sed \
  -e 's/\<DOMAIN\>/'"$DOMAIN"'/g' \
  -e 's/\<TLS_SECRET\>/'"$TLS_SECRET"'/g' \
  "$CHART_DIR/AAS/values.yaml" >"$AAS_VALUES_FILE"

AAS_SECRET_VALUES_FILE="$(mktemp)"
chmod 600 "$AAS_SECRET_VALUES_FILE"
cat >"$AAS_SECRET_VALUES_FILE" <<EOF_AAS_SECRET_VALUES
secrets:
  keys:
    iat: "${IAT_TOKEN}"
    jwk: "${JWK_SECRET}"
EOF_AAS_SECRET_VALUES

helm upgrade --install auth-server "$CHART_DIR/AAS" \
  --namespace "$NAMESPACE" \
  -f "$AAS_VALUES_FILE" \
  -f "$AAS_DB_VALUES_FILE" \
  -f "$AAS_SECRET_VALUES_FILE" \
  --wait \
  --timeout 15m --values "${ESB_GENERATED_VALUES_FILE}"

log "Checking AAS deployment"
wait_for_deploy "$NAMESPACE" aas 10m
kubectl -n "$NAMESPACE" get ingress,svc,deploy,pods

AUTH_SERVER_URL="https://auth-server.${DOMAIN}"
KEY_SERVER_URL="https://key-server.${DOMAIN}"
kubectl -n "${NAMESPACE}" rollout status deployment/test-server --timeout=300s
TEST_SERVER_ENDPOINTS="$(kubectl -n "$NAMESPACE" get endpoints test-server -o jsonpath='{.subsets[*].addresses[*].ip}')"
[[ -n "$TEST_SERVER_ENDPOINTS" ]] || die "test-server Service has no ready endpoints"
TEST_URL="https://test-server.${DOMAIN}/demo"
KEYCLOAK_ADMIN_USERNAME="admin"
KEYCLOAK_REALM="gaia-x"
[[ -n "${TEST_URL:-}" ]] || { printf '%s\n' 'AAS test-server URL was not emitted' >&2; exit 1; }
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