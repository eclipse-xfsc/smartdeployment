'use strict';
const lock=require('../upstream-lock.json');
const repository='https://kubernetes-sigs.github.io/external-dns/';
function values(c){
 const provider=c.actualDns;
 const settings={sources:['gateway-httproute'],logLevel:'info',policy:'sync',registry:'txt',enableGatewayListenerSets:true,domainFilters:[c.domain],txtOwnerId:c.dnsOwnerId||('esb-'+(c.clusterUid||c.instanceName||'ocm-wstack')),extraArgs:['--txt-prefix=reg-%{record_type}.','--managed-record-types=A','--managed-record-types=AAAA','--managed-record-types=CNAME']};
 if(provider==='custom')return {...settings,...c.dnsValues};
 settings.provider={name:'webhook',webhook:{image:{repository:provider==='ionos'?'ghcr.io/ionos-cloud/external-dns-ionos-webhook':'docker.io/hetzner/external-dns-hetzner-webhook',tag:lock.dnsWebhookPins[provider]},env:[{name:provider==='ionos'?'IONOS_API_KEY':'HETZNER_TOKEN',valueFrom:{secretKeyRef:{name:'external-dns',key:'token'}}},...(provider==='ionos'?[{name:'DRY_RUN',value:'false'},{name:'LOG_LEVEL',value:'info'}]:[])]}};
 return settings;
}
async function permitRepository(r,c){
 if(!c.externalDns)return;
 const project=await r.json('kubectl',['-n','argocd','get','appproject','infrastructure','--ignore-not-found','-o','json']);
 if(!project)return;const repos=project.spec?.sourceRepos||[];
 if(repos.includes(repository)||repos.includes('*'))return;
 const owner=project.metadata?.annotations?.['meta.helm.sh/release-name'];
 if(!['storage','network','core'].includes(owner))require('./config').fail('OWNERSHIP','The infrastructure AppProject is not owned by an expected bootstrap Helm release.');
 await r.run('kubectl',['-n','argocd','patch','appproject','infrastructure','--type=json','-p',JSON.stringify([{op:'test',path:'/metadata/resourceVersion',value:project.metadata.resourceVersion},{op:'add',path:'/spec/sourceRepos',value:[...repos,repository]}])]);
}
module.exports={values,repository,permitRepository};
