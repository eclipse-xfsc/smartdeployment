#!/usr/bin/env bash
set -euo pipefail
ns="${1:-ocm-wstack}"
[[ "$ns" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo 'Invalid namespace' >&2; exit 2; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
seed="${2:-$script_dir/../ORCE Runtime/files/runtime.tgz}"
[[ -f "$seed" ]] || { echo 'Runtime seed archive not found' >&2; exit 1; }
umask 077
work="$(mktemp -d "${TMPDIR:-/tmp}/ocm-runtime-update.XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT
kubectl -n "$ns" get configmap ocm-orce-seed -o json > "$work/configmap.json"
kubectl -n "$ns" get deployment ocm-orce -o json > "$work/deployment.json"
# Only operate on the previously delivered ConfigMap/init/PVC layout.
jq -e '.binaryData["runtime.tgz"] and .data["seed.sh"]' "$work/configmap.json" >/dev/null
jq -e 'any(.spec.template.spec.initContainers[]; .name == "seed-orce-runtime" and .command == ["/bin/sh","/seed/seed.sh"]) and any(.spec.template.spec.volumes[]; .configMap.name == "ocm-orce-seed")' "$work/deployment.json" >/dev/null
base64 < "$seed" | tr -d '\n' > "$work/seed.base64"
hash="$(sha256sum "$seed" | cut -d ' ' -f 1)"
jq --rawfile seed "$work/seed.base64" '[{op:"test",path:"/metadata/resourceVersion",value:.metadata.resourceVersion},{op:"add",path:"/binaryData/runtime.tgz",value:$seed}]' "$work/configmap.json" > "$work/configmap-patch.json"
jq --arg hash "$hash" '[{op:"test",path:"/metadata/resourceVersion",value:.metadata.resourceVersion},{op:"add",path:"/spec/template/metadata/annotations",value:((.spec.template.metadata.annotations // {}) + {"checksum/seed":$hash})}]' "$work/deployment.json" > "$work/deployment-patch.json"
kubectl -n "$ns" patch configmap ocm-orce-seed --type=json --patch-file "$work/configmap-patch.json"
kubectl -n "$ns" patch deployment ocm-orce --type=json --patch-file "$work/deployment-patch.json"
kubectl -n "$ns" rollout status deployment/ocm-orce --timeout=15m
kubectl -n "$ns" exec deployment/ocm-orce -c orce -- node -e '
const http=require("node:http");
http.get("http://127.0.0.1:1880/orce/auth/callback?error=access_denied&state=smoke-test",res=>{
 let body="";res.on("data",chunk=>body+=chunk);res.on("end",()=>{
  if(res.statusCode!==200||!body.includes("id=\"app\"")){console.error("Callback smoke check failed: HTTP "+res.statusCode);process.exitCode=1;}
  else console.log("Callback serves the UI (HTTP 200). Open /orce/ and start a fresh login.");
 });
}).on("error",()=>{console.error("Callback smoke check could not connect");process.exitCode=1;});'
