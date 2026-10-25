#!/usr/bin/env bash

set -uo pipefail

usage() {
  cat <<'USAGE'
Usage:
  runtime-health.sh --namespace <namespace> --domain <base-domain> --output-json <file> [options]

Options:
  --ca-bundle <file>       CA bundle used for verified HTTPS checks.
  --evidence-dir <dir>     Directory for JSON, Markdown, and command logs.
  --timeout <duration>     Workload rollout timeout (default: 20m).
  --test-image <image>     Temporary connectivity-test image (default: busybox:1.36.1).

The test verifies deployment health only. It does not issue credentials, execute
OIDC workflows, mutate application data, or test OCM business functionality.
USAGE
}

NAMESPACE=""
DOMAIN=""
OUTPUT_JSON=""
CA_BUNDLE=""
EVIDENCE_DIR=""
ROLLOUT_TIMEOUT="20m"
TEST_IMAGE="${OCM_TEST_IMAGE:-busybox:1.36.1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --output-json) OUTPUT_JSON="${2:-}"; shift 2 ;;
    --ca-bundle) CA_BUNDLE="${2:-}"; shift 2 ;;
    --evidence-dir) EVIDENCE_DIR="${2:-}"; shift 2 ;;
    --timeout) ROLLOUT_TIMEOUT="${2:-}"; shift 2 ;;
    --test-image) TEST_IMAGE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$NAMESPACE" ]] || { echo "--namespace is required" >&2; exit 2; }
[[ -n "$DOMAIN" ]] || { echo "--domain is required" >&2; exit 2; }
[[ -n "$OUTPUT_JSON" && -f "$OUTPUT_JSON" ]] || { echo "--output-json must reference the captured OCM deployment output" >&2; exit 2; }
[[ -z "$CA_BUNDLE" || -f "$CA_BUNDLE" ]] || { echo "--ca-bundle does not exist: $CA_BUNDLE" >&2; exit 2; }

for cmd in kubectl jq curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Required command not found: $cmd" >&2; exit 2; }
done

if [[ -z "$EVIDENCE_DIR" ]]; then
  EVIDENCE_DIR="$(pwd)/ocmwstack-runtime-evidence-$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p "$EVIDENCE_DIR/logs"
RESULTS_NDJSON="$EVIDENCE_DIR/results.ndjson"
: > "$RESULTS_NDJSON"
PASS_COUNT=0
FAIL_COUNT=0
TEST_POD="ocm-health-${RANDOM}-$(date +%s)"

cleanup() {
  kubectl -n "$NAMESPACE" delete pod "$TEST_POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

record_result() {
  local name="$1" status="$2" detail="$3"
  jq -cn --arg name "$name" --arg status "$status" --arg detail "$detail" \
    '{name:$name,status:$status,detail:$detail}' >> "$RESULTS_NDJSON"
  if [[ "$status" == "passed" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf 'PASS  %s\n' "$name"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf 'FAIL  %s: %s\n' "$name" "$detail" >&2
  fi
}

slugify() {
  printf '%s' "$1" | tr '[:upper:] /' '[:lower:]--' | tr -cd 'a-z0-9._-'
}

run_check() {
  local name="$1"
  shift
  local log="$EVIDENCE_DIR/logs/$(slugify "$name").log"
  if "$@" >"$log" 2>&1; then
    record_result "$name" "passed" "$(tail -n 1 "$log" 2>/dev/null || true)"
  else
    local detail
    detail="$(tail -n 20 "$log" 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
    record_result "$name" "failed" "${detail:-check failed}"
  fi
}

check_namespace() {
  kubectl get namespace "$NAMESPACE" -o name
}

check_workloads() {
  local resource found=0
  while IFS= read -r resource; do
    [[ -n "$resource" ]] || continue
    found=1
    kubectl -n "$NAMESPACE" rollout status "$resource" --timeout="$ROLLOUT_TIMEOUT"
  done < <(kubectl -n "$NAMESPACE" get deployments,statefulsets -o name)
  [[ "$found" -eq 1 ]] || { echo "No Deployments or StatefulSets found" >&2; return 1; }
}

check_pods_ready() {
  kubectl -n "$NAMESPACE" get pods -o json | jq -e '
    (.items | length) > 0 and
    all(.items[];
      if .status.phase == "Succeeded" then true
      else
        .metadata.deletionTimestamp == null and
        .status.phase == "Running" and
        ((.status.containerStatuses // []) | length) > 0 and
        all(.status.containerStatuses[]; .ready == true)
      end
    )' >/dev/null
}

check_service_endpoints() {
  local service count
  local services=(
    cassandra nats redis-master postgres-postgresql keycloak vault
    didcomm-connector universal-resolver-service signer
  )
  for service in "${services[@]}"; do
    kubectl -n "$NAMESPACE" get service "$service" >/dev/null
    count="$(kubectl -n "$NAMESPACE" get endpoints "$service" -o json | jq '[.subsets[]?.addresses[]?] | length')"
    [[ "$count" -gt 0 ]] || { echo "Service has no ready endpoint: $service" >&2; return 1; }
    printf '%s endpoints=%s\n' "$service" "$count"
  done
}

check_internal_connectivity() {
  local script phase
  script='set -eu
for target in cassandra:9042 nats:4222 redis-master:6379 postgres-postgresql:5432 keycloak:80 vault:8200 didcomm-connector:9090 universal-resolver-service:8080 signer:8080; do
  host="${target%:*}"; port="${target##*:}"
  nc -z -w 10 "$host" "$port"
done
wget -q -T 20 -O /dev/null http://keycloak/realms/master
wget -q -T 20 -O /dev/null http://didcomm-connector:9090/health
wget -q -T 20 -O /dev/null http://signer:8080/readiness
'
  kubectl -n "$NAMESPACE" delete pod "$TEST_POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" run "$TEST_POD" \
    --image="$TEST_IMAGE" --restart=Never --command -- sh -ec "$script" >/dev/null

  for _ in $(seq 1 180); do
    phase="$(kubectl -n "$NAMESPACE" get pod "$TEST_POD" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    case "$phase" in
      Succeeded) kubectl -n "$NAMESPACE" logs "$TEST_POD" 2>/dev/null || true; return 0 ;;
      Failed) kubectl -n "$NAMESPACE" logs "$TEST_POD" 2>/dev/null || true; return 1 ;;
    esac
    sleep 2
  done
  kubectl -n "$NAMESPACE" describe pod "$TEST_POD" || true
  return 1
}

check_ingress_resources() {
  local count
  count="$(kubectl -n "$NAMESPACE" get ingress -o json | jq '[.items[] | select((.status.loadBalancer.ingress // []) | length > 0)] | length')"
  [[ "$count" -gt 0 ]] || { echo "No ingress has a load-balancer address" >&2; return 1; }
  kubectl -n "$NAMESPACE" get ingress -o wide
}

check_external_https() {
  local curl_args code url
  curl_args=(--silent --show-error --output /dev/null --connect-timeout 15 --max-time 60 --tlsv1.3 --write-out '%{http_code}')
  if [[ -n "$CA_BUNDLE" ]]; then
    curl_args+=(--cacert "$CA_BUNDLE")
  fi
  for url in \
    "https://auth-cloud-wallet.${DOMAIN}/realms/master" \
    "https://cloud-wallet.${DOMAIN}/.well-known/openid-credential-issuer"; do
    code="$(curl "${curl_args[@]}" "$url")"
    [[ "$code" =~ ^2[0-9][0-9]$|^3[0-9][0-9]$ ]] || {
      echo "Unexpected HTTP status $code from $url" >&2
      return 1
    }
    printf '%s %s\n' "$code" "$url"
  done
}

check_output_contract() {
  local normalized="$EVIDENCE_DIR/deployment-output.redacted.json"
  jq '
    (if type == "object" and has("payload") then .payload else . end) |
    if type == "string" and startswith("OUTPUT_JSON=") then (sub("^OUTPUT_JSON="; "") | fromjson) else . end |
    .clientSecret = "***"
  ' "$OUTPUT_JSON" > "$normalized"

  jq -e --arg domain "$DOMAIN" '
    (if type == "object" and has("payload") then .payload else . end) |
    if type == "string" and startswith("OUTPUT_JSON=") then (sub("^OUTPUT_JSON="; "") | fromjson) else . end |
    (.ocmUrl | type == "string" and length > 0 and contains("cloud-wallet." + $domain)) and
    (.keycloakUrl | type == "string" and length > 0 and contains("auth-cloud-wallet." + $domain)) and
    (.clientSecret | type == "string" and length > 0) and
    (.externalIp | type == "string" and length > 0) and
    (.status == "ready" or .status == "degraded")
  ' "$OUTPUT_JSON" >/dev/null
}

# Non-secret runtime snapshots.
kubectl version -o yaml > "$EVIDENCE_DIR/kubectl-version.yaml" 2>&1 || true
kubectl cluster-info > "$EVIDENCE_DIR/cluster-info.txt" 2>&1 || true
kubectl -n "$NAMESPACE" get pods -o wide > "$EVIDENCE_DIR/pods.txt" 2>&1 || true
kubectl -n "$NAMESPACE" get deployments,statefulsets -o wide > "$EVIDENCE_DIR/workloads.txt" 2>&1 || true
kubectl -n "$NAMESPACE" get services,endpoints -o wide > "$EVIDENCE_DIR/services-endpoints.txt" 2>&1 || true
kubectl -n "$NAMESPACE" get ingress -o wide > "$EVIDENCE_DIR/ingress.txt" 2>&1 || true
kubectl -n "$NAMESPACE" get events --sort-by=.lastTimestamp > "$EVIDENCE_DIR/events.txt" 2>&1 || true

run_check "namespace exists" check_namespace
run_check "workloads rolled out" check_workloads
run_check "pods are ready" check_pods_ready
run_check "services have ready endpoints" check_service_endpoints
run_check "dependent services are reachable" check_internal_connectivity
run_check "ingress resources have addresses" check_ingress_resources
run_check "external HTTPS endpoints are healthy" check_external_https
run_check "deployment output contract is valid" check_output_contract

jq -s --arg namespace "$NAMESPACE" --arg domain "$DOMAIN" \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson passed "$PASS_COUNT" --argjson failed "$FAIL_COUNT" \
  '{namespace:$namespace,domain:$domain,generatedAt:$generatedAt,summary:{passed:$passed,failed:$failed},checks:.}' \
  "$RESULTS_NDJSON" > "$EVIDENCE_DIR/runtime-health-results.json"

{
  echo "# OCM-WStack runtime health result"
  echo
  echo "- Namespace: \`$NAMESPACE\`"
  echo "- Domain: \`$DOMAIN\`"
  echo "- Generated: \`$(date -u +%Y-%m-%dT%H:%M:%SZ)\`"
  echo "- Passed: **$PASS_COUNT**"
  echo "- Failed: **$FAIL_COUNT**"
  echo
  echo "| Check | Status | Detail |"
  echo "|---|---|---|"
  jq -r '. | "| " + (.name|gsub("\\|";"\\|")) + " | " + .status + " | " + (.detail|gsub("\\|";"\\|")|gsub("[\\r\\n]";" ")) + " |"' "$RESULTS_NDJSON"
} > "$EVIDENCE_DIR/runtime-health-results.md"

rm -f "$RESULTS_NDJSON"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi

echo "Runtime health validation passed. Evidence: $EVIDENCE_DIR"
