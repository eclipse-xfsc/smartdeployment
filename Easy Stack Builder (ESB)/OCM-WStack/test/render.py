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

def telemetry_schema(value, schema):
    """Validate the types, required fields and enums used by this specific CRD."""
    types = {'object': dict, 'string': str, 'boolean': bool, 'integer': int}
    if 'type' in schema:
        assert type(value) is types[schema['type']], (value, schema['type'])
    if 'enum' in schema:
        assert value in schema['enum']
    if isinstance(value, dict):
        assert all(key in value for key in schema.get('required', []))
        for key, child in schema.get('properties', {}).items():
            if key in value:
                telemetry_schema(value[key], child)

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

    # Exercise every wrapper selected by the same planner used before deployment.
    # Dependencies are deliberately removed ONLY in this wrapper-only test. This
    # does not count as dependency validation; runtime preflight builds them all.
    plan_json = run('node', '-e', '''
const {plan}=require('./lib/chart-check');
const {Runner}=require('./lib/runner');
const {config,resolve}=require('./lib/config');
const c=resolve(config(require('./examples/deployment.json')),{items:[]},{items:[{metadata:{name:'fast'}}]},{ });
'''.replace("config(require('./examples/deployment.json'))", "config({...require('./examples/deployment.json'),storageClass:'fast'})") + '''
const r=new Runner();const call=r.run.bind(r);r.run=(cmd,args,opts)=>call(cmd==='helm'?process.env.HELM_BIN||'helm':cmd,args,opts);
plan(r,process.argv[1],process.argv[2],c,process.argv[3]).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exit(1)});
''', source, ROOT / 'test/fixtures/upstream', temp)
    jobs = json.loads(plan_json)
    wrappers = temp / 'wrappers'
    shutil.copytree(source, wrappers)
    for chart_file in wrappers.rglob('Chart.yaml'):
        definition = yaml.safe_load(chart_file.read_text())
        definition.pop('dependencies', None)
        chart_file.write_text(yaml.safe_dump(definition))
    all_docs = []
    for i, job in enumerate(jobs):
        # Remote Argo charts are unmodified source, local bootstrap is adapted.
        # No child service chart templates are patched by the ESB.
        args = [HELM, 'template', job['release'], wrappers / job['chart'], '-n', job['namespace']]
        for values in job['files']:
            args += ['-f', wrappers / values]
        args += ['-f', write_json(temp / f'wrapper-{i}.json', job['values'])]
        for parameter in job['parameters']:
            args += ['--set-string', parameter]
        docs = manifests(run(*args))
        upgraded = manifests(run(*args, '--is-upgrade'))
        all_docs += docs
        for doc in docs + upgraded:
            if doc['kind'] in ['Job', 'CronJob']:
                spec = doc['spec']['jobTemplate']['spec'] if doc['kind'] == 'CronJob' else doc['spec']
                for container in spec['template']['spec'].get('containers', []):
                    command = container.get('command', [])
                    if command and command[0] in ['/bin/sh', 'sh', '/bin/bash', 'bash']:
                        script = (command + container.get('args', []))[-1]
                        subprocess.run(['sh', '-n'], input=script, text=True, check=True)
        print(f'PASS wrapper install + upgrade: {job["release"]} ({job["chart"]})')
    assert len(jobs) == 34
    telemetry = yaml.safe_load((source / 'INFRA/observability/opentelemtry/crds/telemetryconfig.yaml').read_text())
    assert 'metrics' not in telemetry['spec']
    assert 'metrics' in telemetry['spec']['versions'][0]['schema']['openAPIV3Schema']['properties']['spec']['properties']
    telemetry_doc = next(d for d in all_docs if d['kind'] == 'TelemetryConfig')
    telemetry_schema(telemetry_doc, telemetry['spec']['versions'][0]['schema']['openAPIV3Schema'])
    tempo = yaml.safe_load((source / 'INFRA/observability/opentelemtry/values.yaml').read_text())['tempo']['tempo']
    assert tempo['receivers']['otlp']['protocols'] == {'grpc': {'endpoint': '0.0.0.0:4317'}, 'http': {'endpoint': '0.0.0.0:4318'}}
    print('PASS TelemetryConfig CRD field placement and Tempo receiver types')
    monitoring = yaml.safe_load((source / 'INFRA/observability/opentelemtry/values.yaml').read_text())['monitoring']['grafana']
    assert monitoring['sidecar']['datasources']['enabled'] is True
    assert monitoring['sidecar']['datasources']['defaultDatasourceEnabled'] is False
    assert monitoring['sidecar']['datasources']['alertmanager']['enabled'] is False
    assert monitoring['additionalDataSources'] == []
    data = [yaml.safe_load(value) for doc in all_docs if doc.get('kind') == 'ConfigMap' and doc.get('metadata', {}).get('labels', {}).get('grafana_datasource') == '1' for name, value in doc.get('data', {}).items() if name.endswith('.yaml')]
    definitions = [ds for item in data for ds in item.get('datasources', [])]
    assert len(definitions) == 5
    assert len({ds['uid'] for ds in definitions}) == 5
    assert [ds['uid'] for ds in definitions if ds.get('isDefault')] == ['prometheus']
    print('PASS Grafana canonical datasource definitions and subchart duplicate suppression')


    # Evaluate the actual AppProject template for absent, owned and foreign
    # project states. Only lookup is replaced; the rest is the real template.
    projects = temp / 'projects'
    shutil.copytree(source / 'XFSC/Applicationsets/chart', projects)
    template = projects / 'templates/approject.yaml'
    template.write_text(template.read_text().replace('lookup "argoproj.io/v1alpha1" "AppProject" $projectNamespace .name', '.testExisting'))
    for label, existing, expected in [
        ('absent', {}, True),
        ('owned', {'metadata': {'annotations': {'meta.helm.sh/release-name': 'storage', 'meta.helm.sh/release-namespace': 'infrastructure'}}}, True),
        ('foreign', {'metadata': {'annotations': {'meta.helm.sh/release-name': 'other', 'meta.helm.sh/release-namespace': 'infrastructure'}}}, False)
    ]:
        v = write_json(temp / 'project.json', {'project': {'testExisting': existing}})
        docs = manifests(run(HELM, 'template', 'storage', projects, '-n', 'infrastructure', '-f', source / 'XFSC/Applicationsets/values/03_storage-values.yaml', '-f', v, '--is-upgrade'))
        assert any(d['kind'] == 'AppProject' for d in docs) == expected
        print(f'PASS AppProject upgrade ownership: {label}')

    # Run the exact mount-inspection block from the adapted provisioning hook
    # against realistic multi-line JSON and CLI table fixtures.
    namespace_job = next(d for d in all_docs if d['kind'] == 'Job' and d['metadata']['name'] == 'infrastructure-namespace-openbao-access')
    script = namespace_job['spec']['template']['spec']['containers'][0]['command'][-1]
    block = script[script.index('MOUNT_TYPE="$('):script.index('echo "Generating resource provisioner policy..."')]
    block = block[:block.index('\nelse\n')]
    for mount_type, expected in [('kv', 0), ('transit', 1)]:
        program = 'set -eu\nSTORE_MOUNT=infrastructure/system\nbao() { printf "Path Type Accessor Description\\ninfrastructure/system/ ' + mount_type + ' mount_accessor desc\\n"; }\n' + block
        result = subprocess.run(['sh'], input=program, text=True, capture_output=True)
        assert result.returncode == expected, result.stdout + result.stderr
        print(f'PASS existing OpenBao mount type: {mount_type}')
