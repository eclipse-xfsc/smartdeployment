#!/usr/bin/env python3
"""Real Helm rendering for compatibility charts and the two-stage null path."""
import json, pathlib, shutil, subprocess, tempfile
import yaml
root=pathlib.Path(__file__).resolve().parents[1]
helm=shutil.which('helm')
if not helm:
    raise SystemExit('Helm 3 is required; these rendering checks were not executed.')
def render(chart,values,upgrade=False):
    with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
        json.dump(values,f); f.flush()
        args=[helm,'template','demotenant',str(chart),'-n','ocm-wstack','-f',f.name]
        if upgrade: args+=['--is-upgrade']
        return [d for d in yaml.safe_load_all(subprocess.check_output(args,text=True)) if d]
base={'host':'demo-tenant.example.com','listenerSetName':'demotenant-xfsc-tenant-gateway','storage':{'class':'ionos-cloud-essential'},'gatewayPorts':[80,443,10080,10443],'hostAliases':[{'ip':'100.64.9.12','hostnames':['demo-tenant.example.com']}],'runtimeConfig':{'publicOrigin':'https://demo-tenant.example.com','issuer':'https://demo-tenant.example.com/orce/identity/realms/ocm-ui-demo-tenant'}}
checks=0
for upgrade in [False,True]:
    for external in [False,True]:
        docs=render(root/'charts-runtime',{**base,'mongo':{'embedded':not external,'externalPorts':[27017]}},upgrade)
        route=next(d for d in docs if d['kind']=='HTTPRoute')
        assert [r['matches'][0]['path']['value'] for r in route['spec']['rules']]==['/orce/identity','/orce','/']
        assert route['spec']['parentRefs'][0]['kind']=='ListenerSet'
        runtime=next(d for d in docs if d['kind']=='Deployment' and d['metadata']['name']=='ocm-orce')
        assert runtime['spec']['template']['spec']['hostAliases']==base['hostAliases']
        policy=next(d for d in docs if d['kind']=='NetworkPolicy' and d['metadata']['name']=='ocm-orce')
        assert {80,443,10080,10443}.issubset({p['port'] for p in policy['spec']['egress'][0]['ports']})
        assert not any(d['kind']=='Ingress' for d in docs)
        pvcs=[d for d in docs if d['kind']=='PersistentVolumeClaim']
        assert len(pvcs)==(2 if external else 3)
        assert all(d['metadata']['annotations']['helm.sh/resource-policy']=='keep' for d in pvcs)
        assert not any(d['kind']=='Secret' for d in docs)
        for deployment in [d for d in docs if d['kind']=='Deployment']:
            assert deployment['spec']['template']['spec']['automountServiceAccountToken'] is False
        checks+=1
    for policy in ['Cluster','Local']:
        docs=render(root/'charts-gateway',{'externalTrafficPolicy':policy},upgrade)
        resource=docs[0]
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
        code="const {networkValues}=require('./lib/adapt');console.log(JSON.stringify(networkValues("+json.dumps(c)+")));"
        settings=json.loads(subprocess.check_output(['node','-e',code],cwd=root,text=True))
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
print(f'{checks} real Helm render scenarios passed (upstream Envoy wrapper only; no downloaded subchart dependencies).')
