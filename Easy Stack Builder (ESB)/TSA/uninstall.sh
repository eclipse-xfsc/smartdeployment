#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="$1"
KUBECONFIG="$2"

for release in policy-service sdjwt signer universal-resolver vault nats redis; do
  helm --kubeconfig "$KUBECONFIG" -n "$NAMESPACE" uninstall "$release" >/dev/null 2>&1 || true
done
kubectl --kubeconfig "$KUBECONFIG" delete namespace "$NAMESPACE" >/dev/null 2>&1 || true
