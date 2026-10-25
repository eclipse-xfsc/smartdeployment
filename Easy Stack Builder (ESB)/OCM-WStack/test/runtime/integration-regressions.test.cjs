'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {Client}=require('../../runtime/lib/http.cjs');
const {IssuerBootstrap}=require('../../runtime/lib/issuer-bootstrap.cjs');
const {Events}=require('../../runtime/lib/events.cjs');
test('upstream 400 retains status/reason without tripping outage circuit or leaking body',async t=>{
 let status=400;const server=http.createServer((req,res)=>{res.writeHead(status);res.end(JSON.stringify(status===200?{ok:true}:{message:'Region Id Missing.',token:'do-not-leak'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const c=new Client({storage:'http://127.0.0.1:'+server.address().port});
 for(let i=0;i<4;i++)await assert.rejects(c.call('storage','/credentials'),e=>e.upstream==='storage'&&e.upstreamStatus===400&&e.reason==='STORAGE_REGION_MISSING'&&!JSON.stringify(e).includes('do-not-leak'));
 assert.equal(c.health()[0].circuit,'closed');assert.equal(c.health()[0].lastUpstreamStatus,400);
 status=200;await c.call('storage','/credentials');assert.equal(c.health()[0].lastErrorCode,null);assert.equal(c.health()[0].lastUpstreamStatus,null);
});
test('three upstream server failures open the circuit',async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(503);res.end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const c=new Client({retrieval:'http://127.0.0.1:'+server.address().port});for(let i=0;i<3;i++)await assert.rejects(c.call('retrieval','/list'));await assert.rejects(c.call('retrieval','/list'),{code:'UPSTREAM_CIRCUIT_OPEN'});
});
test('missing issuer tenant is registered once, waits for metadata, and recovers after restart',async()=>{
 let tenant=null,writes=0;
 const b=new IssuerBootstrap({tenant:'tenant_space',publicOrigin:'https://cloud-ocm.example'},{call:async(name,p,opt)=>{assert.equal(p,'/internal/tenants/tenant_space');if(opt?.method==='PUT'){writes++;tenant=opt.body;return tenant;}if(!tenant)throw Object.assign(Error(),{upstreamStatus:404});return tenant;}});
 await assert.rejects(b.ensure(),{code:'ISSUER_INITIALIZING'});assert.equal(writes,1);
 await assert.rejects(b.ensure(),{code:'ISSUER_INITIALIZING'});assert.equal(writes,1);
 b.readyAfter=0;await b.ensure();assert.equal(b.state,'registered');tenant=null;await assert.rejects(b.ensure(),{code:'ISSUER_INITIALIZING'});assert.equal(writes,2);
});
test('issuer tenant configuration conflict cannot overwrite operator configuration',async()=>{
 const b=new IssuerBootstrap({tenant:'tenant_space',publicOrigin:'https://expected.example'},{call:async(n,p,opt)=>{assert.equal(opt,undefined);return {credentialIssuer:'https://other.example'};}});
 await assert.rejects(b.ensure(),{code:'ISSUER_TENANT_CONFIGURATION_CONFLICT'});
});
test('issuer preflight failure prevents NATS dispatch; correlated reply succeeds',async()=>{
 const cfg={credentialTypes:[{id:'Demo',identifier:'Demo',subject:'issuer.dummycontentsigner.request',fields:{name:{required:true}}}]};
 const b={ensure:async()=>{throw Object.assign(Error(),{status:503,code:'ISSUER_INITIALIZING'});}},e=new Events(cfg,b);e.connected=true;e.nc={request:()=>assert.fail('must not dispatch')};
 const c={tenant:'tenant_space',group:'ocm-wstack'},body={credentialConfigurationId:'Demo',claims:{name:'Ada'}};
 await assert.rejects(e.issue(c,body,'id-1'),{code:'ISSUER_INITIALIZING'});b.ensure=async()=>{};
 e.nc.request=async(subject,data)=>{const event=JSON.parse(data);assert.equal(subject,cfg.credentialTypes[0].subject);assert.equal(event.data.tenant_id,c.tenant);return {data:Buffer.from(JSON.stringify({specversion:'1.0',data:{request_id:'id-1',tenant_id:c.tenant,group_id:c.group,offer:{credential_offer:{credential_issuer:'https://example.org'}}}}))};};
 assert.equal((await e.issue(c,body,'id-1')).state,'succeeded');
});
test('failed first credential load still starts socket and both refresh timers; no false empty result',async()=>{
 let mount,render,state,connected=0;const intervals=[];
 const source=fs.readFileSync(path.join(__dirname,'../../runtime/uibuilder/orce/dist/app.js'),'utf8').replace(/^import .*;\n/gm,'');
 const sandbox={createApp:app=>({mount:()=>{render=app.setup();}}),h:(...args)=>args,reactive:x=>(state=x),onMounted:fn=>{mount=fn;},onUnmounted:()=>{},locales:{en:{}},auth:{headers:()=>({'X-CSRF-Token':'csrf-fixture'}),csrfToken:()=> 'csrf-fixture',setup:async()=>true,token:async()=>'test'},window:{io:()=>{connected++;return {on(){},disconnect(){}};}},crypto:require('node:crypto').webcrypto,AbortController,URLSearchParams,document:{documentElement:{},hidden:false},setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval:()=>{},fetch:async url=>({ok:!url.includes('/credentials?'),status:url.includes('/credentials?')?502:200,json:async()=>url.endsWith('/auth/me')?{data:{permissions:['credentials.read']}}:url.endsWith('/preferences')?{data:{locale:'en'}}:{error:{code:'UPSTREAM_REJECTED',upstream:'storage',upstreamStatus:400},requestId:'req1'}})};
 vm.runInNewContext(source,sandbox);await mount();assert.equal(connected,1);assert.equal(intervals.length,2);assert.equal(state.loaded,false);assert.equal(state.error.upstreamStatus,400);assert.ok(!JSON.stringify(render()).includes('total: 0'));
});
