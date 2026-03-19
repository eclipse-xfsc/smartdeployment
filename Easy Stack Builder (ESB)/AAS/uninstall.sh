#!/bin/bash
set -euo pipefail

NAMESPACE="$1"
KUBECONFIG_PATH="$2"

export KUBECONFIG="$KUBECONFIG_PATH"

kubectl delete ns "$NAMESPACE" --force --grace-period=0
