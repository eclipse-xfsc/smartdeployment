#!/usr/bin/env bash

set -euo pipefail

NAMESPACE="$1"
DOMAIN="$2"
CERT_PATH="$3"
KEY_PATH="$4"
EMAIL="$5"
KUBE="$6"

fail() {
  echo "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

for cmd in kubectl helm jq openssl curl; do
  require_cmd "$cmd"
done

[[ -f "$KUBE" ]] || fail "kubeconfig file not found: $KUBE"
[[ -f "$CERT_PATH" ]] || fail "certificate file not found: $CERT_PATH"
[[ -f "$KEY_PATH" ]] || fail "private key file not found: $KEY_PATH"

if [[ ! "$NAMESPACE" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  fail "Namespace must be a DNS-1123 label (lowercase letters, digits, and hyphens only)."
fi

case "$NAMESPACE" in
  default|ingress-nginx|kube-*|openshift-*)
    fail "Namespace '$NAMESPACE' is reserved or conflicts with platform namespaces."
    ;;
esac

if [[ "$DOMAIN" =~ ^https?:// ]] || [[ "$DOMAIN" == */* ]]; then
  fail "Domain must be a bare FQDN without scheme or path."
fi

if [[ ! "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
  fail "Domain must be a valid FQDN."
fi

if [[ ! "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  fail "Email address is not valid."
fi

kubectl --kubeconfig "$KUBE" config view >/dev/null 2>&1 || fail "kubeconfig cannot be parsed."
kubectl --kubeconfig "$KUBE" config current-context >/dev/null 2>&1 || fail "kubeconfig has no current context."
kubectl --kubeconfig "$KUBE" cluster-info --request-timeout=15s >/dev/null 2>&1 || fail "Cluster is not reachable with the provided kubeconfig."

openssl x509 -in "$CERT_PATH" -noout >/dev/null 2>&1 || fail "Certificate file is not a valid X.509 certificate."
openssl pkey -in "$KEY_PATH" -noout >/dev/null 2>&1 || fail "Private key file is not a valid private key."

cert_fingerprint="$({
  openssl x509 -in "$CERT_PATH" -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | openssl dgst -sha256 2>/dev/null
} | awk '{print $2}')"

key_fingerprint="$({
  openssl pkey -in "$KEY_PATH" -pubout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | openssl dgst -sha256 2>/dev/null
} | awk '{print $2}')"

[[ -n "$cert_fingerprint" ]] || fail "Unable to derive public key fingerprint from certificate."
[[ -n "$key_fingerprint" ]] || fail "Unable to derive public key fingerprint from private key."
[[ "$cert_fingerprint" == "$key_fingerprint" ]] || fail "TLS certificate and private key do not match."

echo "Preflight checks passed for namespace '$NAMESPACE' and domain '$DOMAIN'."
