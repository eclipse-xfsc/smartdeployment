#!/usr/bin/env bash
set -euo pipefail
ns="${1:?namespace required}"
[[ "$ns" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo 'Invalid namespace' >&2; exit 2; }
# rollout status does not support --all. Enumerate resource names explicitly.
resources="$(kubectl -n "$ns" get deployments -o name)"
while IFS= read -r resource; do
  [[ -n "$resource" ]] || continue
  if ! kubectl -n "$ns" rollout status "$resource" --timeout=15m; then
    echo "Deployment readiness failed: $resource" >&2
    kubectl -n "$ns" get pods -o wide >&2 || true
    exit 1
  fi
done <<< "$resources"
