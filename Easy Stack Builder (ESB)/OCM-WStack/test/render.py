#!/usr/bin/env python3
"""Real Helm rendering for compatibility charts and the two-stage null path."""
import json, pathlib, shutil, subprocess, tempfile
import yaml
root=pathlib.Path(__file__).resolve().parents[1]
helm=shutil.which('helm')
if not helm:
    raise SystemExit('Helm is required for chart rendering.')
def render(chart,values,upgrade=False):
    with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
        json.dump(values,f); f.flush()
        args=[helm,'template','demotenant',str(chart),'-n','ocm-wstack','-f',f.name]
        if upgrade: args+=['--is-upgrade']
        return [d for d in yaml.safe_load_all(subprocess.check_output(args,text=True)) if d]
base={'image':'ecofacis/xfsc-orce:2.0.15','host':'demo-tenant.example.com','listenerSetName':'demotenant-xfsc-tenant-gateway','storage':{'class':'ionos-cloud-essential'},'gatewayPorts':[80,443,10080,10443],'hostAliases':[{'ip':'100.64.9.12','hostnames':['demo-tenant.example.com']}],'runtimeConfig':{'publicOrigin':'https://demo-tenant.example.com','auth':{'mode':'local-session','sessionHours':24}}}
checks=0
for upgrade in [False,True]:
    for external in [False,True]:
        docs=render(root/'charts-runtime',{**base,'mongo':{'embedded':not external,'externalPorts':[27017]}},upgrade)
        route=next(d for d in docs if d['kind']=='HTTPRoute')
        assert [r['matches'][0]['path']['value'] for r in route['spec']['rules']]==['/orce','/']
        assert route['spec']['parentRefs'][0]['kind']=='ListenerSet'
        runtime=next(d for d in docs if d['kind']=='Deployment' and d['metadata']['name']=='ocm-orce')
        assert runtime['spec']['template']['spec']['hostAliases']==base['hostAliases']
        seed=next(d for d in docs if d['kind']=='ConfigMap' and d['metadata']['name']=='ocm-orce-seed')
        import base64
        for archive in ['runtime.tgz','ui.tgz']:
            assert base64.b64decode(seed['binaryData'][archive])==(root/'charts-runtime/files'/archive).read_bytes()
        assert sum(len(base64.b64decode(v)) for v in seed['binaryData'].values())+len(seed['data']['seed.sh'].encode()) < 1048576
        init=runtime['spec']['template']['spec']['initContainers'][0]
        assert init['image']=='ecofacis/xfsc-orce:2.0.15'
        assert init['command']==['/bin/sh','/seed/seed.sh']
        assert runtime['spec']['template']['spec']['containers'][0]['image']==init['image']

        policy=next(d for d in docs if d['kind']=='NetworkPolicy' and d['metadata']['name']=='ocm-orce')
        assert {80,443,10080,10443}.issubset({p['port'] for p in policy['spec']['egress'][0]['ports']})
        assert not any(d['kind']=='Ingress' for d in docs)
        pvcs=[d for d in docs if d['kind']=='PersistentVolumeClaim']
        assert len(pvcs)==(1 if external else 2)
        assert all(d['metadata']['annotations']['helm.sh/resource-policy']=='keep' for d in pvcs)
        assert not any(d['kind']=='Secret' for d in docs)
        for deployment in [d for d in docs if d['kind']=='Deployment']:
            assert deployment['spec']['template']['spec']['automountServiceAccountToken'] is False
        checks+=1
    for policy in ['Cluster','Local']:
        docs=render(root/'charts-gateway',{'externalTrafficPolicy':policy},upgrade)
        resource=next(d for d in docs if d['metadata']['name']=='esb-ocm-envoy-traffic')
        assert resource['spec']['rules'][0]['mutate']['patchStrategicMerge']['spec']['provider']['kubernetes']['envoyService']['externalTrafficPolicy']==policy
        assert resource['spec']['rules'][0]['match']['any'][0]['resources']['names']==['envoy']
        checks+=1
with tempfile.TemporaryDirectory() as tmp:
    tmp=pathlib.Path(tmp)
    engine=tmp/'appset-engine';(engine/'templates').mkdir(parents=True)
    (engine/'Chart.yaml').write_text('apiVersion: v2\nname: appset-engine\nversion: 1.0.0\n')
    (engine/'templates/patch.yaml').write_text('{{- $_ := set . "path" (dict "path" .Values.chartPath) -}}\n{{ tpl .Values.esbTemplatePatch . }}\n')
    envoy=tmp/'envoy';(envoy/'templates').mkdir(parents=True)
    (envoy/'Chart.yaml').write_text('apiVersion: v2\nname: envoy-wrapper\nversion: 1.0.0\n')
    shutil.copy(root/'test/fixtures/upstream/INFRA/network/envoy/values.yaml',envoy/'values.yaml')
    shutil.copy(root/'test/fixtures/upstream/INFRA/network/envoy/templates/envoyproxy.yaml',envoy/'templates/envoyproxy.yaml')
    for provider,location in [('ionos',''),('hetzner','hel1')]:
        c={'actualProvider':provider,'lbLocation':location,'lbAnnotations':{'example.com/custom':'retained'},'externalDns':False}
        defaults=yaml.safe_load((envoy/'values.yaml').read_text())
        c['upstreamAnnotationKeys']=list(defaults['envoyProxy']['service']['annotations'])
        c.update(lbNetworkZone='', lbType='', lbPrivate=False, providerLocations=[], providerZones=[], actualDns='disabled')
        program='include \"filters\"; .resolvedLbAnnotations=provider_annotations | network_values($lock[0])'
        settings=json.loads(subprocess.check_output(
            ['jq','-L',str(root/'deployment'),'--slurpfile','lock',str(root/'upstream-lock.json'),program],
            input=json.dumps(c),text=True))
        patch=render(engine,{**settings,'chartPath':'INFRA/network/envoy'})[0]
        helm_text=patch['spec']['source']['helm']['values']
        assert isinstance(helm_text,str)
        overrides=json.loads(helm_text)
        proxy=render(envoy,overrides)[0]
        annotations=proxy['spec']['provider']['kubernetes']['envoyService'].get('annotations',{})
        assert annotations['example.com/custom']=='retained'
        if provider=='ionos': assert not any(k.startswith('load-balancer.hetzner.cloud/') for k in annotations)
        else: assert annotations['load-balancer.hetzner.cloud/location']=='hel1'
        checks+=1
# Render both tenant route sets with the ESB profile and per-tenant overrides.
chart=root/'test/fixtures/tenant-0.9.1'
profile=yaml.safe_load((root/'test/fixtures/upstream/XFSC/tenant/values/tenant-ocm-wstack-values.yaml').read_text())
defaults=yaml.safe_load((chart/'values.yaml').read_text())
defaults.update(profile)
for tenant in ['demo-tenant', 'company_one']:
    for external in [False, True]:
        config={'tenantId':tenant,'tenantSubdomain':tenant.replace('_','-'),'domain':'example.com',
                'tenantRelease':'demotenant','storageRegion':'EU','storageCountry':'DE',
                'runtimeServices':{'didcomm':'http://external.example'} if external else {}}
        args=['jq','-L',str(root/'deployment'),'--argjson','defaults',json.dumps(defaults),
              'include "filters"; tenant_values($defaults)']
        values=json.loads(subprocess.check_output(args,input=json.dumps(config),text=True))
        # Helm merges the profile separately, just as the deployer does.
        values={**profile, **values, 'tenant':{**profile['tenant'],**values['tenant']}}
        for upgrade in [False, True]:
            routes=[d for d in render(chart,values,upgrade) if d['kind']=='HTTPRoute']
            assert len(routes)==2
            issuer=next(d for d in routes if d['metadata']['name'].endswith('-issuer'))
            verifier=next(d for d in routes if d['metadata']['name'].endswith('-verifier'))
            assert {r['matches'][0]['path']['value'] for r in issuer['spec']['rules']} >= {
                '/api/credential','/api/nonce','/api/schema','/test/offering/create','/api/status'}
            proof=[r for r in verifier['spec']['rules'] if 'proof' in r['matches'][0]['path']['value']]
            assert len(proof)==4
            assert {r['matches'][0]['method'] for r in proof}=={'GET','POST'}
            for rule in proof:
                rewrite=next(f for f in rule['filters'] if f['type']=='URLRewrite')
                assert rewrite['urlRewrite']['path']['replacePrefixMatch']==f'/v1/tenants/{tenant}/presentation/proof/'
                headers=next(f for f in rule['filters'] if f['type']=='RequestHeaderModifier')
                headers={h['name'].lower():h['value'] for h in headers['requestHeaderModifier']['set']}
                assert headers['x-signerkey']=='eckey'
                assert headers['x-audience-url']==f'https://{config["tenantSubdomain"]}.example.com'
            didcomm=[r for d in routes for r in d['spec']['rules'] if 'didcomm' in r['name']]
            assert len(didcomm)==(0 if external else 1)
            if didcomm:
                assert didcomm[0]['matches']==[{'path':{'type':'Exact','value':'/api/didcomm/message/receive'},'method':'POST'}]
            checks+=1
# Use the supplied verification chart, including its bundled library dependency.
# This test needs no registry access and exercises install and upgrade rendering.
import tarfile
with tempfile.TemporaryDirectory() as tmp:
    wrapper=pathlib.Path(tmp)/'verification-wrapper'
    wrapper.mkdir()
    upstream=root/'test/fixtures/upstream/OCM W-Stack/Credential Verification Service Chart'
    for name in ['Chart.yaml','values.yaml']:
        shutil.copy(upstream/name,wrapper/name)
    (wrapper/'charts').mkdir()
    archive=root/'test/fixtures/verification-1.2.2/credential-verification-service-1.2.2-alpha.helm.tgz'
    with tarfile.open(archive) as tar:
        tar.extractall(wrapper/'charts',filter='data')
    template=json.loads((root/'deployment/templates/native-overrides.json').read_text())['OCM W-Stack/Credential Verification Service Chart']
    for tenant in ['demo-tenant','company_one']:
        values=json.loads(json.dumps(template).replace('@TENANT_ID@',tenant).replace('@TENANT_URL@',f'https://{tenant}.example.com'))
        for upgrade in [False,True]:
            docs=render(wrapper,values,upgrade)
            checks_result=json.loads(subprocess.check_output(
                ['jq','-L',str(root/'deployment'),'include "filters"; verification_chart_checks'],
                input=json.dumps(docs),text=True))
            assert all(v is True for v in checks_result.values()), checks_result
            deployment=next(d for d in docs if d['kind']=='Deployment')
            env={e['name']:e for e in deployment['spec']['template']['spec']['containers'][0]['env']}
            assert 'CREDENTIALVERIFICATION_MESSAGING_NATS_URL' not in env
            assert 'CREDENTIALVERIFICATION_SIGNINGKEY' not in env
            assert env['CREDENTIALVERIFICATION_NATS_REQUEST_TIMEOUT']['value']=='10'
            claim=next(d for d in docs if d['kind']=='ResourceClaim')
            assert claim['spec']['externalSecretRef']['name']=='demotenant-cassandra-credentials'
            checks+=1
print(f'{checks} real Helm render scenarios passed (runtime, gateway, Envoy, tenant and supplied verification charts).')

for backend in [53,8053,1053]:
    fallback=[] if backend==53 else [{'to':[{'namespaceSelector':{'matchLabels':{'kubernetes.io/metadata.name':'kube-system'}},'podSelector':{'matchLabels':{'k8s-app':'kube-dns'}}}], 'ports':[{'port':backend,'protocol':'UDP'},{'port':backend,'protocol':'TCP'}]}]
    for upgrade in [False,True]:
        docs=render(root/'charts-runtime',{**base,'dnsFallbackEgress':fallback},upgrade)
        policy=next(d for d in docs if d['kind']=='NetworkPolicy' and d['metadata']['name']=='ocm-orce')
        rules=policy['spec']['egress']
        assert any(r.get('ports')==[{'protocol':'UDP','port':53},{'protocol':'TCP','port':53}] for r in rules)
        if fallback: assert fallback[0] in rules
        else: assert not any(p.get('port')==8053 for r in rules for p in r.get('ports',[]))
        print(f'PASS runtime DNS fallback backend={backend} upgrade={upgrade}')
