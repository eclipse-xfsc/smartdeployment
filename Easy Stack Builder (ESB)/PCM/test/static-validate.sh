#!/usr/bin/env bash
set -euo pipefail
module_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { printf 'static validation (PCM): %s\n' "$*" >&2; exit 1; }
while IFS= read -r -d '' f; do bash -n "$f"; done < <(find "$module_dir" -type f -name '*.sh' -print0)
while IFS= read -r -d '' f; do node --check "$f" >/dev/null; done < <(find "$module_dir" -maxdepth 1 -type f -name '*.js' -print0)
python3 - "$module_dir" <<'PYI'
from pathlib import Path
import re,sys
root=Path(sys.argv[1]); bad=[]
for p in root.rglob('*'):
 if not p.is_file() or p.suffix not in {'.sh','.js','.html','.yaml','.yml','.json','.md','.txt'}: continue
 if p.name == 'static-validate.sh' and p.parent.name == 'test': continue
 if 'node_modules' in p.parts: continue
 try:s=p.read_text(encoding='utf-8')
 except:continue
 if re.search(r'\bcurl\b[^\n]*(?:--insecure|(?:^|\s)-[A-Za-z]*k[A-Za-z]*(?:\s|$))',s): bad.append(f'insecure curl: {p}')
 for n,l in enumerate(s.splitlines(),1):
  if '|| true' in l and any(x in l.lower() for x in ('curl','health','ready','rollout status','kubectl wait','test_url')): bad.append(f'fail-open health check: {p}:{n}')
if bad: print('\n'.join(bad),file=sys.stderr); sys.exit(1)
PYI
[[ -f "$module_dir/test/health-check.sh" ]] || fail 'health-only test harness missing'
bash -n "$module_dir/test/health-check.sh"
[[ -x "$module_dir/test/bdd/run-bdd.sh" ]] || fail 'executable BDD runner missing'
[[ -f "$module_dir/test/bdd/features/pcm-deployment-health.feature" ]] || fail 'BDD feature missing'
[[ -f "$module_dir/test/TRACEABILITY_MATRIX.md" ]] || fail 'BDD traceability matrix missing'
[[ -x "$module_dir/test/evidence/collect-runtime-evidence.sh" ]] || fail 'runtime evidence collector missing'
grep -Rqs 'node-input-caBundle' "$module_dir"/*.html || fail 'trusted CA editor input missing'
grep -Rqs 'id="node-input-manageIngressNginx"' "$module_dir"/*.html || fail 'Node-RED ingress opt-in checkbox missing'
grep -Rqs 'MANAGE_INGRESS_NGINX' "$module_dir" --include='deploy*.sh' || fail 'ingress opt-in shell guard missing'

python3 - "$module_dir/deploy.sh" <<'PY_INGRESS_GUARD'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding='utf-8')
start = text.index('patch_ingress_tls() {')
end = text.index('\n}\n', start) + 3
body = text[start:end]
disabled = body.index('if [[ "$MANAGE_INGRESS_NGINX" != "true" ]]')
return_pos = body.index('return 0', disabled)
patch_pos = body.index('kubectl -n ingress-nginx patch configmap ingress-nginx-controller')
if patch_pos < return_pos:
    raise SystemExit('ingress-nginx ConfigMap patch is reachable while management is disabled')
if '|| true' in body:
    raise SystemExit('ingress-nginx management errors must not be suppressed')
PY_INGRESS_GUARD
printf 'static validation (PCM): PASS\n'
