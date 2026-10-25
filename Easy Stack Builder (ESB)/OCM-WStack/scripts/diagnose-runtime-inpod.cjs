'use strict';
const c=require('/data/lib/config.cjs').load(),{request}=require('/data/lib/http.cjs');
const id=encodeURIComponent;
const checks=[['storage',c.services.storage+'/v1/tenants/'+id(c.tenant)+'/storage/'+id(c.account)+'/credentials',{method:'POST',body:{}}],['retrieval',c.services.retrieval+'/v1/tenants/'+id(c.tenant)+'/offering/list/'+id(c.group)],['didcomm',c.services.didcomm+'/admin/connections?group='+id(c.group)],['issuerTenant',(c.issuerBootstrapUrl||'http://dummycontentsigner:8080')+'/internal/tenants/'+id(c.tenant)]];
(async()=>{
 const report={version:require('/data/package.json').version,checks:[]};
 if(process.env.OCM_DIAGNOSTICS_EVIDENCE==='1')checks.push(['storageWithGeographyHeaders',checks[0][1],{method:'POST',body:{},headers:{'x-region':'eu','x-country':'de',region:'eu',country:'de'}}]);
 for(const [name,url,options]of checks){try{await request(url,options);report.checks.push({name,ok:true});}catch(e){report.checks.push({name,ok:false,code:e.code,httpStatus:e.upstreamStatus||null,reason:e.reason||null});}}
 try{const roles=new (require('/data/lib/roles.cjs').Roles)(c,null);await roles.list();report.checks.push({name:'iam',ok:true});}catch(e){report.checks.push({name:'iam',ok:false,code:e.code,httpStatus:e.upstreamStatus||null});}
 // Only response metadata is printed: no credentials, tokens, offers, or claims.
 report.checkedAt=new Date().toISOString();
 const failed=report.checks.filter(x=>!x.ok);
 report.status=failed.length?'degraded':'ready';
 console.log(JSON.stringify(report,null,2));
 if(process.env.OCM_ALLOW_STORAGE_BLOCKER==='1'&&failed.length){
  // Exactly this known API defect is tolerated. Outages and other failures are not.
  const known=failed.every(x=>x.name==='storage'&&x.httpStatus===400&&['STORAGE_REGION_MISSING','STORAGE_COUNTRY_MISSING'].includes(x.reason));
  process.exitCode=known?2:1;
 }

 if(process.env.OCM_DIAGNOSTICS_STRICT==='1'&&report.checks.some(x=>!x.ok)){
  for(const x of report.checks.filter(x=>!x.ok))console.error('OCM dependency check failed: '+x.name+' HTTP '+(x.httpStatus||'unavailable')+' '+(x.reason||x.code||'UNKNOWN'));
  console.error('Pods may be Ready while native API reads fail. Run scripts/diagnose-runtime.cjs and inspect the running service image report.');
  process.exitCode=1;
 }
})().catch(()=>{console.error('Diagnostic execution failed');process.exitCode=1;});
