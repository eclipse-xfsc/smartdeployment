#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NAMESPACE="${1:?namespace is required}"
KUBE="${2:?kubeconfig path is required}"
export KUBECONFIG="$KUBE"
kubectl -n "$NAMESPACE" delete configmap aas-deployment-status --ignore-not-found >/dev/null 2>&1 || true
exec "$DIR/scripts/uninstall.sh" "$@"
