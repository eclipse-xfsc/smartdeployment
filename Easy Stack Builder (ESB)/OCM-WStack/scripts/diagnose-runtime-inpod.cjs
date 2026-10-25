'use strict';
const c=require('/data/lib/config.cjs').load(),{request}=require('/data/lib/http.cjs');
const id=encodeURIComponent;
const checks=[['storage',c.services.storage+'/v1/tenants/'+id(c.tenant)+'/storage/'+id(c.account)+'/credentials',{method:'POST',body:{id:'ocm-ui-all',input_descriptors:[{id:'all',constraints:{fields:[]}}]}}],['retrieval',c.services.retrieval+'/v1/tenants/'+id(c.tenant)+'/offering/list/'+id(c.group)],['didcomm',c.services.didcomm+'/admin/connections?group='+id(c.group)],['issuerTenant',(c.issuerBootstrapUrl||'http://dummycontentsigner:8080')+'/internal/tenants/'+id(c.tenant)]];
(async()=>{
 const report={version:require('/data/package.json').version,checks:[]};
 for(const [name,url,options]of checks){try{await request(url,options);report.checks.push({name,ok:true});}catch(e){report.checks.push({name,ok:false,code:e.code,httpStatus:e.upstreamStatus||null,reason:e.reason||null});}}
 try{const roles=new (require('/data/lib/roles.cjs').Roles)(c,null);await roles.list();report.checks.push({name:'iam',ok:true});}catch(e){report.checks.push({name:'iam',ok:false,code:e.code,httpStatus:e.upstreamStatus||null});}
 // Only response metadata is printed: no credentials, tokens, offers, or claims.
 console.log(JSON.stringify(report,null,2));
 if(process.env.OCM_DIAGNOSTICS_STRICT==='1'&&report.checks.some(x=>!x.ok)){
  for(const x of report.checks.filter(x=>!x.ok))console.error('OCM dependency check failed: '+x.name+' HTTP '+(x.httpStatus||'unavailable')+' '+(x.reason||x.code||'UNKNOWN'));
  console.error('Pods may be Ready while native API reads fail. Run scripts/diagnose-runtime.cjs and inspect the running service image report.');
  process.exitCode=1;
 }
})().catch(()=>{console.error('Diagnostic execution failed');process.exitCode=1;});
