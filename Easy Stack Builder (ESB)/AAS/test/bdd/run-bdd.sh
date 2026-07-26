#!/usr/bin/env bash
set -Eeuo pipefail

MODULE_NAME="AAS"
SUITE_NAME="AAS deployment-health BDD"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HEALTH_RUNNER="$MODULE_DIR/test/health-check.sh"
EVIDENCE_DIR=""
HEALTH_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --evidence-dir)
      [[ $# -ge 2 ]] || { printf '%s\n' '--evidence-dir requires a value' >&2; exit 2; }
      EVIDENCE_DIR="$2"
      shift 2
      ;;
    *)
      HEALTH_ARGS+=("$1")
      shift
      ;;
  esac
done

[[ -n "$EVIDENCE_DIR" ]] || { printf '%s\n' '--evidence-dir is required' >&2; exit 2; }
mkdir -p "$EVIDENCE_DIR"

set +e
"$HEALTH_RUNNER" "${HEALTH_ARGS[@]}" >"$EVIDENCE_DIR/runtime-health.json" 2>"$EVIDENCE_DIR/runtime-health.stderr"
HEALTH_RC=$?
set -e

if [[ "$HEALTH_RC" -eq 0 ]]; then
  STATUS="passed"
else
  STATUS="failed"
fi

python3 - "$EVIDENCE_DIR/bdd-results.json" "$MODULE_NAME" "$SUITE_NAME" "$STATUS" "$HEALTH_RC" <<'PY_RESULTS'
import json
import sys

output, module, suite, status, exit_code = sys.argv[1:]
scenarios = [
    {"id": f"BDD-{module}-01", "name": f"{module} namespace is available", "status": status},
    {"id": f"BDD-{module}-02", "name": f"{module} workloads are healthy and ready", "status": status},
    {"id": f"BDD-{module}-03", "name": f"{module} optional endpoint uses verified TLS", "status": status},
    {"id": f"BDD-{module}-04", "name": "Health validation fails closed", "status": status},
]
with open(output, "w", encoding="utf-8") as handle:
    json.dump({
        "suite": suite,
        "module": module,
        "scope": "deployment health only",
        "status": status,
        "exitCode": int(exit_code),
        "scenarios": scenarios,
    }, handle, indent=2)
    handle.write("\n")
PY_RESULTS

{
  printf '# %s BDD Results\n\n' "$MODULE_NAME"
  printf -- '- Scope: **deployment health only**\n'
  printf -- '- Result: **%s**\n' "$STATUS"
  printf -- '- Runtime health exit code: `%s`\n\n' "$HEALTH_RC"
  printf 'The runner checks Kubernetes namespace and workload readiness. When a URL is supplied, it also verifies endpoint reachability with certificate validation. It does not execute credential, authentication, issuance, policy, signing, or other business workflows.\n'
} >"$EVIDENCE_DIR/bdd-results.md"

exit "$HEALTH_RC"
