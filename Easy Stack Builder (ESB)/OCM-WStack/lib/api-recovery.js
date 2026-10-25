'use strict';
const {setTimeout:pause}=require('node:timers/promises');
const {fail}=require('./config');

function transportFailure(error) {
  if(error?.code==='CANCELLED'||error?.code==='TIMEOUT')return false;
  const text=error.commandOutput||error.message||String(error);
  // An aggregated Helm error can contain both transport and permanent errors.
  // Do not classify a template's "unexpected EOF" as an API connection failure.
  if(/forbidden|unauthorized|invalid:|validation failed|immutable|exceeded quota|nil pointer|template:|parse error|another operation|pending-(install|upgrade|rollback)|x509:/i.test(text))return false;
  return /(?:Get|Post|Put|Patch|Delete|Head) "https?:\/\/[^"\n]+": [^\n]*(?:\bEOF\b|connection reset by peer|connection refused|TLS handshake timeout|i\/o timeout|http2: client connection lost)/i.test(text)
    || /unable to connect to the server: (?:EOF|unexpected EOF|.*connection reset by peer|.*TLS handshake timeout|.*i\/o timeout)/i.test(text)
    || /the server is currently unable to handle the request|too many requests|\bServiceUnavailable\b/.test(text);
}

async function delay(ms,signal) {
  try {await pause(ms,undefined,{signal});} catch(e) {if(signal?.aborted)fail('CANCELLED','Operation cancelled; resources are retained.');throw e;}
}
async function ready(r) {
  const response=await r.run('kubectl',['get','--raw=/readyz','--request-timeout=10s'],{timeout:12000,processGroup:false});
  if(response.stdout.trim()!=='ok')fail('API_UNREADY','The Kubernetes API readiness endpoint did not return ok.');
}
async function verifyLease(r) {
  const holder=r.env.ESB_LEASE_HOLDER;
  if(!holder)fail('LEASE_LOST','The deployment has no ESB lease identity; no Helm write was attempted.');
  const doc=await r.json('kubectl',['-n','kube-system','get','lease','esb-ocmwstack-v12','-o','json','--request-timeout=10s'],{timeout:12000,processGroup:false});
  const expires=Date.parse(doc?.spec?.renewTime||doc?.spec?.acquireTime)+(doc?.spec?.leaseDurationSeconds||180)*1000;
  if(doc?.spec?.holderIdentity!==holder||!Number.isFinite(expires)||expires<=Date.now()+15000)fail('LEASE_LOST','The ESB lease is missing, expired, near expiry or belongs to another owner; no Helm write was attempted.');
}
async function releaseStatus(r,namespace,release) {
  const result=await r.run('helm',['status',release,'-n',namespace,'-o','json'],{timeout:30000,allowFailure:true,processGroup:false});
  if(result.code!==0) {
    if(/release: not found/i.test(result.stderr))return 'absent';
    const e=new Error(`Cannot read Helm state for ${namespace}/${release}: ${r.redact(result.stderr).slice(-1800)}`);
    e.code='HELM_STATE_UNAVAILABLE';e.commandOutput=r.redact(result.stderr);throw e;
  }
  let status;
  try {status=JSON.parse(result.stdout)?.info?.status;} catch {fail('HELM_STATE_UNAVAILABLE',`Invalid Helm status response for ${namespace}/${release}.`);}
  if(status?.startsWith('pending-')||status==='uninstalling')fail('HELM_PENDING',`Helm release ${namespace}/${release} is ${status}. Inspect its history and confirm the previous operation has stopped. ESB will not delete release records or force-unlock it.`);
  if(!['deployed','failed','absent'].includes(status))fail('HELM_STATE_UNAVAILABLE',`Helm release ${namespace}/${release} has unexpected status ${status||'unknown'}; no automatic recovery was attempted.`);
  return status;
}

async function upgrade(r,args,{namespace,release,timeout,cwd,processGroup=true,attempts=3,sleep=delay}={}) {
  if(args[0]!=='upgrade'||!args.includes('--install'))fail('HELM_COMMAND','Recovery only supports Helm upgrade --install.');
  let last;
  // At most three total attempts. A retry always re-reads both lock and release.
  for(let attempt=1;attempt<=attempts;attempt++) {
    if(attempt>1) {
      const delayMs=attempt===2?5000:15000;
      r.emit({type:'retry',phase:release,attempt,attempts,delayMs,reason:'Kubernetes API transport failure; resources retained'});
      await sleep(delayMs,r.signal);
    }
    try {
      await ready(r);
      const status=await releaseStatus(r,namespace,release);
      // Recheck immediately before mutation, after potentially slow API/status reads.
      await verifyLease(r);
      r.emit({type:'helm-state',namespace,release,status,attempt});
      const result=await r.run('helm',args,{timeout,cwd,live:true,processGroup});
      // Helm can exit successfully even when its final status write failed.
      const final=await releaseStatus(r,namespace,release);
      if(final!=='deployed')fail('HELM_STATE_UNAVAILABLE',`Helm exited successfully, but ${namespace}/${release} is ${final}; deployment is not confirmed.`);
      return result;
    } catch(e) {
      last=e;
      if(r.signal?.aborted||!transportFailure(e))throw e;
    }
  }
  fail('API_TRANSPORT',`Kubernetes API transport failed after ${attempts} attempts for ${namespace}/${release}. Resources and Helm history were retained. Last error: ${r.redact(last.message).slice(-1600)}`);
}

async function diagnose(r,{samples=5,sleep=delay}={}) {
  const checks=[];
  for(let i=0;i<samples;i++) {
    const started=Date.now();
    try {await ready(r);checks.push({at:new Date(started).toISOString(),ok:true,elapsedMs:Date.now()-started});}
    catch(e) {if(r.signal?.aborted)throw e;checks.push({at:new Date(started).toISOString(),ok:false,elapsedMs:Date.now()-started,message:r.redact(e.message).slice(-1200)});}
    if(i+1<samples)await sleep(2000,r.signal);
  }
  return {status:checks.every(x=>x.ok)?'api-reachable':'api-unreliable',checks,
    detail:'Probes use the uploaded kubeconfig from the ORCE process. Readiness does not prove sustained write connectivity.'};
}
module.exports={transportFailure,delay,ready,verifyLease,releaseStatus,upgrade,diagnose};
