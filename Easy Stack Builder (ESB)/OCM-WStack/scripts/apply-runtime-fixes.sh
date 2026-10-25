#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ns="${1:-ocm-wstack}"
node "$script_dir/repair-runtime-access.cjs" "$ns"
node "$script_dir/deployment-env.cjs" "$ns" dummycontentsigner dummycontentsigner \
  "SIGNER_CREDENTIAL_URL=http://signer.${ns}.svc.cluster.local:8080/v1/credential"
kubectl -n "$ns" rollout status deployment/dummycontentsigner --timeout=300s
bash "$script_dir/update-runtime-seed.sh" "$ns"
node "$script_dir/diagnose-runtime.cjs" "$ns"
echo 'Runtime updated. Check the native API results in the diagnostic report.'
