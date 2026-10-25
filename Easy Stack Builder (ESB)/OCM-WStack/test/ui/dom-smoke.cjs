'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {environment}=require('./environment.cjs');
const ui=path.join(__dirname,'../../runtime/uibuilder/orce/dist');
const vue=fs.readFileSync(process.env.ESB_TEST_VUE_PATH||path.join(path.dirname(require.resolve('vue/package.json')),'dist/vue.runtime.global.prod.js'),'utf8');
const permissions=['credentials.read','credentials.receive','credentials.issue','credentials.verify','credentials.delete','credentials.revoke','relationships.read','relationships.manage','roles.read','roles.manage','audit.read','system.health.read'];
const summary={id:'one',types:['Participant'],issuer:{id:'did:web:issuer.example'},subject:{id:'did:web:holder.example'},status:{state:'not_checked'},format:'ldp_vc'};
async function boot(t,{failure=false,issuanceFailure=false}={}){
 const dom=await environment('https://wallet.example/orce/'),w=dom.window,calls=[];t.after(()=>{dom.window.close();assert.deepEqual(dom.errors,[]);});
 Object.defineProperty(w,'crypto',{value:require('node:crypto').webcrypto});w.confirm=()=>true;w.setInterval=()=>1;w.clearInterval=()=>{};w.io=()=>({on(){},disconnect(){}});
 w.auth={setup:async()=>true,token:async()=>'ocm-token',logout(){},login:async()=>{}};w.pcmAuth={configure:async()=>({enabled:true}),login:async()=>{},token:async()=>'pcm-token',disconnect(){}};
 let registry=[{id:'Native',name:'Native type',format:'ldp_vc',issuerConfigurationId:'Native',fields:{},available:true,revision:0}];let users=[{id:'user-1',username:'Alice',email:'alice@example.test',enabled:true,roles:[{id:'role-1',name:'viewer'}]}];const roles=[{id:'read',name:'credentials.read',kind:'atomic',editable:false,permissions:['credentials.read']},{id:'manage',name:'roles.manage',kind:'atomic',editable:false,permissions:['roles.manage']},{id:'role-1',name:'viewer',description:'Read credentials',kind:'composite',editable:true,permissions:['credentials.read']}];let removed=false,accepted=false,connections={pcm:{enabled:false},trustedHosts:[],redirectUri:'https://wallet.example/orce/pcm/callback'};
 w.fetch=async(url,o)=>{calls.push({url,o});const p=url.replace('/orce/ui-api/v1','').replace(/^\/pcm/,'').split('?')[0];let data={items:[]};
  if(p==='/issuance'&&issuanceFailure)return {ok:false,status:500,headers:{get:()=> 'parser-request-1'},json:async()=>{throw new SyntaxError('Unexpected token I, Internal Server Error');}};
  if(p==='/connections'){if(o.method==='PUT')connections={...connections,...JSON.parse(o.body)};data=connections;}
  else if(p==='/connections/test')data={state:'partial',checkedAt:new Date().toISOString(),checks:[{name:'oidc',state:'passed'},{name:'accountEndpoint',state:'authentication_required',httpStatus:401},{name:'personalLogin',state:'not_tested'}]};
  else if(p==='/connection-test')data={state:'succeeded',checks:[{name:'credentials',state:'passed'},{name:'offers',state:'passed'}]};
  else if(p==='/credential-types'&&o.method==='GET')data={items:registry,nativeTypes:[{id:'Native',format:'ldp_vc'}]};
  else if(p==='/credential-types'&&o.method==='POST'){registry.push({...JSON.parse(o.body),revision:1,available:false});data={state:'succeeded'};}
  else if(p.startsWith('/credential-types/')){const id=decodeURIComponent(p.split('/').at(-1));if(o.method==='DELETE')registry=registry.filter(x=>x.id!==id);else registry=registry.map(x=>x.id===id?{...JSON.parse(o.body),revision:x.revision+1}:x);data={state:'succeeded'};}
  else if(p==='/roles'&&o.method==='GET')data={items:roles};
  else if(p==='/role-assignments')data={items:users};
  else if(p.endsWith('/effective'))data={permissions:['credentials.read']};
  else if(p==='/audit')data={items:[{timestamp:new Date().toISOString(),actor:{username:'Alice',subject:'user-1'},action:'createType',outcome:'succeeded',requestId:'r1'},{timestamp:new Date().toISOString(),subject:'legacy-user',action:'accept',outcome:'succeeded',requestId:'r2'}]};
  else if(p==='/auth/me')data={subject:'operator',username:'Mani',permissions};
  else if(p==='/me')data={account:'alice'};
  else if(p==='/preferences')data={locale:'en'};
  else if(p==='/credentials'&&failure)return {ok:false,status:502,json:async()=>({error:{code:'UPSTREAM_REJECTED',upstream:'storage',upstreamStatus:400,reason:'STORAGE_REGION_MISSING'},requestId:'req-1'})};
  else if(p==='/credentials')data={items:removed?[]:[summary],total:removed?0:1,counts:{total:removed?0:1,active:0,expired:0,revoked:0,notChecked:removed?0:1}};
  else if(p==='/credentials/one/provenance')data={root:'one',nodes:[],edges:[],verified:false};
  else if(p==='/credentials/one/verify')data={overall:'valid',cryptographic:{state:'valid'},status:{state:'not_required'},disclosedClaims:{name:'Alice'}};
  else if(p==='/credentials/one'&&o.method==='DELETE'){removed=true;data={state:'succeeded',credentialId:'one'};}
  else if(p==='/credentials/one')data={...summary,raw:{type:['VerifiableCredential']},claims:{name:'Alice'},capabilities:{revoke:false,delete:true,verify:true}};
  else if(p==='/credentials/import')data={state:'succeeded',credentialId:'new',lifecycle:{state:'checked',persistence:'confirmed',credentialId:'new',options:[{action:'verify',available:true},{action:'revoke',available:false,reason:'STATUS_NOT_MANAGED_HERE'}]}};
  else if(p==='/offers')data={items:accepted?[]:[{requestId:'offer-1',issuer:'https://issuer.example',credentialConfigurationIds:['Participant'],state:'pending'}]};
  else if(p==='/offers/import')data={state:'succeeded',upstreamRequestId:'offer-1'};
  else if(p.endsWith('/accept')){accepted=true;data={state:'succeeded',accepted:true,upstreamRequestId:'offer-1'};}
  else if(p==='/keys')data={items:[{id:'key-1',did:'did:jwk:alice'}]};
  return {ok:true,status:200,json:async()=>({data})};
 };
 w.eval(vue);w.eval('const {createApp,h,reactive,onMounted,onUnmounted}=Vue;'+fs.readFileSync(path.join(ui,'locales.js'),'utf8').replace('export const locales','const locales')+fs.readFileSync(path.join(ui,'app.js'),'utf8').replace(/^import .*;\n/gm,''));
 const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));};await settle();
 const click=async text=>{const b=[...w.document.querySelectorAll('button')].find(x=>x.textContent.trim()===text&&!x.disabled);assert.ok(b,'button '+text);b.click();await settle();};
 return {w,calls,click,settle,text:()=>w.document.body.textContent};
}
test('real Vue DOM: details, verification, unsupported revocation and deletion',async t=>{
 const b=await boot(t);assert.ok(b.w.document.querySelector('img[alt="FACIS"]'));assert.match(b.text(),/Participant/);await b.click('View');assert.ok(b.w.document.querySelector('[role="dialog"]'));assert.equal([...b.w.document.querySelectorAll('.dialog button')].some(x=>x.textContent==='Revoke'),false);
 await b.click('Verify');assert.match(b.text(),/Alice/);await b.click('Delete local copy');assert.equal(b.w.document.querySelector('[role="dialog"]'),null);
});
test('real Vue DOM: offer import is distinct from asynchronous acceptance',async t=>{
 const b=await boot(t);await b.click('Receive credential');const a=b.w.document.querySelector('textarea');a.value='openid-credential-offer://?credential_offer=test';a.dispatchEvent(new b.w.Event('input',{bubbles:true}));
 await b.click('Import offer');assert.match(b.text(),/offer-1/);assert.doesNotMatch(b.text(),/Retrieval accepted the request/);await b.click('Accept');assert.match(b.text(),/does not confirm persistence/);
});
test('real Vue DOM: PCM requires a distinct login and forwards only its own bearer header',async t=>{
 const b=await boot(t);await b.click('Personal OCM context');assert.equal(b.calls.filter(x=>x.url.includes('/pcm/')).length,0);await b.click('Connect PCM Cloud');assert.ok(b.calls.some(x=>x.url.includes('/pcm/credentials')&&x.o.headers['X-PCM-Authorization']==='Bearer pcm-token'));assert.match(b.text(),/alice/);await b.click('Disconnect');assert.doesNotMatch(b.text(),/Participant/);
});
test('real Vue DOM: upstream rejection stays visible and does not become an empty-success state',async t=>{
 const b=await boot(t,{failure:true});assert.match(b.w.document.querySelector('[role="alert"]').textContent,/HTTP 400.*STORAGE_REGION_MISSING/);assert.doesNotMatch(b.text(),/Total: 0/);
});
test('OCM Connections page saves PCM and trusted peers without a deployer configuration',async t=>{
 const b=await boot(t);await b.click('Connections');assert.match(b.text(),/Personal OCM context connection/);
 const enabled=b.w.document.querySelector('input[type=checkbox]');enabled.checked=true;enabled.dispatchEvent(new b.w.Event('change',{bubbles:true}));await b.settle();
 for(const [id,value]of Object.entries({'f-pcmIssuer':'https://identity.pcm.example/realms/pcm','f-pcmClient':'wallet','f-pcmTenant':'pcm','f-pcmAccountUrl':'https://pcm.example'})){const field=b.w.document.getElementById(id);assert.ok(field);field.value=value;field.dispatchEvent(new b.w.Event('input',{bubbles:true}));}
 const trusted=b.w.document.getElementById('a-trustedHosts');trusted.value='peer.example';trusted.dispatchEvent(new b.w.Event('input',{bubbles:true}));await b.click('Test connection');assert.match(b.text(),/Discovery and endpoint checks completed/);await b.click('Save');
 const call=b.calls.find(x=>x.url.endsWith('/connections')&&x.o.method==='PUT');assert.ok(call);assert.equal(JSON.parse(call.o.body).pcm.accountUrl,'https://pcm.example');assert.deepEqual(JSON.parse(call.o.body).trustedHosts,['peer.example']);assert.match(b.text(),/Connection settings saved/);
});
async function fill(b,id,value){const el=b.w.document.getElementById(id);assert.ok(el,id);el.value=value;el.dispatchEvent(new b.w.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));await b.settle();}
test('SVG logo and registry create, edit, delete interactions work in the real DOM',async t=>{
 const b=await boot(t);assert.equal(b.w.document.querySelector('img[alt="FACIS"]').getAttribute('src'),'/orce/facis-logo.svg');
 await b.click('Credential registry');await b.click('Create credential type');await fill(b,'f-identifier','Business');await fill(b,'f-name','Business type');await b.click('Add field');await fill(b,'f-fieldName0','company');await b.click('Save');assert.match(b.text(),/Business type/);
 const edit=[...b.w.document.querySelectorAll('tr')].find(x=>x.textContent.includes('Business type'));[...edit.querySelectorAll('button')].find(x=>x.textContent==='Edit').click();await b.settle();assert.equal(b.w.document.getElementById('s-issuerConfiguration').value,'');await fill(b,'f-name','Updated business');await b.click('Save');assert.match(b.text(),/Updated business/);
 const row=[...b.w.document.querySelectorAll('tr')].find(x=>x.textContent.includes('Updated business'));[...row.querySelectorAll('button')].find(x=>x.textContent==='Delete type').click();await b.settle();assert.doesNotMatch(b.text(),/Updated business/);
 const create=b.calls.find(x=>x.url.endsWith('/credential-types')&&x.o.method==='POST');assert.equal(JSON.parse(create.o.body).fields.company.maxLength,256);
});
test('roles and permission panels expose grouped labels and send permission edits',async t=>{
 const b=await boot(t);await b.click('Roles');assert.match(b.text(),/viewer/);assert.doesNotMatch(b.text(),/Create user/);await b.click('Create role');await fill(b,'f-name','custom');
 const checkbox=b.w.document.querySelector('.permission-grid input');checkbox.checked=true;checkbox.dispatchEvent(new b.w.Event('change',{bubbles:true}));await b.click('Save');
 const call=b.calls.find(x=>x.url.endsWith('/roles')&&x.o.method==='POST');assert.deepEqual(JSON.parse(call.o.body).permissions,['credentials.read']);
 await b.click('Permissions');assert.match(b.text(),/Read credentials/);assert.equal(b.w.document.querySelector('.permission-grid input'),null);
});
test('users panel supports profile creation and displays effective role permissions',async t=>{
 const b=await boot(t);await b.click('Users');assert.match(b.text(),/Alice/);await b.click('Manage access');assert.match(b.text(),/Effective permissions/);assert.match(b.text(),/Read credentials/);await b.click('Close');
 await b.click('Create user');await fill(b,'f-username','bob');await fill(b,'f-temporaryPassword','test-long-password');await b.click('Save');
 assert.equal(JSON.parse(b.calls.find(x=>x.url.endsWith('/users')&&x.o.method==='POST').o.body).username,'bob');
});
test('audit shows actor usernames and stable fallback IDs for earlier events',async t=>{
 const b=await boot(t);await b.click('Audit log');assert.match(b.text(),/Alice/);assert.match(b.text(),/user-1/);assert.match(b.text(),/legacy-user/);
});
test('PCM test results distinguish reachable endpoints and test signed-in operations',async t=>{
 const b=await boot(t);await b.click('Connections');const enabled=b.w.document.querySelector('input[type=checkbox]');enabled.checked=true;enabled.dispatchEvent(new b.w.Event('change',{bubbles:true}));await b.settle();
 for(const [id,value]of Object.entries({'f-pcmIssuer':'https://identity.example/realms/pcm','f-pcmClient':'wallet','f-pcmTenant':'pcm','f-pcmAccountUrl':'https://pcm.example'}))await fill(b,id,value);
 await b.click('Test connection');assert.match(b.text(),/Reachable; login required/);assert.match(b.text(),/Not tested/);await b.click('Save');await b.click('Connect PCM Cloud');await b.click('Test signed-in account');assert.ok(b.calls.some(x=>x.url.endsWith('/pcm/connection-test')&&x.o.headers['X-PCM-Authorization']==='Bearer pcm-token'));
});
test('credential import renders lifecycle checks without offering unsupported revocation',async t=>{
 const b=await boot(t);await b.click('Receive credential');await fill(b,'a-credentialJson','{"type":["VerifiableCredential"]}');await b.click('Import credential file');assert.match(b.text(),/Credential lifecycle checks/);assert.match(b.text(),/Storage confirmed/);assert.match(b.text(),/STATUS_NOT_MANAGED_HERE/);
});

test('issuance plain-text 500 shows HTTP evidence and keeps the same idempotency key on retry',async t=>{
 const b=await boot(t,{issuanceFailure:true});await b.click('Issue credential');await b.click('Review and issue');const alert=b.w.document.querySelector('[role="alert"]').textContent;assert.match(alert,/HTTP 500/);assert.match(alert,/parser-request-1/);assert.doesNotMatch(alert,/Unexpected token|SyntaxError/);await b.click('Review and issue');const requests=b.calls.filter(x=>x.url.endsWith('/issuance'));assert.equal(requests.length,2);assert.equal(requests[0].o.headers['X-Idempotency-Key'],requests[1].o.headers['X-Idempotency-Key']);
});
