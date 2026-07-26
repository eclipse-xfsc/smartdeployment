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


fail() { printf 'AAS preflight: %s\n' "$*" >&2; exit 1; }
for tool in kubectl helm curl openssl base64 python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool is missing: $tool"
done

namespace="${NAMESPACE:-${AAS_NAMESPACE:-}}"
domain="${DOMAIN:-${AAS_DOMAIN:-}}"
kubeconfig="${KUBECONFIG:-}"
ca_bundle="${ESB_CA_BUNDLE_FILE:-}"
ca_bundle_b64="${ESB_CA_BUNDLE_B64:-}"

if [[ -n "$namespace" ]]; then
  [[ "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || fail "invalid Kubernetes namespace: $namespace"
  case "$namespace" in kube-system|kube-public|kube-node-lease|default) fail "reserved namespace is not permitted: $namespace" ;; esac
fi
if [[ -n "$domain" ]]; then
  [[ "$domain" != *://* && "$domain" =~ ^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || fail "domain must be a bare FQDN: $domain"
fi
if [[ -n "$kubeconfig" ]]; then
  [[ -r "$kubeconfig" ]] || fail "kubeconfig is not readable: $kubeconfig"
  kubectl --kubeconfig "$kubeconfig" --request-timeout=10s get --raw=/version >/dev/null
else
  kubectl --request-timeout=10s get --raw=/version >/dev/null
fi
if [[ -n "$ca_bundle" ]]; then
  [[ -r "$ca_bundle" ]] || fail "CA bundle is not readable: $ca_bundle"
  grep -q 'BEGIN CERTIFICATE' "$ca_bundle" || fail "CA bundle is not PEM certificate data"
fi
if [[ -n "$ca_bundle_b64" ]]; then
  ca_tmp="$(mktemp)"
  chmod 600 "$ca_tmp"
  trap 'rm -f "$ca_tmp"' EXIT
  if ! printf '%s' "$ca_bundle_b64" | base64 --decode >"$ca_tmp" 2>/dev/null; then
    printf '%s' "$ca_bundle_b64" | base64 -d >"$ca_tmp" 2>/dev/null || fail "CA bundle is not valid base64"
  fi
  grep -q 'BEGIN CERTIFICATE' "$ca_tmp" || fail "CA bundle is not PEM certificate data"
fi

for arg in "$@"; do
  if [[ -f "$arg" ]] && grep -q 'BEGIN CERTIFICATE' "$arg" 2>/dev/null; then
    openssl x509 -in "$arg" -noout >/dev/null 2>&1 || fail "invalid certificate file: $arg"
  elif [[ -f "$arg" ]] && grep -q 'BEGIN .*PRIVATE KEY' "$arg" 2>/dev/null; then
    openssl pkey -in "$arg" -noout >/dev/null 2>&1 || fail "invalid private key file: $arg"
  fi
done

# Repository-owner exception: the AAS auth-service image must remain on the
# upstream-published mutable `latest` reference. Verify the exact source instead
# of applying the general NF-10 mutable-tag rejection to this image.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 - "$script_dir/helm/AAS/values.yaml" <<'PY_IMAGE'
from pathlib import Path
import re, sys
text = Path(sys.argv[1]).read_text(encoding='utf-8')
lines = text.splitlines()
try:
    image_index = lines.index('image:')
except ValueError:
    raise SystemExit('AAS image block is missing')
values = {}
for line in lines[image_index + 1:]:
    if not line.startswith((' ', '\t')):
        break
    key, sep, value = line.strip().partition(':')
    if sep:
        values[key] = value.strip().strip('"\'')
expected = {
    'repository': 'registry.gitlab.com/gaia-x/data-infrastructure-federation-services/authenticationauthorization',
    'name': 'auth-service-image',
    'tag': 'latest',
    'sha': '',
    'pullPolicy': 'Always',
    'pullSecrets': '',
}
for key, value in expected.items():
    if values.get(key) != value:
        raise SystemExit(f'AAS image {key} must be {value!r}, found {values.get(key)!r}')
PY_IMAGE
printf '%s\n' 'AAS preflight: PASS'
