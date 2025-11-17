#!/usr/bin/env bash

set -euo pipefail

SUFFIX=$1
KUBECONFIG=$2

kubectl --kubeconfig "$KUBECONFIG" delete namespace xfsc-orce-$SUFFIX
kubectl --kubeconfig "$KUBECONFIG" delete clusterrole xfsc-orce-$SUFFIX-deployer
kubectl --kubeconfig "$KUBECONFIG" delete clusterrolebinding xfsc-orce-"$SUFFIX"-deployer-binding