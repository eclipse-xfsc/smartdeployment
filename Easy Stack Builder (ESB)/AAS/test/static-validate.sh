#!/usr/bin/env bash
set -euo pipefail

module_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { printf 'static validation (AAS): %s\n' "$*" >&2; exit 1; }

while IFS= read -r -d '' file; do
  bash -n "$file"
done < <(find "$module_dir" -type f -name '*.sh' -print0)

while IFS= read -r -d '' file; do
  node --check "$file" >/dev/null
done < <(find "$module_dir" -maxdepth 1 -type f -name '*.js' -print0)

python3 - "$module_dir" <<'PY_POLICY'
from pathlib import Path
import json
import re
import sys

root = Path(sys.argv[1])
bad = []
insecure_curl = re.compile(r'\bcurl\b[^\n]*(?:--insecure|(?:^|\s)-[A-Za-z]*k[A-Za-z]*(?:\s|$))')

for path in root.rglob('*'):
    if not path.is_file() or path.suffix not in {'.sh', '.js', '.html', '.yaml', '.yml', '.json', '.md', '.txt'}:
        continue
    if path.name == 'static-validate.sh' and path.parent.name == 'test':
        continue
    if 'node_modules' in path.parts:
        continue
    try:
        text = path.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        continue
    if insecure_curl.search(text):
        bad.append(f'insecure curl: {path}')
    for line_number, line in enumerate(text.splitlines(), 1):
        if '|| true' in line and any(term in line.lower() for term in ('curl', 'health', 'ready', 'rollout status', 'kubectl wait', 'test_url')):
            bad.append(f'fail-open health check: {path}:{line_number}')

for path in root.rglob('*.json'):
    try:
        json.loads(path.read_text(encoding='utf-8'))
    except Exception as exc:
        bad.append(f'invalid JSON: {path}: {exc}')

if bad:
    print('\n'.join(bad), file=sys.stderr)
    raise SystemExit(1)
PY_POLICY

[[ -f "$module_dir/test/health-check.sh" ]] || fail 'health-only test harness missing'
bash -n "$module_dir/test/health-check.sh"
[[ -f "$module_dir/preflight.sh" ]] || fail 'AAS preflight missing'

[[ -x "$module_dir/test/bdd/run-bdd.sh" ]] || fail 'executable BDD runner missing'
[[ -f "$module_dir/test/bdd/features/aas-deployment-health.feature" ]] || fail 'BDD feature missing'
[[ -f "$module_dir/test/TRACEABILITY_MATRIX.md" ]] || fail 'BDD traceability matrix missing'
[[ -x "$module_dir/test/evidence/collect-runtime-evidence.sh" ]] || fail 'runtime evidence collector missing'

grep -q 'id="node-input-manageIngressNginx"' "$module_dir/aas.html" \
  || fail 'Node-RED ingress management opt-in checkbox missing'
grep -q 'manageIngressNginx: { value: false }' "$module_dir/aas.html" \
  || fail 'ingress management must default to false'
grep -q 'id="node-input-allowIngressAdmissionWebhookDeletion"' "$module_dir/aas.html" \
  || fail 'emergency admission-webhook deletion checkbox missing'
grep -q 'allowIngressAdmissionWebhookDeletion: { value: false }' "$module_dir/aas.html" \
  || fail 'admission-webhook deletion must default to false'
grep -q 'node-input-caBundle' "$module_dir/aas.html" \
  || fail 'trusted CA editor input missing'

grep -q 'esb_repair_ingress_admission' "$module_dir/scripts/deploy.sh" \
  || fail 'ingress admission certificate repair path missing'
[[ "$(grep -c 'kubectl delete validatingwebhookconfiguration ingress-nginx-admission' "$module_dir/scripts/deploy.sh")" -eq 1 ]] \
  || fail 'admission webhook deletion must exist only in the separately guarded emergency fallback'
grep -q 'kubectl apply --dry-run=server' "$module_dir/scripts/deploy.sh" \
  || fail 'read-only ingress admission probe missing'
grep -q 'MANAGE_INGRESS_NGINX' "$module_dir/scripts/deploy.sh" \
  || fail 'ingress management shell guard missing'
grep -q 'openssl req -x509' "$module_dir/scripts/deploy.sh" \
  || fail 'direct ingress admission certificate generation missing'
if grep -q 'wait .*job/ingress-nginx-admission' "$module_dir/scripts/deploy.sh"; then
  fail 'deployment must not depend on ingress-nginx admission certificate Job completion'
fi
if grep -REqs --include='*.sh' --exclude='static-validate.sh' 'kubectl[^#]*[[:space:]]version([[:space:]]|$)' "$module_dir"; then
  fail 'kubectl client/server version compatibility must not be gated beyond API reachability'
fi
grep -q 'get --raw=/version' "$module_dir/preflight.sh" \
  || fail 'preflight API reachability check missing'

if grep -Rqs --include='*.sh' --exclude='static-validate.sh' 'command esb_curl' "$module_dir"; then
  fail 'esb_curl helper recursively invokes itself'
fi
if grep -Rqs --include='*.sh' --exclude='static-validate.sh' 'sed -i' "$module_dir"; then
  fail 'deployment mutates packaged source files with sed -i'
fi
if grep -q "pickOutputValue(stdout, 'STATUS') || 'Deployed'" "$module_dir/aas.js"; then
  fail 'Node.js fabricates Deployed status'
fi
if grep -Rqs --include='*.sh' --exclude='static-validate.sh' 'esb_curl .*\$TEST_URL' "$module_dir"; then
  fail 'functional /demo probe is outside deployer test scope'
fi
if grep -q 'test-server' "$module_dir/helm/AAS/templates/ingress.yaml"; then
  fail 'auth-server ingress aliases test-server'
fi

grep -q 'kind: Deployment' "$module_dir/helm/AAS/templates/test-server-deployment.yaml" \
  || fail 'test-server Deployment missing'
grep -q 'name: test-server' "$module_dir/helm/AAS/templates/test-server-service.yaml" \
  || fail 'test-server Service missing'
grep -q 'name: test-server' "$module_dir/helm/AAS/templates/test-server-ingress.yaml" \
  || fail 'test-server Ingress missing'

python3 - "$module_dir/helm/AAS/values.yaml" <<'PY_IMAGE'
from pathlib import Path
import sys

lines = Path(sys.argv[1]).read_text(encoding='utf-8').splitlines()
try:
    image_index = lines.index('image:')
except ValueError:
    raise SystemExit('AAS image block missing')
values = {}
for line in lines[image_index + 1:]:
    if not line.startswith((' ', '\t')):
        break
    key, sep, value = line.strip().partition(':')
    if sep:
        values[key] = value.strip().strip('"\'')
expected = {
    'repository': 'registry.gitlab.com/gaia-x/data-infrastructure-federation-services/authenticationauthorization',
    'name': 'auth-service-image',
    'tag': 'latest',
    'sha': '',
    'pullPolicy': 'Always',
    'pullSecrets': '',
}
for key, value in expected.items():
    if values.get(key) != value:
        raise SystemExit(f'AAS image {key} mismatch: {values.get(key)!r}')
PY_IMAGE

printf 'static validation (AAS): PASS\n'
