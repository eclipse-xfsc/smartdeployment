#!/usr/bin/env bash
set -euo pipefail
ns="${1:-ocm-wstack}"
[[ "$ns" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo 'Invalid namespace' >&2; exit 2; }
patch="$(kubectl -n "$ns" get deployment credential-retrieval-service -o json |
  jq -ce --arg host "cassandra.${ns}.svc.cluster.local:9042" '
    .metadata.resourceVersion as $rv |
    [.spec.template.spec.containers | to_entries[] |
      select(.value.name == "credential-retrieval-service")] |
    if length != 1 then error("Expected exactly one Retrieval container") else .[0] end |
    [
      {op:"test", path:"/metadata/resourceVersion", value:$rv},
      {op:"add", path:("/spec/template/spec/containers/" + (.key|tostring) + "/env"),
       value:((.value.env // [] | map(select(.name != "CREDENTIALRETRIEVAL_CASSANDRA_HOSTS"))) +
         [{name:"CREDENTIALRETRIEVAL_CASSANDRA_HOSTS", value:$host}])}
    ]
  ')"
printf '%s' "$patch" | kubectl -n "$ns" patch deployment credential-retrieval-service \
  --type=json --patch-file=/dev/stdin
kubectl -n "$ns" rollout status deployment/credential-retrieval-service --timeout=180s
