#!/usr/bin/env bash
set -Eeuo pipefail

MODULE_SLUG="aas"
ENV_PREFIX="AAS"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEFAULT_ROOT="$(pwd)/${MODULE_SLUG}-reference-evidence-${STAMP}"
ENV_NAME="${ENV_PREFIX}_EVIDENCE_ROOT"
EVIDENCE_ROOT="${!ENV_NAME:-$DEFAULT_ROOT}"
mkdir -p "$EVIDENCE_ROOT"

set +e
"$MODULE_DIR/test/bdd/run-bdd.sh" "$@" --evidence-dir "$EVIDENCE_ROOT"
RESULT=$?
set -e

cp "$MODULE_DIR/test/bdd/features/aas-deployment-health.feature" "$EVIDENCE_ROOT/"
cp "$MODULE_DIR/test/TRACEABILITY_MATRIX.md" "$EVIDENCE_ROOT/"
printf '%s\n' "$RESULT" >"$EVIDENCE_ROOT/exit-code.txt"

ARCHIVE="${EVIDENCE_ROOT}.tar.gz"
tar -C "$(dirname "$EVIDENCE_ROOT")" -czf "$ARCHIVE" "$(basename "$EVIDENCE_ROOT")"
printf 'Evidence archive: %s\n' "$ARCHIVE"
exit "$RESULT"
