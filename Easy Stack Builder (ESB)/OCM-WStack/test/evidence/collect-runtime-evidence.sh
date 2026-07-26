#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_ROOT="${OCM_EVIDENCE_ROOT:-$(pwd)/ocmwstack-reference-evidence-${STAMP}}"
mkdir -p "$EVIDENCE_ROOT"

ARGS=("$@")
ARGS+=(--evidence-dir "$EVIDENCE_ROOT")

set +e
"$ROOT_DIR/test/bdd/run.sh" "${ARGS[@]}"
RESULT=$?
set -e

cp "$ROOT_DIR/test/bdd/features/ocmwstack-health.feature" "$EVIDENCE_ROOT/"
cp "$ROOT_DIR/test/bdd/traceability.csv" "$EVIDENCE_ROOT/"
printf '%s\n' "$RESULT" > "$EVIDENCE_ROOT/exit-code.txt"

ARCHIVE="${EVIDENCE_ROOT}.tar.gz"
tar -C "$(dirname "$EVIDENCE_ROOT")" -czf "$ARCHIVE" "$(basename "$EVIDENCE_ROOT")"
echo "Evidence archive: $ARCHIVE"
exit "$RESULT"
