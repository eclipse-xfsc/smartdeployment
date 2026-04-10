#!/usr/bin/env bash

set -euo pipefail

DOMAIN="${1:-${DOMAIN:-}}"
[[ -n "$DOMAIN" ]] || { echo "Usage: $0 <domain>" >&2; exit 1; }

curl -fsS "https://didlint.ownyourdata.eu/validate?did=did:web:cloud-wallet.${DOMAIN}" | grep "Conforms to W3C DID Spec v1.0"
