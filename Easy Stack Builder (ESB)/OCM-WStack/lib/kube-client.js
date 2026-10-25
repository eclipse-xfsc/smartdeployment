'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {fail}=require('./config');
const OVERRIDES={
  kubectl:['--kubeconfig','--context','--user','--cluster','--server','--token','--as','--as-group','--as-uid','--client-certificate','--client-key','-s'],
  helm:['--kubeconfig','--kube-context','--kube-token','--kube-apiserver','--kube-as-user','--kube-as-group','--kube-ca-file']
};
function boundCommand(command,args,env) {
  if(!Object.hasOwn(OVERRIDES,command))return {command,args};
  const binding=['ESB_KUBECONFIG','ESB_KUBE_CONTEXT','ESB_REAL_KUBECTL','ESB_REAL_HELM'];
  if(![...binding,'ESB_KUBE_USERNAME'].some(key=>Object.hasOwn(env,key)))return {command,args};
  if(!binding.every(key=>typeof env[key]==='string'&&env[key])||!path.isAbsolute(env.ESB_KUBECONFIG)||!path.isAbsolute(env.ESB_REAL_KUBECTL)||!path.isAbsolute(env.ESB_REAL_HELM))fail('KUBECONFIG_BINDING','Incomplete uploaded kubeconfig binding; refusing ambient Kubernetes credentials.');
  if(args.some(arg=>OVERRIDES[command].some(flag=>arg===flag||arg.startsWith(flag+'=')||(flag==='-s'&&arg.startsWith('-s')&&!arg.startsWith('--')))))fail('KUBECONFIG_OVERRIDE','ESB commands cannot override uploaded Kubernetes credentials or context.');
  const contextFlag=command==='kubectl'?'--context':'--kube-context';
  return {command:env[command==='kubectl'?'ESB_REAL_KUBECTL':'ESB_REAL_HELM'],args:['--kubeconfig',env.ESB_KUBECONFIG,contextFlag,env.ESB_KUBE_CONTEXT,...args]};
}
function cleanEnvironment(env) {
  const clean={...env};
  for(const key of Object.keys(clean))if(key.startsWith('HELM_KUBE')||key.startsWith('ESB_KUBE')||['ESB_REAL_KUBECTL','ESB_REAL_HELM'].includes(key))delete clean[key];
  return clean;
}
function selection(config) {
  const context=config.contexts?.find(x=>x.name===config['current-context']);
  if(!context?.context?.user||!context.context.cluster)fail('KUBECONFIG_CONTEXT','Uploaded kubeconfig has no usable current context. Select the intended admin context in that file and upload it again.');
  const user=config.users?.find(x=>x.name===context.context.user)?.user;
  const cluster=config.clusters?.find(x=>x.name===context.context.cluster)?.cluster;
  if(!user||!cluster?.server)fail('KUBECONFIG_CONTEXT','The selected uploaded context must reference a configured user and cluster.');
  if(user.tokenFile||user['client-certificate']||user['client-key']||cluster['certificate-authority'])fail('KUBECONFIG_FILES','Use a self-contained uploaded kubeconfig with embedded tokens/certificates. File references from your workstation cannot be used in ORCE.');
  const certificate=user['client-certificate-data']&&user['client-key-data'];
  const token=typeof user.token==='string'&&user.token.length>0;
  const exec=user.exec?.command;
  const provider=user['auth-provider']?.name;
  if(!certificate&&!token&&!exec&&!provider)fail('KUBECONFIG_AUTH','Selected uploaded context has no explicit credentials or auth plugin. Deployment stopped before API access; in-cluster credentials are not used.');
  return {context:context.name,user:context.context.user,cluster:context.context.cluster,server:cluster.server,authentication:certificate?'client-certificate':token?'token':exec?'exec-plugin':'auth-provider'};
}
async function bind(r,directory,kubeconfig,bytes) {
  r.env=cleanEnvironment(r.env);r.env.KUBECONFIG=kubeconfig;
  const executables={};
  for(const command of ['kubectl','helm']) {
    const result=await r.run('bash',['-c','command -v "$1"','esb-executable',command]);
    const executable=result.stdout.trim();
    if(!path.isAbsolute(executable))fail('KUBE_EXECUTABLE',`Cannot resolve an executable path for ${command}.`);
    executables[command]=executable;
  }
  // Client-side config inspection only; no credentials are printed or emitted.
  const config=await r.json(executables.kubectl,['--kubeconfig',kubeconfig,'config','view','--minify','-o','json']);
  const selected=selection(config);
  const bin=path.join(directory,'kube-bin');await fs.mkdir(bin,{mode:0o700});
  for(const command of ['kubectl','helm']) {
    const contextFlag=command==='kubectl'?'--context':'--kube-context';
    const variable=command==='kubectl'?'ESB_REAL_KUBECTL':'ESB_REAL_HELM';
    const flags=OVERRIDES[command].flatMap(x=>[x,x+'=*',...(x==='-s'?['-s?*']:[])]).join('|');
    const wrapper=`#!/usr/bin/env bash\nset -euo pipefail\n: "\${ESB_KUBECONFIG:?Uploaded kubeconfig is required}" "\${ESB_KUBE_CONTEXT:?Uploaded context is required}"\n[[ -r "$ESB_KUBECONFIG" ]] || { echo "Uploaded kubeconfig is unavailable; refusing ambient credentials." >&2; exit 1; }\nfor arg in "$@"; do\n  case "$arg" in\n    ${flags}) echo "ESB commands cannot override uploaded Kubernetes credentials or context." >&2; exit 1 ;;\n  esac\ndone\nexec "$${variable}" --kubeconfig "$ESB_KUBECONFIG" ${contextFlag} "$ESB_KUBE_CONTEXT" "$@"\n`;
    await fs.writeFile(path.join(bin,command),wrapper,{mode:0o700});
  }
  r.env={...r.env,PATH:bin+':'+r.env.PATH,ESB_KUBECONFIG:kubeconfig,ESB_KUBE_CONTEXT:selected.context,ESB_REAL_KUBECTL:executables.kubectl,ESB_REAL_HELM:executables.helm};
  const report={source:'editor-upload',...selected,kubeconfigSha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  r.emit({type:'kubeconfig-selection',...report});return report;
}
async function identity(r,{timeout=15000}={}) {
  const doc=await r.json('kubectl',['auth','whoami','-o','json'],{timeout});
  const info=doc.status?.userInfo;
  if(!info?.username)fail('KUBE_IDENTITY','API did not return the authenticated user identity.');
  const report={username:info.username,groups:info.groups||[]};r.emit({type:'kubeconfig-identity',...report});return report;
}
module.exports={cleanEnvironment,selection,bind,identity,boundCommand};
