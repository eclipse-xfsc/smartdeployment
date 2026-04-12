#!/usr/bin/env bash
set -Eeuo pipefail

NAMESPACE="${1:?namespace is required}"
KUBE="${2:?kubeconfig path is required}"
export KUBECONFIG="$KUBE"
REALM_NAME="tsa-${NAMESPACE}"

cleanup_keycloak() {
  local kc_pod pass cid
  kc_pod="$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=keycloak -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [ -n "$kc_pod" ] || return 0
  pass="$(kubectl -n "$NAMESPACE" get secret keycloak-init-secrets -o json | jq -r '.data.password // .data["admin-password"] // empty' | base64 -d 2>/dev/null || true)"
  [ -n "$pass" ] || return 0
  kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "mkdir -p /tmp/kcadm && HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh config credentials --config /tmp/kcadm/config --server http://localhost:8080/ --realm master --user admin --password '$pass'" >/dev/null 2>&1 || true
  for client_name in ssi-oidc ssi-siop; do
    cid="$(kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh get clients -r '${REALM_NAME}' -q clientId='${client_name}' --config /tmp/kcadm/config" 2>/dev/null | jq -r '.[0].id // empty' || true)"
    [ -n "$cid" ] && kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh delete clients/${cid} -r '${REALM_NAME}' --config /tmp/kcadm/config" >/dev/null 2>&1 || true
  done
  kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "HOME=/tmp/kcadm /opt/bitnami/keycloak/bin/kcadm.sh delete realms/${REALM_NAME} --config /tmp/kcadm/config" >/dev/null 2>&1 || true
}

cleanup_namespace_objects() {
  kubectl -n "$NAMESPACE" delete ingress policy-public key-server-public --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" delete secret tsa-keycloak-client preauthbridge-redis vault xfsc-wildcard tsa-trust-materials --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" delete configmap tsa-deployment-status tsa-runtime-config --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" delete serviceaccount tsa-runtime --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" delete role tsa-runtime-role --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" delete rolebinding tsa-runtime-binding --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" delete resourcequota tsa-resource-quota --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" delete limitrange tsa-container-defaults --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" delete service didresolver sd-jwt-service --ignore-not-found >/dev/null 2>&1 || true
}

delete_namespace_forcefully() {
  local i
  kubectl delete ns "$NAMESPACE" --ignore-not-found=true --wait=false >/dev/null 2>&1 || true
  for i in $(seq 1 60); do
    kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || return 0
    sleep 2
  done
  kubectl get ns "$NAMESPACE" -o json >/tmp/tsa-ns.json 2>/dev/null || return 0
  jq '.spec.finalizers = []' /tmp/tsa-ns.json | kubectl replace --raw "/api/v1/namespaces/${NAMESPACE}/finalize" -f - >/dev/null 2>&1 || true
  kubectl delete ns "$NAMESPACE" --ignore-not-found=true --force --grace-period=0 >/dev/null 2>&1 || true
}

cleanup_keycloak
for release in policy-service sdjwt signer universal-resolver vault nats redis key-server auth-server; do
  helm -n "$NAMESPACE" uninstall "$release" >/dev/null 2>&1 || true
done
cleanup_namespace_objects
delete_namespace_forcefully
