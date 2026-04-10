#!/bin/bash
set -euo pipefail

NAMESPACE="$1"
KUBECONFIG_PATH="$2"

export KUBECONFIG="$KUBECONFIG_PATH"

if command -v helm >/dev/null 2>&1; then
  helm uninstall auth-server -n "$NAMESPACE" >/dev/null 2>&1 || true
  helm uninstall keycloak -n "$NAMESPACE" >/dev/null 2>&1 || true
  helm uninstall postgres -n "$NAMESPACE" >/dev/null 2>&1 || true
fi

kubectl -n "$NAMESPACE" delete configmap gaia-x-realm-config aas-deployment-status --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete secret aas-db-secret aas-initial-access-token xfsc-wildcard keycloak-init-secrets --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete networkpolicy aas-default-guard --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete serviceaccount aas-runtime --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete role aas-runtime-role --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete rolebinding aas-runtime-binding --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete resourcequota aas-resource-quota --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" delete limitrange aas-container-defaults --ignore-not-found >/dev/null 2>&1 || true

kubectl delete ns "$NAMESPACE" --ignore-not-found=true --wait=false >/dev/null 2>&1 || true

for _ in $(seq 1 60); do
  kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || exit 0
  sleep 2
done

kubectl patch ns "$NAMESPACE" --type merge -p '{"metadata":{"finalizers":[]}}' >/dev/null 2>&1 || true
kubectl delete ns "$NAMESPACE" --ignore-not-found=true --grace-period=0 --force >/dev/null 2>&1 || true
