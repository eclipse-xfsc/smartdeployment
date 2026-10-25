'use strict';
// Explicitly creates a demo offer. --accept in the outer runner also redeems it.
const c=require('/data/lib/config.cjs').load(),{Client}=require('/data/lib/http.cjs'),{Adapters}=require('/data/lib/adapters.cjs'),{Events}=require('/data/lib/events.cjs'),{IssuerBootstrap}=require('/data/lib/issuer-bootstrap.cjs'),{offerUrl}=require('/data/lib/offers.cjs'),{randomUUID}=require('node:crypto');
const http=new Client({...c.services,issuerBootstrap:c.issuerBootstrapUrl||'http://dummycontentsigner:8080'}),bootstrap=new IssuerBootstrap(c,http),events=new Events(c,bootstrap),a=new Adapters(c,http);
const ctx={tenant:c.tenant,account:c.account,group:c.group,subject:'operator-smoke-test',token:''};
const report={checkedAt:new Date().toISOString(),version:require('/data/package.json').version,mode:process.env.OCM_SMOKE_ACCEPT==='1'?'issue-import-accept':'issue-import',steps:[]};
let step='bootstrap';const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 try{
  await events.start();if(!events.connected)throw Object.assign(Error(),{code:'NATS_UNAVAILABLE'});
  for(let i=0;i<20;i++){try{await bootstrap.ensure();break;}catch(e){if(e.code!=='ISSUER_INITIALIZING'||i===19)throw e;await delay(2000);}}
  report.steps.push({step,ok:true});step='issue';const requestId=randomUUID();
  const issued=await events.issue(ctx,{credentialConfigurationId:'SDJWTCredential',claims:{given_name:'ESB',family_name:'RetrievalSmoke'}},requestId);
  report.steps.push({step,ok:true,requestId});step='import';const imported=await a.importOffer(ctx,offerUrl(issued.offer));
  report.steps.push({step,ok:true,requestId:imported.upstreamRequestId});step='list';
  const listed=await a.offers(ctx);if(!listed.items.some(x=>x.requestId===imported.upstreamRequestId))throw Object.assign(Error(),{code:'OFFER_NOT_LISTED'});
  report.steps.push({step,ok:true,pendingCount:listed.items.length});
  if(process.env.OCM_SMOKE_ACCEPT==='1'){
   step='accept';await a.accept(ctx,imported.upstreamRequestId,true,{});report.steps.push({step,ok:true,meaning:'retrieval response only; persistence unconfirmed'});
  }
  step='storage-read';const stored=await a.list(ctx);report.steps.push({step,ok:true,credentialCount:stored.total,meaning:'readability only; correlate the new credential in the UI'});
 }catch(e){report.steps.push({step,ok:false,code:e.code||'CHECK_FAILED',httpStatus:e.upstreamStatus||null,reason:e.reason||null});process.exitCode=step==='storage-read'?2:1;}
 finally{bootstrap.close();await events.close();report.status=process.exitCode===2?'retrieval-passed-storage-blocked':process.exitCode?'failed':'passed';console.log(JSON.stringify(report,null,2));}
})().catch(()=>{console.error('Smoke runner failed');process.exitCode=1;});
