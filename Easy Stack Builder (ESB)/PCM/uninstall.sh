#!/usr/bin/env bash
set -Eeuo pipefail

NAMESPACE="${1:?pcm namespace is required}"
KUBE="${2:?kubeconfig path is required}"
OCM_NAMESPACE="${3:-}"
export KUBECONFIG="$KUBE"
REALM_NAME="pcm-${NAMESPACE}"

cleanup_keycloak() {
  [ -n "$OCM_NAMESPACE" ] || return 0
  local kc_pod pass cid
  kc_pod="$(kubectl -n "$OCM_NAMESPACE" get pods -l app.kubernetes.io/name=keycloak -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [ -n "$kc_pod" ] || return 0
  pass="$(kubectl -n "$OCM_NAMESPACE" get secret keycloak-init-secrets -o json | jq -r '.data.password // .data["admin-password"] // empty' | base64 -d 2>/dev/null || true)"
  [ -n "$pass" ] || return 0
  kubectl -n "$OCM_NAMESPACE" exec "$kc_pod" -- sh -lc "mkdir -p /tmp/kcadm && HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh config credentials --config /tmp/kcadm/config --server http://localhost:8080/ --realm master --user admin --password '$pass'" >/dev/null 2>&1 || true
  for client_name in webui issuer-api; do
    cid="$(kubectl -n "$OCM_NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh get clients -r '${REALM_NAME}' -q clientId='${client_name}' --config /tmp/kcadm/config" 2>/dev/null | jq -r '.[0].id // empty' || true)"
    [ -n "$cid" ] && kubectl -n "$OCM_NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh delete clients/${cid} -r '${REALM_NAME}' --config /tmp/kcadm/config" >/dev/null 2>&1 || true
  done
  kubectl -n "$OCM_NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh delete realms/${REALM_NAME} --config /tmp/kcadm/config" >/dev/null 2>&1 || true
}

cleanup_keycloak
for release in web-ui-service account-service plugin-discovery-service configuration-service kong-service; do
  helm -n "$NAMESPACE" uninstall "$release" >/dev/null 2>&1 || true
done
kubectl -n "$NAMESPACE" delete secret postgres-postgresql account-db vault keycloak-init-secrets pcm-keycloak-client regcred web-ui-basic-auth xfsc-wildcard --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete configmap pcm-credential-policy pcm-deployment-status --ignore-not-found >/dev/null 2>&1 || true
kubectl delete ns "$NAMESPACE" --ignore-not-found=true --wait=true >/dev/null 2>&1 || true
