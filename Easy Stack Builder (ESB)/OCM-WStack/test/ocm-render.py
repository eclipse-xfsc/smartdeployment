#!/usr/bin/env python3
"""Render the available real policy/verification chart snapshots and AppSet patch."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import yaml

ROOT = Path(__file__).resolve().parents[1]
HELM = os.environ.get('HELM_BIN', 'helm')
def run(*args):
    return subprocess.check_output([str(x) for x in args], cwd=ROOT, text=True)
def docs(text):
    return [d for d in yaml.safe_load_all(text) if d]
def save(p, value):
    p.write_text(json.dumps(value))
    return p

with tempfile.TemporaryDirectory(prefix='esb-ocm-render-') as tmp:
    tmp = Path(tmp)
    source = tmp / 'source'
    shutil.copytree(ROOT / 'test/fixtures/upstream', source)
    run('node', '-e', 'require("./lib/adapt").adapt(process.argv[1]).catch(e=>{console.error(e);process.exit(1)})', source)
    cfg = save(tmp / 'config.json', {'tenantId':'company_one','tenantUrl':'https://company-one.example.com'})
    override = json.loads(run('node', '-e', 'console.log(JSON.stringify(require("./lib/ocm").overrides(require(process.argv[1]))))', cfg))
    for chart_path, child in [('OCM W-Stack/Policy Chart','policy'), ('OCM W-Stack/Credential Verification Service Chart','credential-verification-service')]:
        chart = source / chart_path
        dependency = ROOT / 'test/fixtures/dependencies' / child
        shutil.copytree(dependency, chart / 'charts' / child)
        # Available policy snapshot is 1.4.3, not the runtime OCI tag
        # 1.0.0-helm. Only this offline test's parent version is adjusted.
        # Runtime prepare() still retrieves and validates the exact selected tag.
        definition = yaml.safe_load((chart / 'Chart.yaml').read_text())
        definition['dependencies'][0]['version'] = yaml.safe_load((dependency / 'Chart.yaml').read_text())['version']
        (chart / 'Chart.yaml').write_text(yaml.safe_dump(definition))
        vals = save(tmp / 'child-values.json', override[chart_path])
        for upgrade in [False, True]:
            args = [HELM, 'template', child+'-chart', chart, '-n','ocm-wstack','-f',vals]
            if upgrade:
                args.append('--is-upgrade')
            manifests = docs(run(*args))
            payload = save(tmp / 'manifests.json', {str(i):d for i,d in enumerate(manifests)})
            run('node', '-e', 'require("./lib/ocm").validateManifests(require(process.argv[1]),process.argv[2])', payload, chart_path)
            workload = next(d for d in manifests if d['kind']=='Deployment')
            env = {e['name']:e for e in workload['spec']['template']['spec']['containers'][0]['env']}
            if child == 'credential-verification-service':
                assert env['CREDENTIALVERIFICATION_ENABLED']['value'] == 'true'
                assert env['DID_RESOLVER']['value'] == 'http://universal-resolver.infrastructure.svc.cluster.local:8080'
                assert env['CREDENTIALVERIFICATION_AUTHORIZEENDPOINT']['value'].endswith('/v1/tenants/company_one/presentation/')
            assert not any('NAMESPACE' in str(e.get('value','')) for e in env.values())
            print('PASS real chart snapshot:', child, 'upgrade' if upgrade else 'install')
    app_values = json.loads(run('node','-e','console.log(JSON.stringify(require("./lib/ocm").values(require(process.argv[1]))))', cfg))
    appset = next(d for d in docs(run(HELM,'template','ocm-wstack',source/'XFSC/Applicationsets/chart',
        '-f',source/'XFSC/Applicationsets/values/06_ocm_wstack-values.yaml','-f',save(tmp/'appset.json',app_values))) if d['kind']=='ApplicationSet')
    assert appset['spec']['template']['spec']['source']['targetRevision']=='main'
    evaluator=tmp/'evaluator'
    (evaluator/'templates').mkdir(parents=True)
    (evaluator/'Chart.yaml').write_text('apiVersion: v2\nname: patch-test\nversion: 1.0.0\n')
    (evaluator/'templates/patch.yaml').write_text('{{ tpl .Values.patch .Values.context }}')
    for chart_path in [*override, 'OCM W-Stack/Storage Service']:
        result=docs(run(HELM,'template','test',evaluator,'-f',save(tmp/'patch.json',{
            'patch':appset['spec']['templatePatch'],'context':{'path':{'path':chart_path}}})))
        if chart_path in override:
            assert result[0]['spec']['source']['helm']['valuesObject']==override[chart_path]
        else:
            assert result==[], 'Unrelated applications must not receive an empty destructive spec patch'
    print('PASS actual ApplicationSet Go-template patch for policy, verification and unrelated service')
