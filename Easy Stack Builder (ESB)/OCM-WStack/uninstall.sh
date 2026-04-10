#!/usr/bin/env bash

set -euo pipefail

NAMESPACE="$1"
KUBE="$2"
KEYCLOAK_REALM="$NAMESPACE"
KEYCLOAK_CLIENT_ID="bridge"
TLS_SECRET="xfsc-wildcard"

export KUBECONFIG="$KUBE"

cleanup_keycloak_artifacts() {
  local kc_pod pass kcadm_dir kcadm_cfg cid

  kc_pod="$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=keycloak -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -z "$kc_pod" ]]; then
    return 0
  fi

  pass="$(kubectl -n "$NAMESPACE" get secret keycloak-init-secrets -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  if [[ -z "$pass" ]]; then
    return 0
  fi

  kcadm_dir="/tmp/kcadm-uninstall"
  kcadm_cfg="$kcadm_dir/kcadm.config"

  kubectl -n "$NAMESPACE" exec -i "$kc_pod" -- sh -lc "
    mkdir -p '$kcadm_dir' &&
    HOME='$kcadm_dir' /opt/bitnami/keycloak/bin/kcadm.sh config credentials \
      --config '$kcadm_cfg' \
      --server http://localhost:8080/ \
      --realm master \
      --user admin \
      --password '$pass'
  " >/dev/null 2>&1 || return 0

  cid="$({
    kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "
      HOME='$kcadm_dir' /opt/bitnami/keycloak/bin/kcadm.sh get clients -r ${KEYCLOAK_REALM} -q clientId=${KEYCLOAK_CLIENT_ID} --config '$kcadm_cfg' 2>/dev/null || true
    " | jq -r '.[0].id // empty'
  })"

  if [[ -n "$cid" ]]; then
    kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "
      HOME='$kcadm_dir' /opt/bitnami/keycloak/bin/kcadm.sh delete clients/${cid} -r ${KEYCLOAK_REALM} --config '$kcadm_cfg' >/dev/null 2>&1 || true
    " >/dev/null 2>&1 || true
  fi

  kubectl -n "$NAMESPACE" exec "$kc_pod" -- sh -lc "
    HOME='$kcadm_dir' /opt/bitnami/keycloak/bin/kcadm.sh delete realms/${KEYCLOAK_REALM} --config '$kcadm_cfg' >/dev/null 2>&1 || true
  " >/dev/null 2>&1 || true
}

if ! kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  exit 0
fi

cleanup_keycloak_artifacts || true

mapfile -t releases < <(helm list -n "$NAMESPACE" -q 2>/dev/null || true)
if [[ "${#releases[@]}" -gt 0 ]]; then
  helm uninstall -n "$NAMESPACE" "${releases[@]}" >/dev/null 2>&1 || true
fi

kubectl -n "$NAMESPACE" delete secret \
  ocm-keycloak-client \
  preauthbridge-oauth \
  preauthbridge-redis \
  signing \
  vault \
  statuslist-db-secret \
  wellknown-db-secret \
  "$TLS_SECRET" \
  --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete configmap ocm-deployment-status --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete resourcequota ocm-resource-quota --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete limitrange ocm-default-limits --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete serviceaccount ocm-runtime --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete role ocm-observer --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete rolebinding ocm-observer-binding --ignore-not-found >/dev/null 2>&1 || true

kubectl delete namespace "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
kubectl wait --for=delete namespace/"$NAMESPACE" --timeout=5m >/dev/null 2>&1 || true
