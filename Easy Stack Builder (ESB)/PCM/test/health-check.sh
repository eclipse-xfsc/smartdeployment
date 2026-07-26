#!/usr/bin/env bash
set -euo pipefail

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

MODULE_NAME="PCM"
namespace=""
url=""
kubeconfig="${KUBECONFIG:-}"
ca_bundle=""
timeout="300s"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) namespace="$2"; shift 2 ;;
    --url) url="$2"; shift 2 ;;
    --kubeconfig) kubeconfig="$2"; shift 2 ;;
    --ca-bundle) ca_bundle="$2"; shift 2 ;;
    --timeout) timeout="$2"; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
start="$(date +%s)"
emit() {
  local status="$1" detail="$2" rc="$3" end duration
  end="$(date +%s)"; duration=$((end-start))
  printf '{"module":"%s","status":"%s","durationSeconds":%s,"detail":"%s"}\n' \
    "$MODULE_NAME" "$status" "$duration" "${detail//\"/\\\"}"
  exit "$rc"
}
[[ -n "$namespace" ]] || emit FAILED 'namespace is required' 2
if [[ -n "$kubeconfig" ]]; then
  [[ -r "$kubeconfig" ]] || emit SKIPPED 'kubeconfig is unavailable' 3
  export KUBECONFIG="$kubeconfig"
elif ! kubectl config current-context >/dev/null 2>&1; then
  emit SKIPPED 'no Kubernetes context is available' 3
fi
kubectl get namespace "$namespace" >/dev/null 2>&1 || emit FAILED 'namespace is not present' 1
kubectl -n "$namespace" get deployment -o name | grep -q . || emit FAILED 'no deployments were found in the namespace' 1
kubectl -n "$namespace" get pod -o name | grep -q . || emit FAILED 'no pods were found in the namespace' 1
kubectl -n "$namespace" wait --for=condition=Available deployment --all --timeout="$timeout" >/dev/null \
  || emit FAILED 'one or more deployments are not Available' 1
kubectl -n "$namespace" wait --for=condition=Ready pod --all --timeout="$timeout" >/dev/null \
  || emit FAILED 'one or more pods are not Ready' 1
if [[ -n "$url" ]]; then
  curl_args=(--fail --silent --show-error --connect-timeout 10 --max-time 60)
  if [[ -n "$ca_bundle" ]]; then
    [[ -r "$ca_bundle" ]] || emit FAILED 'CA bundle is not readable' 1
    curl_args+=(--cacert "$ca_bundle")
  fi
  esb_curl "${curl_args[@]}" "$url" >/dev/null || emit FAILED 'service health URL is not reachable over verified TLS' 1
fi
emit PASSED 'namespace workloads are healthy and Ready' 0
