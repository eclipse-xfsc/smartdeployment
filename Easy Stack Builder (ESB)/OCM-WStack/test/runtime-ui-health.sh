#!/usr/bin/env bash
set -euo pipefail
ns="${1:?namespace required}"; domain="${2:?bare domain required}"; token_file="${3:-}"
[[ "$ns" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || exit 2
[[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || exit 2
base="https://cloud-wallet.$domain/orce"
kubectl -n "$ns" rollout status deployment/ocm-orce --timeout=5m
kubectl -n "$ns" get ingress ocm-orce -o json | jq -e '.spec.ingressClassName == "nginx-orce-cluster"' >/dev/null
curl -fsS "$base/" | grep -q 'id="app"'
curl -fsS "$base/auth/callback?error=access_denied&state=smoke-test" | grep -q 'id="app"'
curl -fsS "$base/ui-api/v1/health/ready" | jq -e '.ready == true' >/dev/null
code="$(curl -sS -o /dev/null -w '%{http_code}' "$base/ui-api/v1/credentials")"
[[ "$code" == 401 ]] || { echo "Unauthenticated credentials request returned $code" >&2; exit 1; }
if [[ -n "$token_file" ]]; then
  umask 077
  headers="$(mktemp)"; trap 'rm -f "$headers"' EXIT
  printf 'Authorization: Bearer %s\n' "$(cat "$token_file")" > "$headers"
  curl -fsS -H "@$headers" "$base/ui-api/v1/auth/me" | jq -e '.data.subject and .data.permissions' >/dev/null
  curl -fsS -H "@$headers" "$base/ui-api/v1/credentials" | jq -e '.data.items | type == "array"' >/dev/null
fi
echo 'Runtime reachability, readiness and authentication smoke checks passed. Full acceptance remains a separate checklist.'
