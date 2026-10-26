#!/usr/bin/env python3
"""Render the complete ESB plan using an offline deployment chart collection."""
import argparse, concurrent.futures, copy, json, pathlib, shutil, subprocess, tarfile
import yaml

yaml.SafeLoader.add_constructor('tag:yaml.org,2002:value',lambda loader,node:loader.construct_scalar(node))
root=pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--charts',type=pathlib.Path,required=True,help='Deployment source with downloaded charts/')
parser.add_argument('--output',type=pathlib.Path,required=True)
args=parser.parse_args();source=args.charts.resolve();output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
helm=shutil.which('helm')
if not helm:raise SystemExit('Helm is required.')
def jq(program,value,**variables):
 command=['jq','-L',str(root/'deployment')]
 for k,v in variables.items():command+=['--argjson',k,json.dumps(v)]
 p=subprocess.run(command+['include "filters"; '+program],input=json.dumps(value),text=True,capture_output=True,check=True)
 return json.loads(p.stdout)
checks={'OCM W-Stack/Policy Chart','OCM W-Stack/Credential Verification Service Chart','OCM W-Stack/Didcomm','OCM W-Stack/Pre Authorization Bridge Chart','OCM W-Stack/Well Known Chart','INFRA/core/nats','INFRA/core/universal-resolver','INFRA/observability/opentelemtry'}
apis=['monitoring.coreos.com/v1','monitoring.coreos.com/v1/ServiceMonitor','monitoring.coreos.com/v1/PrometheusRule','external-secrets.io/v1','argoproj.io/v1alpha1','gateway.networking.k8s.io/v1','gateway.networking.k8s.io/v1/Gateway','cert-manager.io/v1','resources.xfsc.io/v1alpha1']
def render(task):
 scenario,index,job,upgrade=task;work=output/scenario;stem=f'{index:02}-'+('upgrade' if upgrade else 'install');values=work/(stem+'-values.json');values.write_text(json.dumps(job['values']))
 chart=pathlib.Path(job['root'])/job['chart'];metadata=yaml.safe_load((chart/'Chart.yaml').read_text())
 # Check packaged versions before Helm can silently omit a mismatched alias.
 for dependency in (metadata.get('dependencies') or []):
  candidates=list((chart/'charts').glob(dependency['name']+'-*.tgz'))
  if dependency['version'] not in ('*','') and not any(p.name==dependency['name']+'-'+dependency['version']+'.tgz' for p in candidates):
   raise AssertionError(f'{job["chart"]}: missing pinned dependency {dependency["name"]}:{dependency["version"]}')
 command=[helm,'template',job['release'],str(chart),'-n',job['namespace'],'--kube-version','1.34.0','--include-crds']
 for api in apis:command+=['--api-versions',api]
 for f in job['files']:command+=['-f',job['root']+'/'+f]
 command+=['-f',str(values)]
 for param in job['parameters']:command+=['--set-string',param]
 if upgrade:command+=['--is-upgrade']
 result=subprocess.run(command,capture_output=True,text=True,timeout=120)
 (work/(stem+'.log')).write_text(result.stderr);(work/(stem+'.yaml')).write_text(result.stdout)
 assert result.returncode==0, f'{scenario}/{job["chart"]}: {result.stderr}'
 assert 'cannot overwrite table with non table' not in result.stderr and 'destination for' not in result.stderr,result.stderr
 docs=[d for d in yaml.safe_load_all(result.stdout) if d]
 for d in docs:
  if d['kind'] in ('Deployment','StatefulSet','DaemonSet','ResourceProvider','ResourceClaim','ExternalSecret'):d.setdefault('metadata',{}).setdefault('namespace',job['namespace'])
 if job['chart'] in checks:assert jq('validate_chart($chart)',docs,chart=job['chart']) is True,f'{scenario}/{job["chart"]}: contract'
 if job['chart']=='INFRA/observability/opentelemtry':
  datasources=[]
  for d in docs:
   if d['kind']=='ConfigMap' and d.get('metadata',{}).get('labels',{}).get('grafana_datasource')=='1':
    datasources.extend(yaml.safe_load(v) for k,v in d.get('data',{}).items() if k.endswith(('.yaml','.yml')))
  assert jq('validate_datasources',datasources) is True
 for d in docs:
  pod=d.get('spec',{}).get('template',{}).get('spec',{})
  for c in (pod.get('containers') or [])+(pod.get('initContainers') or []):
   env=(c.get('env') or []);names=[e['name'] for e in env];assert len(names)==len(set(names)),f'duplicate env: {d["metadata"]["name"]}/{c["name"]}'
   assert all(not ('value' in e and 'valueFrom' in e) for e in env)
   if job['chart'].startswith('OCM W-Stack/'):
    assert not any('NAMESPACE' in str(e.get('value','')) or '@TENANT_ID@' in str(e.get('value','')) for e in env)
 return {'scenario':scenario,'chart':job['chart'],'release':job['release'],'upgrade':upgrade,'passed':True},docs
all_results=[];tasks=[]
for scenario in ['ionos','hetzner','digitalocean','generic']:
 work=output/scenario
 subprocess.run(['node',str(root/'test/chart-plan.cjs'),str(source),str(work),scenario],check=True)
 for i,job in enumerate(json.loads((work/'jobs.json').read_text())):
  for upgrade in [False,True]:tasks.append((scenario,i,job,upgrade))
combined={};failures=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
 for task,future in zip(tasks,[executor.submit(render,t) for t in tasks]):
  try:
   result,docs=future.result();all_results.append(result);combined.setdefault((task[0],task[3]),[]).extend(docs)
   print('PASS',result['scenario'],result['chart'],'upgrade' if result['upgrade'] else 'install',flush=True)
  except Exception as error:failures.append(str(error));print('FAIL',str(error),flush=True)
credential_results=[]
for key,docs in combined.items():
 errors=jq('provider_contract_errors',docs)
 if errors:failures.append(f'{key}: provider references: {errors}')
 # Replay the initial ESO deletion and subsequent claim provisioning with the
 # actual rendered consumer, claim and ExternalSecret bindings for every plan.
 try:
  native=[d for d in docs if d.get('metadata',{}).get('namespace')=='ocm-wstack']
  planned=[d for d in native if d['kind'] in ('ResourceClaim','ExternalSecret')]
  deployments=[d for d in native if d['kind']=='Deployment']
  claims=copy.deepcopy([d for d in native if d['kind']=='ResourceClaim'])
  external=copy.deepcopy([d for d in native if d['kind']=='ExternalSecret'])
  assert len(claims)==6,f'{key}: expected six native credential claims'
  names={c['spec']['externalSecretRef']['name'] for c in claims}
  external=[e for e in external if e['metadata']['name'] in names]
  assert len(external)==len(claims),f'{key}: claim/ESO binding missing'
  for c in claims:
   c['metadata']['generation']=1
   c['status']={'observedGeneration':1,'conditions':[{'type':'Ready','status':'False','reason':'ClaimSecretPending','observedGeneration':1}]}
  for e in external:
   e['metadata'].update(uid='fixture-'+e['metadata']['name'],resourceVersion='1')
   e['status']={'conditions':[{'type':'Ready','status':'True','reason':'SecretDeleted'}]}
  status=jq('native_credential_status($claims;$external;$secrets)',deployments,claims=claims,external=external,secrets=[])
  targets=jq('credential_refresh_targets($pending;$claims;$planned)',external,pending=status,claims=claims,planned=planned)
  assert {e['metadata']['name'] for e in targets}==names,f'{key}: pending targets were not selected'
  secrets={}
  for ref in jq('[.[] | secret_references[] | select(.optional!=true)]',deployments):
   secret=secrets.setdefault(ref['name'],{'metadata':{'name':ref['name']},'data':{}})
   secret['data'][ref.get('key') or 'fixture']='dGVzdA=='
  for e in external:e['status']['conditions'][0]['reason']='SecretSynced'
  for c in claims:c['status']['conditions'][0].update(status='True',reason='Provisioned')
  status=jq('native_credential_status($claims;$external;$secrets)',deployments,claims=claims,external=external,secrets=list(secrets.values()))
  assert status['ready'],f'{key}: provisioned consumer references did not become ready'
  assert jq('credential_refresh_targets($pending;$claims;$planned)',external,pending=status,claims=claims,planned=planned)==[]
  credential_results.append({'scenario':key[0],'upgrade':key[1],'claims':len(claims),'passed':True})
 except Exception as error:failures.append(str(error))
report={'helm':subprocess.check_output([helm,'version','--short'],text=True).strip(),'renderScenarios':len(tasks),'passed':len(all_results),'results':all_results,'credentialScenarios':credential_results,'failures':failures}
(output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='results'},indent=2))
raise SystemExit(bool(failures))
