#!/usr/bin/env bash
set -euo pipefail
umask 077
OUT="${1:-ocm-native-evidence-$(date -u +%Y%m%dT%H%M%SZ)}"
INCLUDE_LOGS="${2:-}"
if [[ "$INCLUDE_LOGS" != "" && "$INCLUDE_LOGS" != "--include-logs" ]]; then
  echo "Usage: $0 [output-directory] [--include-logs]" >&2
  exit 2
fi
mkdir -p "$OUT"
kubectl get pods -A -o json | jq '{pods:[.items[] | select(.metadata.namespace | IN("ocm-wstack","infrastructure","security","observability","argocd")) | {namespace:.metadata.namespace,name:.metadata.name,phase:.status.phase,containers:[.status.containerStatuses[]? | {name,image,imageID,ready,restartCount,state}]}]}' > "$OUT/images-and-pods.json"
kubectl -n argocd get applications.argoproj.io -o json | jq '{applications:[.items[] | {name:.metadata.name,ownerReferences:.metadata.ownerReferences,source:{repoURL:.spec.source.repoURL,path:.spec.source.path,targetRevision:.spec.source.targetRevision},sync:.status.sync,health:.status.health,conditions:.status.conditions}]}' > "$OUT/argo-applications.json"
kubectl -n kube-system get configmap esb-ocmwstack-v12 -o json | jq '{name:.metadata.name,data}' > "$OUT/esb-installation.json"
kubectl -n ocm-wstack get deployments -o json | jq '{deployments:[.items[] | {name:.metadata.name,containers:[.spec.template.spec.containers[] | {name,image,settings:[.env[]? | select(.name | test("(REGION|COUNTRY|MODE|PROFILE|MIGRATIONS_ENABLED)$")) | {name,value,valueFrom}]}]}]}' > "$OUT/selected-settings.json"
kubectl -n infrastructure get gateway envoy-gateway -o json > "$OUT/gateway.json"
kubectl -n ocm-wstack get httproutes,listenersets,certificates -o json > "$OUT/tenant-routing.json"
kubectl get pvc -A -o json | jq '{claims:[.items[] | select(.metadata.namespace | IN("ocm-wstack","infrastructure","security","observability","argocd")) | {namespace:.metadata.namespace,name:.metadata.name,storageClass:.spec.storageClassName,phase:.status.phase,capacity:.status.capacity}]}' > "$OUT/storage-claims.json"
if [[ "$INCLUDE_LOGS" == "--include-logs" ]]; then
  mkdir -p "$OUT/private-logs"
  for service in credential-retrieval-service storage-service issuance-service; do
    kubectl -n ocm-wstack logs "deployment/$service" --all-containers --since=30m --timestamps > "$OUT/private-logs/$service.log" 2> "$OUT/private-logs/$service.error" || true
  done
fi
printf 'Evidence saved to %s\n' "$OUT"
