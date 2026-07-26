#!/usr/bin/env bash

set -euo pipefail

NAMESPACE="$1"
DOMAIN="$2"
CERT_PATH="$3"
KEY_PATH="$4"
EMAIL="$5"
KUBE="$6"
USE_CUSTOM_CA_BUNDLE="${7:-false}"
CA_BUNDLE_PATH="${8:-}"
ENABLE_INGRESS_NGINX_CLUSTER_CONFIG="${9:-false}"
DELETE_INGRESS_NGINX_ADMISSION_WEBHOOK="${10:-false}"

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

case "$USE_CUSTOM_CA_BUNDLE" in
  true|false) ;;
  *) fail "USE_CUSTOM_CA_BUNDLE must be true or false." ;;
esac

case "$ENABLE_INGRESS_NGINX_CLUSTER_CONFIG" in
  true|false) ;;
  *) fail "ENABLE_INGRESS_NGINX_CLUSTER_CONFIG must be true or false." ;;
esac

case "$DELETE_INGRESS_NGINX_ADMISSION_WEBHOOK" in
  true|false) ;;
  *) fail "DELETE_INGRESS_NGINX_ADMISSION_WEBHOOK must be true or false." ;;
esac

if [[ "$USE_CUSTOM_CA_BUNDLE" == "true" ]]; then
  [[ -n "$CA_BUNDLE_PATH" ]] || fail "CA bundle is enabled but no CA bundle path was provided."
  [[ -s "$CA_BUNDLE_PATH" ]] || fail "CA bundle file not found or empty: $CA_BUNDLE_PATH"
  openssl crl2pkcs7 -nocrl -certfile "$CA_BUNDLE_PATH" 2>/dev/null \
    | openssl pkcs7 -print_certs -noout >/dev/null 2>&1 \
    || fail "CA bundle is not a valid PEM certificate bundle."
fi

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
