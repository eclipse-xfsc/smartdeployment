#!/usr/bin/env bash
set -Eeuo pipefail

NAMESPACE="${1:?namespace is required}"
DOMAIN="${2:?domain is required}"
KUBECONFIG_PATH="${3:?kubeconfig path is required}"
_CERT_PATH="${4:?certificate path is required}"
EVIDENCE_DIR="${5:?evidence directory is required}"

export KUBECONFIG="$KUBECONFIG_PATH"
mkdir -p "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR"

STARTED_AT="$(date -Iseconds)"
CHECKS_FILE="$EVIDENCE_DIR/checks.ndjson"
SERVICES_JSON="$EVIDENCE_DIR/services.json"
PODS_JSON="$EVIDENCE_DIR/pods.json"
EVENTS_TXT="$EVIDENCE_DIR/events.txt"
READINESS_TSV="$EVIDENCE_DIR/service-readiness.tsv"
: > "$CHECKS_FILE"
: > "$READINESS_TSV"

HEALTH_WAIT_SECONDS="${TSA_HEALTH_WAIT_SECONDS:-300}"
case "$HEALTH_WAIT_SECONDS" in
  ''|*[!0-9]*) echo "TSA_HEALTH_WAIT_SECONDS must be an integer number of seconds" >&2; exit 2 ;;
esac
[ "$HEALTH_WAIT_SECONDS" -gt 0 ] || { echo "TSA_HEALTH_WAIT_SECONDS must be greater than zero" >&2; exit 2; }
[ "$HEALTH_WAIT_SECONDS" -le 300 ] || { echo "TSA_HEALTH_WAIT_SECONDS cannot exceed 300 seconds" >&2; exit 2; }

require() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 2
  }
}
for bin in kubectl jq; do require "$bin"; done

record_check() {
  local id="$1" status="$2" details="$3"
  jq -cn --arg id "$id" --arg status "$status" --arg details "$details" \
    '{id:$id,status:$status,details:$details}' >> "$CHECKS_FILE"
}

snapshot_resources() {
  kubectl -n "$NAMESPACE" get services -o json > "$SERVICES_JSON" 2>"$EVIDENCE_DIR/services.err" || return 1
  kubectl -n "$NAMESPACE" get pods -o json > "$PODS_JSON" 2>"$EVIDENCE_DIR/pods.err" || true
}

ready_address_count() {
  local service_name="$1"
  local slices_json endpoints_json count

  slices_json="$(kubectl -n "$NAMESPACE" get endpointslices.discovery.k8s.io \
    -l "kubernetes.io/service-name=${service_name}" -o json 2>/dev/null || true)"
  if [ -n "$slices_json" ]; then
    count="$(printf '%s' "$slices_json" | jq '[.items[]?.endpoints[]? | select((.conditions.ready // true) == true) | .addresses[]?] | length' 2>/dev/null || echo 0)"
    if [ "${count:-0}" -gt 0 ]; then
      printf '%s\n' "$count"
      return 0
    fi
  fi

  endpoints_json="$(kubectl -n "$NAMESPACE" get endpoints "$service_name" -o json 2>/dev/null || true)"
  count="$(printf '%s' "$endpoints_json" | jq '[.subsets[]?.addresses[]?] | length' 2>/dev/null || echo 0)"
  printf '%s\n' "${count:-0}"
}

check_all_services() {
  local service_names service_name ready_count total=0 failed=0
  : > "$READINESS_TSV"
  printf 'service\tready_addresses\tstatus\n' >> "$READINESS_TSV"

  service_names="$(jq -r '
    .items[]
    | select(.spec.type != "ExternalName")
    | select(((.spec.selector // {}) | length) > 0)
    | .metadata.name
  ' "$SERVICES_JSON")"

  [ -n "$service_names" ] || return 1

  while IFS= read -r service_name; do
    [ -n "$service_name" ] || continue
    total=$((total + 1))
    ready_count="$(ready_address_count "$service_name")"
    if [ "${ready_count:-0}" -gt 0 ]; then
      printf '%s\t%s\tready\n' "$service_name" "$ready_count" >> "$READINESS_TSV"
    else
      printf '%s\t0\tnot-ready\n' "$service_name" >> "$READINESS_TSV"
      failed=$((failed + 1))
    fi
  done <<< "$service_names"

  [ "$total" -gt 0 ] && [ "$failed" -eq 0 ]
}

DEADLINE=$(( $(date +%s) + HEALTH_WAIT_SECONDS ))
ATTEMPTS=0
LAST_REASON="services are still converging"
READY=false

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  ATTEMPTS=$((ATTEMPTS + 1))

  if ! kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
    LAST_REASON="namespace is not reachable"
    sleep 5
    continue
  fi

  if ! snapshot_resources; then
    LAST_REASON="services cannot be read"
    sleep 5
    continue
  fi

  if check_all_services; then
    READY=true
    LAST_REASON="all selector-backed Services have ready endpoints"
    break
  fi

  LAST_REASON="one or more selector-backed Services have no ready endpoint"
  sleep 5
done

# Capture final diagnostic state. These commands do not affect the pass/fail result.
kubectl -n "$NAMESPACE" get services -o json > "$SERVICES_JSON" 2>"$EVIDENCE_DIR/services.err" || true
kubectl -n "$NAMESPACE" get pods -o json > "$PODS_JSON" 2>"$EVIDENCE_DIR/pods.err" || true
kubectl -n "$NAMESPACE" get events --sort-by=.lastTimestamp > "$EVENTS_TXT" 2>&1 || true
check_all_services || true

if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  record_check RH-01 passed "TSA namespace exists and is reachable"
else
  record_check RH-01 failed "TSA namespace is not reachable"
fi

if [ "$READY" = true ]; then
  record_check RH-02 passed "Every selector-backed TSA Service has at least one ready EndpointSlice/Endpoint address"
  STATUS="passed"
else
  record_check RH-02 failed "TSA Service readiness did not complete within ${HEALTH_WAIT_SECONDS}s: ${LAST_REASON}"
  STATUS="failed"
fi

ENDED_AT="$(date -Iseconds)"
jq -s \
  --arg namespace "$NAMESPACE" \
  --arg domain "$DOMAIN" \
  --arg startedAt "$STARTED_AT" \
  --arg endedAt "$ENDED_AT" \
  --arg status "$STATUS" \
  --arg reason "$LAST_REASON" \
  --argjson attempts "$ATTEMPTS" \
  --argjson waitLimitSeconds "$HEALTH_WAIT_SECONDS" \
  '{suite:"TSA Kubernetes Service readiness",namespace:$namespace,domain:$domain,startedAt:$startedAt,endedAt:$endedAt,status:$status,reason:$reason,attempts:$attempts,waitLimitSeconds:$waitLimitSeconds,checks:.}' \
  "$CHECKS_FILE" > "$EVIDENCE_DIR/runtime-health.json"

{
  printf '# TSA Kubernetes Service Readiness Evidence\n\n'
  printf -- '- Namespace: `%s`\n' "$NAMESPACE"
  printf -- '- Started: `%s`\n' "$STARTED_AT"
  printf -- '- Finished: `%s`\n' "$ENDED_AT"
  printf -- '- Attempts: `%s`\n' "$ATTEMPTS"
  printf -- '- Maximum readiness window: `%ss`\n' "$HEALTH_WAIT_SECONDS"
  printf -- '- Result: **%s**\n\n' "$STATUS"
  printf 'The deployment gate checks only Kubernetes Service readiness. A Service is ready when it has a selector and at least one ready EndpointSlice or Endpoints address. ExternalName Services are not gated. No ingress, DNS, TLS, HTTP, authentication, policy, signing, or business-workflow test is executed.\n\n'
  printf '## Service readiness\n\n```text\n'
  cat "$READINESS_TSV"
  printf '```\n'
} > "$EVIDENCE_DIR/runtime-health.md"

rm -f "$CHECKS_FILE"

if [ "$READY" != true ]; then
  printf 'TSA Service readiness failed: %s. Evidence: %s\n' "$LAST_REASON" "$EVIDENCE_DIR" >&2
  exit 1
fi

printf 'TSA Services are ready after %s polling attempt(s). Evidence: %s\n' "$ATTEMPTS" "$EVIDENCE_DIR"
