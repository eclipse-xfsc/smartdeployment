#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${1:-}"
KUBE="${2:-}"

[ -n "$NAMESPACE" ] || { echo "missing namespace" >&2; exit 1; }
[ -n "$KUBE" ] || { echo "missing kubeconfig" >&2; exit 1; }

export KUBECONFIG="$KUBE"

kubectl delete namespace "$NAMESPACE" --ignore-not-found=true --wait=true
