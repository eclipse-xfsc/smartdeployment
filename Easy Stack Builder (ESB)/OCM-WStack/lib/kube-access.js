'use strict';
const {fail}=require('./config');
const {identity}=require('./kube-client');

const ARGO_ACCESS=[
  {group:'argoproj.io',resource:'applications',verb:'get',namespace:'argocd'},
  {group:'argoproj.io',resource:'applications',verb:'list',namespace:'argocd'},
  {group:'argoproj.io',resource:'applicationsets',verb:'*',namespace:'argocd'},
  {group:'argoproj.io',resource:'appprojects',verb:'*',namespace:'argocd'}
];

// Submit exact authorization attributes without RESTMapper/discovery. This also
// works before Argo's CRDs or namespace exist; reviews do not persist resources.
async function review(r,attributes,{phase='preflight',username=r.env?.ESB_KUBE_USERNAME}={}) {
  const request={apiVersion:'authorization.k8s.io/v1',kind:'SelfSubjectAccessReview',spec:{resourceAttributes:attributes}};
  const result=await r.json('kubectl',['create','--raw=/apis/authorization.k8s.io/v1/selfsubjectaccessreviews','-f','-','--request-timeout=15s'],{input:JSON.stringify(request),timeout:20000,processGroup:false});
  if(typeof result?.status?.allowed!=='boolean')fail('RBAC_RESPONSE','Kubernetes returned no authorization decision; deployment access cannot be confirmed.');
  const allowed=result.status.allowed&&!result.status.denied;
  r.emit({type:'kube-access',phase,username,attributes,allowed});
  if(!allowed) {
    const target=attributes.resource+(attributes.group?'.'+attributes.group:'');
    const scope=attributes.namespace?' in namespace '+attributes.namespace:' across the cluster';
    fail('RBAC',`Uploaded kubeconfig identity ${username||'(see kubeconfig-identity)'} cannot ${attributes.verb} ${target}${scope}. ${phase==='preflight'?'No installation was started.':'Installed resources are retained.'} Upload a kubeconfig with actual cluster-admin permissions. ESB does not switch to the ORCE service account or grant itself permissions.`);
  }
}

async function preflight(r) {
  await review(r,{group:'*',resource:'*',verb:'*'});
  for(const attributes of ARGO_ACCESS)await review(r,attributes);
}

async function argo(r,{phase='argo-access'}={}) {
  const expected=r.env?.ESB_KUBE_USERNAME;
  if(!expected)fail('KUBE_IDENTITY','The bootstrap is missing its expected uploaded-kubeconfig identity.');
  const actual=await identity(r);
  if(actual.username!==expected)fail('KUBE_IDENTITY_CHANGED',`Bootstrap authenticated as ${actual.username}, but the uploaded kubeconfig authenticated as ${expected}. Resources are retained; refusing to continue with a different identity.`);
  for(const attributes of ARGO_ACCESS)await review(r,attributes,{phase,username:actual.username});
}

module.exports={review,preflight,argo,ARGO_ACCESS};
