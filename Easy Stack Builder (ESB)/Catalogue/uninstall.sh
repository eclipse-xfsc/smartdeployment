#!/usr/bin/env bash
set -euo pipefail

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }
usage() { echo "Usage: $0 <kubeconfig> <path>"; exit 1; }

# پارامترها
[ "$#" -ne 2 ] && usage
KUBECONFIG_FILE="$1"
URL_PATH="$2"
export KUBECONFIG="$KUBECONFIG_FILE"

# namespace بر اساس path
NAMESPACE="fed-cat-${URL_PATH}"
RELEASE="fc-service"

log "ℹ️  Uninstalling Helm release '$RELEASE' from namespace '$NAMESPACE'..."

# 1. Helm uninstall
if helm --kubeconfig="$KUBECONFIG" ls -n "$NAMESPACE" | grep -q "^$RELEASE"; then
  helm uninstall "$RELEASE" \
    --namespace "$NAMESPACE" \
    --kubeconfig "$KUBECONFIG"
  log "✅ Helm release '$RELEASE' uninstalled"
else
  log "⚠️  Release '$RELEASE' not found in '$NAMESPACE'"
fi

# 2. حذف سرویس custom neo4j
if kubectl get svc fc-neo4j-db-lb-neo4j -n "$NAMESPACE" &>/dev/null; then
  kubectl delete svc fc-neo4j-db-lb-neo4j \
    --namespace "$NAMESPACE" \
    --kubeconfig "$KUBECONFIG"
  log "✅ Custom Neo4j service deleted"
else
  log "⚠️  Neo4j service not found"
fi

# 3. حذف secret‌ TLS
if kubectl get secret certificates -n "$NAMESPACE" &>/dev/null; then
  kubectl delete secret certificates \
    --namespace "$NAMESPACE" \
    --kubeconfig "$KUBECONFIG"
  log "✅ TLS secret deleted"
else
  log "⚠️  TLS secret not found"
fi

# 4. حذف namespace (همه چیز درونش پاک می‌شود)
if kubectl get ns "$NAMESPACE" &>/dev/null; then
  kubectl delete ns "$NAMESPACE" --kubeconfig "$KUBECONFIG"
  log "✅ Namespace '$NAMESPACE' deleted"
else
  log "⚠️  Namespace '$NAMESPACE' not found"
fi

log "🎉 Uninstall complete!"

