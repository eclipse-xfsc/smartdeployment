#!/usr/bin/env bash
set -Eeuo pipefail

NAMESPACE="${1:?namespace is required}"
DOMAIN="${2:?domain is required}"
CERT_PATH="${3:?certificate path is required}"
KEY_PATH="${4:?key path is required}"
KUBE="${5:?kubeconfig path is required}"
POLICY_REPO_URL="${6:-https://github.com/eclipse-xfsc/rego-policies}"
POLICY_REPO_FOLDER="${7:-}"
EIDAS_MODE_RAW="${8:-false}"
TRUST_KEY_PATH="${9:-}"
TRUST_CHAIN_PATH="${10:-}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

is_reserved_namespace() {
  case "$1" in
    default|kube-system|kube-public|kube-node-lease|ingress-nginx|cert-manager|kube-service-catalog)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

looks_like_jwk() {
  jq -e 'has("kty") or (has("keys") and (.keys | type == "array") and (.keys | length > 0))' "$1" >/dev/null 2>&1
}

[[ -f "$CERT_PATH" ]] || fail "certificate file not found: $CERT_PATH"
[[ -f "$KEY_PATH" ]] || fail "key file not found: $KEY_PATH"
[[ -f "$KUBE" ]] || fail "kubeconfig file not found: $KUBE"

for bin in kubectl helm openssl grep awk sed jq; do
  require "$bin"
done

[[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || fail "instance name must be a valid Kubernetes namespace"
is_reserved_namespace "$NAMESPACE" && fail "instance name uses a reserved namespace"
[[ "$DOMAIN" =~ ^([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$ ]] || fail "domain must be a bare FQDN"
[[ "$DOMAIN" != http://* && "$DOMAIN" != https://* && "$DOMAIN" != */* ]] || fail "domain must not include a scheme or path"
[[ "$POLICY_REPO_URL" =~ ^https?:// ]] || fail "policy repo URL must be http(s)"

case "${EIDAS_MODE_RAW,,}" in
  true|false|1|0|yes|no|on|off) ;;
  *) fail "eIDAS flag must be a boolean-like value" ;;
esac

grep -q 'BEGIN CERTIFICATE' "$CERT_PATH" || fail "certificate file does not look like PEM data"
grep -Eq 'BEGIN (RSA |EC |)?PRIVATE KEY' "$KEY_PATH" || fail "private key file does not look like PEM data"
openssl x509 -in "$CERT_PATH" -noout >/dev/null 2>&1 || fail "certificate cannot be parsed by openssl"
openssl pkey -in "$KEY_PATH" -noout >/dev/null 2>&1 || fail "private key cannot be parsed by openssl"
cert_pub="$(openssl x509 -in "$CERT_PATH" -pubkey -noout | openssl pkey -pubin -outform PEM 2>/dev/null | openssl dgst -sha256 | awk '{print $2}')"
key_pub="$(openssl pkey -in "$KEY_PATH" -pubout -outform PEM 2>/dev/null | openssl dgst -sha256 | awk '{print $2}')"
[[ -n "$cert_pub" && "$cert_pub" = "$key_pub" ]] || fail "certificate and private key do not match"

if [[ -n "$TRUST_KEY_PATH" ]]; then
  [[ -f "$TRUST_KEY_PATH" ]] || fail "trust key file not found: $TRUST_KEY_PATH"
  if grep -Eq 'BEGIN (RSA |EC |)?(PRIVATE|PUBLIC) KEY|BEGIN CERTIFICATE' "$TRUST_KEY_PATH"; then
    :
  elif looks_like_jwk "$TRUST_KEY_PATH"; then
    :
  else
    fail "trust key file must be PEM or JWK/JWKS JSON"
  fi
fi

if [[ -n "$TRUST_CHAIN_PATH" ]]; then
  [[ -f "$TRUST_CHAIN_PATH" ]] || fail "trust chain file not found: $TRUST_CHAIN_PATH"
  grep -q 'BEGIN CERTIFICATE' "$TRUST_CHAIN_PATH" || fail "trust chain file must contain PEM certificates"
fi

kubectl --kubeconfig "$KUBE" config view --raw >/dev/null 2>&1 || fail "kubeconfig could not be parsed"
kubectl --kubeconfig "$KUBE" cluster-info >/dev/null 2>&1 || fail "cluster is not reachable"
kubectl --kubeconfig "$KUBE" get namespace >/dev/null 2>&1 || fail "cannot list namespaces on the target cluster"

echo "PREFLIGHT_OK=true"
