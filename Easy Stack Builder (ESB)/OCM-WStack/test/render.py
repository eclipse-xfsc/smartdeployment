#!/usr/bin/env python3
"""Offline render checks using Helm 3 and PyYAML; no cluster or chart downloads."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
HELM = os.environ.get('HELM_BIN', 'helm')

def run(*args, cwd=ROOT):
    return subprocess.check_output([str(a) for a in args], cwd=cwd, text=True)

def write_json(p, obj):
    p.write_text(json.dumps(obj))
    return p

def manifests(text):
    return [d for d in yaml.safe_load_all(text) if d]

with tempfile.TemporaryDirectory(prefix='esb-render-') as temp:
    temp = pathlib.Path(temp)
    source = temp / 'deployment'
    shutil.copytree(ROOT / 'test/fixtures/upstream', source)
    run('node', '-e', 'require("./lib/adapt").adapt(process.argv[1]).catch(e=>{console.error(e);process.exit(1)})', source)
    evaluator = temp / 'evaluator'
    (evaluator / 'templates').mkdir(parents=True)
    (evaluator / 'Chart.yaml').write_text('apiVersion: v2\nname: template-evaluator\nversion: 0.0.0\n')
    (evaluator / 'templates/patch.yaml').write_text('{{ tpl .Values.patch .Values.context }}')
    proxy = temp / 'envoy-proxy'
    (proxy / 'templates').mkdir(parents=True)
    (proxy / 'Chart.yaml').write_text('apiVersion: v2\nname: upstream-envoy-proxy\nversion: 0.0.0\n')
    shutil.copyfile(source / 'INFRA/network/envoy/values.yaml', proxy / 'values.yaml')
    shutil.copyfile(source / 'INFRA/network/envoy/templates/envoyproxy.yaml', proxy / 'templates/proxy.yaml')

    scenarios = [
        {'actualProvider': 'aws', 'externalDns': False, 'actualDns': 'disabled', 'lbAnnotations': {}},
        {'actualProvider': 'hetzner', 'externalDns': True, 'actualDns': 'ionos', 'lbAnnotations': {}},
        {'actualProvider': 'generic', 'externalDns': True, 'actualDns': 'custom', 'lbAnnotations': {'example.com/lb': 'public'},
         'dnsValues': {'provider': {'name': 'cloudflare'}, 'txtOwnerId': '{{ fail "must stay data" }}',
                       'env': [{'name': 'CF_API_TOKEN', 'valueFrom': {'secretKeyRef': {'name': 'external-dns', 'key': 'token'}}}]}}
    ]
    for i, scenario in enumerate(scenarios):
        cfg = write_json(temp / 'scenario.json', scenario)
        values = json.loads(run('node', '-e', 'console.log(JSON.stringify(require("./lib/adapt").networkValues(require(process.argv[1]))))', cfg))
        values.update(storageClass='fast', domain='example.com', email='admin@example.com', profile='generic')
        value_file = write_json(temp / 'network.json', values)
        documents = manifests(run(HELM, 'template', 'network', source / 'XFSC/Applicationsets/chart', '-f', source / 'XFSC/Applicationsets/values/04_network-values.yaml', '-f', value_file))
        appset = next(d for d in documents if d['kind'] == 'ApplicationSet')
        spec = appset['spec']
        assert spec['generators'][0]['git']['revision'] == 'main'
        assert spec['template']['spec']['source']['targetRevision'] == 'main'
        assert spec['template']['spec']['syncPolicy']['automated'] == {'prune': True, 'selfHeal': True}
        patch = spec['templatePatch']
        for chart_path in ['INFRA/network/envoy', 'INFRA/network/external-dns', 'INFRA/network/cert-manager']:
            p = write_json(temp / 'patch.json', {'patch': patch, 'context': {'path': {'path': chart_path}}})
            rendered = manifests(run(HELM, 'template', 'test', evaluator, '-f', p))
            if chart_path.endswith('/envoy'):
                override = rendered[0]['spec']['source']['helm']['valuesObject']
                env_file = write_json(temp / 'envoy-values.json', override)
                envoy = manifests(run(HELM, 'template', 'test', proxy, '-f', env_file))[0]
                annotations = envoy['spec']['provider']['kubernetes']['envoyService'].get('annotations', {})
                if scenario['actualProvider'] == 'hetzner':
                    assert annotations['load-balancer.hetzner.cloud/type'] == 'lb11'
                else:
                    assert not any('hetzner' in k for k in annotations)
                for key, value in scenario['lbAnnotations'].items():
                    assert annotations[key] == value
            elif chart_path.endswith('/external-dns') and scenario['externalDns']:
                dns = rendered[0]['spec']['source']['helm']['valuesObject']['external-dns']
                assert '--managed-record-types=CNAME' in dns['extraArgs']
                assert '--managed-record-types=AAAA' in dns['extraArgs']
                for key, value in scenario.get('dnsValues', {}).items():
                    assert dns[key] == value
            else:
                assert rendered == [], 'An empty spec patch would clear unrelated child configuration'
        print(f'PASS ApplicationSet + Envoy render: {scenario["actualProvider"]}/{scenario["actualDns"]}')

    for tenant_id in ['demo-tenant', 'company_one']:
        subdomain = tenant_id.replace('_', '-')
        v = write_json(temp / 'tenant.json', {'tenant': {'id': tenant_id, 'group': tenant_id, 'domain': 'example.com', 'subdomain': subdomain}, 'openbao': {'transit': {'mountPath': f'ocm-wstack/{tenant_id}'}}})
        docs = manifests(run(HELM, 'template', 'demotenant', source / 'XFSC/tenant/chart', '-n', 'ocm-wstack', '-f', source / 'XFSC/tenant/values/tenant-ocm-wstack-values.yaml', '-f', v))
        cert = next(d for d in docs if d['kind'] == 'Certificate')
        assert cert['spec']['dnsNames'] == [f'{subdomain}.example.com']
        assert cert['spec']['issuerRef']['name'] == 'letsencrypt'
        listener = next(d for d in docs if d['kind'] == 'ListenerSet')
        assert listener['spec']['parentRef']['namespace'] == 'infrastructure'
        routes = [d for d in docs if d['kind'] == 'HTTPRoute']
        assert len(routes) == 1
        assert len(routes[0]['spec']['rules']) >= 10
        for rule in routes[0]['spec']['rules']:
            headers = next(f['requestHeaderModifier']['set'] for f in rule['filters'] if f['type'] == 'RequestHeaderModifier')
            header_map = {h['name'].lower(): h['value'] for h in headers}
            assert header_map['x-tenantid'] == tenant_id
            assert header_map['x-group'] == tenant_id
            assert header_map['x-namespace'] == 'ocm-wstack'
        jobs = [d for d in docs if d['kind'] == 'Job']
        registration = next(d for d in jobs if d['metadata']['name'].endswith('-registration'))
        assert '--fail-with-body' in registration['spec']['template']['spec']['containers'][0]['args'][0]
        bootstrap = next(d for d in jobs if d['metadata']['name'].endswith('-openbao-bootstrap'))
        env = {e['name']: e['value'] for e in bootstrap['spec']['template']['spec']['containers'][0]['env']}
        assert env['TRANSIT_PATH'] == f'ocm-wstack/{tenant_id}'
        print(f'PASS tenant routes, certificate, registration and transit mount: {tenant_id}')
