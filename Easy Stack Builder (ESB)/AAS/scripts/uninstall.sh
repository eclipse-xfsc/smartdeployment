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

kubectl delete configmap gaia-x-realm-config -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
kubectl delete secret aas-db-secret -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
kubectl delete secret aas-initial-access-token -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
kubectl delete ns "$NAMESPACE" --ignore-not-found=true --wait=true
