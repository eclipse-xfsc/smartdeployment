'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {environment}=require('./environment.cjs');
const ui=path.join(__dirname,'../../runtime/uibuilder/orce/dist');
const vue=fs.readFileSync(process.env.ESB_TEST_VUE_PATH||path.join(path.dirname(require.resolve('vue/package.json')),'dist/vue.runtime.global.prod.js'),'utf8');
const permissions=['credentials.read','credentials.receive','credentials.issue','credentials.verify','credentials.delete','credentials.revoke','relationships.read','relationships.write','clearing.request','roles.read','admin.users','audit.read','system.health.read'];
const summary={id:'one',types:['Participant'],issuer:{id:'did:web:issuer.example'},subject:{id:'did:web:holder.example'},status:{state:'not_checked'},format:'ldp_vc'};
async function boot(t,{failure=false,issuanceFailure=false,acceptedStorage=false,acceptanceFailure=false,nativeLifecycle=false,nativeFailure=false,authenticated=true,passwordChangeRequired=false,clearing=false,sourceComponents=false}={}){
 const dom=await environment('https://ocm.example/orce/'),w=dom.window,calls=[],navigations=[],sockets=[];t.after(()=>{dom.window.close();assert.deepEqual(dom.errors,[]);});
 Object.defineProperty(w,'crypto',{value:require('node:crypto').webcrypto});w.confirm=()=>true;w.setInterval=()=>1;w.clearInterval=()=>{};w.io=(namespace,options)=>{sockets.push({namespace,options});return {on(){},disconnect(){}};};w.location.assign=url=>navigations.push(url);
 let session=authenticated;const csrf='ui-session-csrf-token';
 let registry=[{id:'Native',name:'Native type',format:'ldp_vc',issuerConfigurationId:'Native',fields:{},available:true,revision:0}];let users=[{id:'user-1',username:'Alice',email:'alice@example.test',enabled:true,roles:[{id:'role-1',name:'viewer'}]}];const roles=[{id:'read',name:'credentials.read',kind:'atomic',editable:false,permissions:['credentials.read']},{id:'manage',name:'admin.users',kind:'atomic',editable:false,permissions:['admin.users']},{id:'role-1',name:'viewer',description:'Read credentials',kind:'composite',editable:true,permissions:['credentials.read']}];let removed=false,accepted=false;let clearingJobs=[];
 w.fetch=async(url,o)=>{calls.push({url,o});const p=url.replace('/orce/ui-api/v1','').split('?')[0];let data={items:[]};
  if(p==='/auth/csrf')return session
   ? {ok:true,status:200,json:async()=>({data:{csrfToken:csrf}})}
   : {ok:false,status:401,json:async()=>({error:{code:'AUTHENTICATION_REQUIRED'}})};
  if(p==='/auth/login'){session=true;return {ok:true,status:200,json:async()=>({data:{csrfToken:csrf}})};}
  if(p==='/auth/logout'||p==='/auth/password'){
   assert.equal(o.headers['X-CSRF-Token'],csrf);session=false;
   return {ok:true,status:200,json:async()=>({data:{state:'succeeded'}})};
  }
  assert.ok(session,'API request requires an authenticated UI session');
  assert.equal(o.credentials,'same-origin');
  assert.equal(o.headers['X-CSRF-Token'],csrf);
  assert.equal(o.headers.Authorization,undefined);
  if(p==='/issuance'&&issuanceFailure)return {ok:false,status:500,headers:{get:()=> 'parser-request-1'},json:async()=>{throw new SyntaxError('Unexpected token I, Internal Server Error');}};
  if(p==='/clearing/providers')data={items:clearing?[{id:'gaia-x',name:'Gaia-X Clearing Center',url:'https://compliance-dispatcher.lab.gaia-x.eu/v3',protocol:'OID4VP / OID4VCI',trustScope:'GX_LOIRE_COMPLIANCE',requestSupported:true}]:[]};
  else if(p==='/clearing/inputs')data={items:['gaiax-legal-person','gaiax-vat-id','gaiax-terms-and-conditions'].map(id=>({id,credentials:[{id:id+'-stored'}]}))};
  else if(p==='/clearing/requests'&&o.method==='POST'){assert.equal(o.headers['X-CSRF-Token'],csrf);assert.ok(o.headers['X-Idempotency-Key']);const body=JSON.parse(o.body);assert.equal(body.provider,'gaia-x');assert.equal(Object.keys(body.credentials).length,3);clearingJobs=[{id:'clearing-1',state:'pending',phase:'receiving'}];data={state:'pending',resourceId:'clearing-1'};}
  else if(p==='/clearing/requests')data={items:clearingJobs};
  else if(p==='/credential-types'&&o.method==='GET')data={items:registry,nativeTypes:[{id:'Native',format:'ldp_vc'}]};
  else if(p==='/credential-types'&&o.method==='POST'){registry.push({...JSON.parse(o.body),revision:1,available:false});data={state:'succeeded'};}
  else if(p.startsWith('/credential-types/')){const id=decodeURIComponent(p.split('/').at(-1));if(o.method==='DELETE')registry=registry.filter(x=>x.id!==id);else registry=registry.map(x=>x.id===id?{...JSON.parse(o.body),revision:x.revision+1}:x);data={state:'succeeded'};}
  else if(p==='/roles'&&o.method==='GET')data={items:roles};
  else if(p==='/role-assignments')data={items:users};
  else if(p.endsWith('/effective'))data={permissions:['credentials.read']};
  else if(p==='/audit')data={items:[{timestamp:new Date().toISOString(),actor:{username:'Alice',subject:'user-1'},action:'createType',outcome:'succeeded',requestId:'r1'},{timestamp:new Date().toISOString(),subject:'legacy-user',action:'accept',outcome:'succeeded',requestId:'r2'}]};
  else if(p==='/auth/me')data={subject:'operator',username:'Mani',permissions,passwordChangeRequired};
  else if(p==='/preferences')data={locale:'en'};
  else if(p==='/credentials'&&failure)return {ok:false,status:502,json:async()=>({error:{code:'UPSTREAM_REJECTED',upstream:'storage',upstreamStatus:400,reason:'STORAGE_REGION_MISSING'},requestId:'req-1'})};
  else if(p==='/credentials')data={items:removed?[]:[summary],total:removed?0:1,counts:{total:removed?0:1,active:0,expired:0,revoked:0,notChecked:removed?0:1}};
  else if(p==='/credentials/one/provenance')data={root:'one',nodes:[],edges:[],verified:false,verifications:nativeLifecycle?[{timestamp:new Date().toISOString(),verifier:'user-id',verifierName:'Mani',service:'XFSC Signer',overall:'indeterminate'}]:[]};
  else if(p==='/credentials/one/verify'&&nativeFailure)data={service:'XFSC Signer',overall:'indeterminate',code:'UPSTREAM_REJECTED',upstreamStatus:500,cryptographic:{state:'not_separately_reported'},status:{state:'not_separately_reported'},requestedBy:{username:'Mani'}};
  else if(p==='/credentials/one/revoke')data={state:'succeeded',source:'XFSC Status',status:'revoked',confirmation:'native-acknowledgement'};
  else if(p==='/credentials/one/verify')data={overall:'valid',cryptographic:{state:'valid'},status:{state:'not_required'},disclosedClaims:{name:'Alice'}};
  else if(p==='/credentials/one'&&o.method==='DELETE'){removed=true;data={state:'succeeded',credentialId:'one'};}
  else if(p==='/credentials/one')data={...summary,...(nativeLifecycle?{subject:{id:null},holder:{kind:'key-binding',label:'Holder key binding (EC, P-256, eckey)'}}:{}),raw:{type:['VerifiableCredential']},claims:{name:'Alice'},capabilities:{revoke:nativeLifecycle,delete:true,verify:true}};
  else if(p==='/credentials/import')data={state:'succeeded',credentialId:'new',lifecycle:{state:'checked',persistence:'confirmed',credentialId:'new',options:[{action:'verify',available:true},{action:'revoke',available:false,reason:'STATUS_NOT_MANAGED_HERE'}]}};
  else if(p==='/offers')data={items:accepted?[]:[{requestId:'offer-1',issuer:'https://issuer.example',credentialConfigurationIds:['Participant'],state:'pending'}]};
  else if(p==='/offers/import')data={state:'succeeded',upstreamRequestId:'offer-1'};
  else if(p.endsWith('/accept')){if(acceptanceFailure)return {ok:false,status:422,json:async()=>({error:{code:'RETRIEVAL_CREDENTIAL_FORMAT_UNSUPPORTED',upstream:'retrieval',upstreamStatus:400,reason:'RETRIEVAL_CREDENTIAL_FORMAT_UNSUPPORTED'},requestId:'acceptance-1'})};accepted=true;data={state:'succeeded',accepted:true,upstreamRequestId:'offer-1',...(acceptedStorage?{credentialId:'stored-1',storageConfirmation:'confirmed',lifecycle:{state:'checked',persistence:'confirmed',options:[]}}:{})};}
  else if(p==='/keys')data={items:[{id:'key-1',did:'did:jwk:alice'}]};
  return {ok:true,status:200,json:async()=>({data})};
 };
 const authSource=fs.readFileSync(path.join(ui,'auth.js'),'utf8').replace(/^export /gm,'');
 w.eval('globalThis.auth=(()=>{'+authSource+';return {setup,login,headers,csrfToken,logout,changePassword};})();');
 w.eval(vue);
 if(sourceComponents){
  const src=path.join(__dirname,'../../ui/src');
  w.eval('const {createApp,h,reactive,onMounted,onUnmounted}=Vue;'+fs.readFileSync(path.join(src,'locales.js'),'utf8').replace('export const locales','const locales'));
  for(const name of ['ProvenanceGraph','RelationshipsView','ClearingCenterView','IssueCredentialView','ReceiveCredentialsView','CredentialsView','App']){
   const source=fs.readFileSync(path.join(src,name==='App'?'App.vue':'views/'+name+'.vue'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
   w.eval(source.replace(/^import .*;\n/gm,'').replace('export default','const '+name+' = '));
  }
  w.eval("createApp(App).mount('#app');");
 }else w.eval('const {createApp,h,reactive,onMounted,onUnmounted}=Vue;'+fs.readFileSync(path.join(ui,'locales.js'),'utf8').replace('export const locales','const locales')+fs.readFileSync(path.join(ui,'app.js'),'utf8').replace(/^import .*;\n/gm,''));
 const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));};await settle();
 const click=async text=>{const b=[...w.document.querySelectorAll('button')].find(x=>x.textContent.trim()===text&&!x.disabled);assert.ok(b,'button '+text);b.click();await settle();};
 return {w,calls,navigations,sockets,click,settle,text:()=>w.document.body.textContent};
}
test('UI: details, verification, unsupported revocation and deletion',async t=>{
 const b=await boot(t);assert.ok(b.w.document.querySelector('img[alt="FACIS"]'));assert.match(b.text(),/Participant/);await b.click('View');assert.ok(b.w.document.querySelector('[role="dialog"]'));assert.equal([...b.w.document.querySelectorAll('.dialog button')].some(x=>x.textContent==='Revoke'),false);
 await b.click('Verify');assert.match(b.text(),/Alice/);await b.click('Delete local copy');assert.equal(b.w.document.querySelector('[role="dialog"]'),null);
});
test('UI: offer import is distinct from asynchronous acceptance',async t=>{
 const b=await boot(t);await b.click('Receive credential');const a=b.w.document.querySelector('textarea');a.value='openid-credential-offer://?credential_offer=test';a.dispatchEvent(new b.w.Event('input',{bubbles:true}));
 await b.click('Import offer');assert.match(b.text(),/offer-1/);assert.doesNotMatch(b.text(),/Retrieval accepted the request/);await b.click('Accept');assert.match(b.text(),/does not confirm persistence/);
});
test('UI: confirmed acceptance reports exact Storage read-back after acceptance',async t=>{
 const b=await boot(t,{acceptedStorage:true});await b.click('Receive credential');await b.click('Accept');
 assert.match(b.text(),/Accepted and saved to Storage/);assert.match(b.text(),/exact credential was confirmed/);assert.doesNotMatch(b.text(),/does not confirm persistence/);
});
test('UI: DeveloperCredential failure explains native format support and preserves request evidence',async t=>{
 const b=await boot(t,{acceptanceFailure:true});await b.click('Receive credential');await b.click('Accept');
 const alert=b.w.document.querySelector('[role="alert"]').textContent;
 assert.match(alert,/DeveloperCredential/);assert.match(alert,/verifier supports JWT and SD-JWT/);assert.match(alert,/retrieval.*HTTP 400/);assert.match(alert,/acceptance-1/);assert.doesNotMatch(alert,/UPSTREAM_REJECTED/);
});
test('UI session restores credentials and supplies CSRF to API and socket requests',async t=>{
 const b=await boot(t);
 assert.match(b.text(),/Participant/);
 assert.ok(b.calls.some(x=>x.url.endsWith('/auth/csrf')&&x.o.method==='POST'));
 assert.equal(b.sockets.length,1);
 assert.equal(b.sockets[0].options.auth.csrfToken,'ui-session-csrf-token');
 assert.equal(b.calls.some(x=>x.url.includes('/pcm/')),false);
 assert.equal(b.w.document.querySelector('nav').textContent.includes('Connections'),false);
 await b.click('View');await b.click('Verify');
 const verify=b.calls.find(x=>x.url.endsWith('/verify'));
 assert.equal(verify.o.credentials,'same-origin');
 assert.equal(verify.o.headers['X-CSRF-Token'],'ui-session-csrf-token');
 assert.equal(verify.o.headers.Authorization,undefined);
});
test('UI: upstream rejection stays visible and does not become an empty-success state',async t=>{
 const b=await boot(t,{failure:true});assert.match(b.w.document.querySelector('[role="alert"]').textContent,/HTTP 400.*STORAGE_REGION_MISSING/);assert.doesNotMatch(b.text(),/Total: 0/);
});
test('UI sign-in submits credentials and restores the session token',async t=>{
 const b=await boot(t,{authenticated:false});
 assert.equal(b.w.document.querySelector('nav'),null);
 assert.equal(b.calls.length,1);
 assert.ok(b.calls[0].url.endsWith('/auth/csrf'));
 await fill(b,'f-username','operator');await fill(b,'f-password','test-password-123');
 await b.click('Sign in');
 const login=b.calls.find(x=>x.url.endsWith('/auth/login'));
 assert.deepEqual(JSON.parse(login.o.body),{username:'operator',password:'test-password-123'});
 assert.equal(login.o.credentials,'same-origin');
 assert.equal(login.o.headers.Authorization,undefined);
 assert.deepEqual(b.navigations,['/orce/']);
 assert.equal(b.w.auth.csrfToken(),'ui-session-csrf-token');
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
test('UI sign-out clears the displayed credentials and session token',async t=>{
 const b=await boot(t);assert.match(b.text(),/Participant/);
 await b.click('Sign out');
 const logout=b.calls.find(x=>x.url.endsWith('/auth/logout'));
 assert.ok(logout);assert.equal(logout.o.method,'POST');
 assert.equal(logout.o.headers['X-CSRF-Token'],'ui-session-csrf-token');
 assert.equal(b.w.auth.csrfToken(),undefined);
 assert.equal(b.w.document.querySelector('nav'),null);
 assert.doesNotMatch(b.text(),/Participant/);
 assert.deepEqual(b.navigations,['/orce/']);
});
test('credential import renders lifecycle checks without offering unsupported revocation',async t=>{
 const b=await boot(t);await b.click('Receive credential');await fill(b,'a-credentialJson','{"type":["VerifiableCredential"]}');await b.click('Import credential file');assert.match(b.text(),/Credential lifecycle checks/);assert.match(b.text(),/Storage confirmed/);assert.match(b.text(),/STATUS_NOT_MANAGED_HERE/);
});

test('issuance plain-text 500 shows HTTP evidence and keeps the same idempotency key on retry',async t=>{
 const b=await boot(t,{issuanceFailure:true});await b.click('Issue credential');await b.click('Review and issue');const alert=b.w.document.querySelector('[role="alert"]').textContent;assert.match(alert,/HTTP 500/);assert.match(alert,/parser-request-1/);assert.doesNotMatch(alert,/Unexpected token|SyntaxError/);await b.click('Review and issue');const requests=b.calls.filter(x=>x.url.endsWith('/issuance'));assert.equal(requests.length,2);assert.equal(requests[0].o.headers['X-Idempotency-Key'],requests[1].o.headers['X-Idempotency-Key']);
});

test('native lifecycle UI: holder binding and verifier actor/service remain distinct',async t=>{
 const b=await boot(t,{nativeLifecycle:true});await b.click('View');assert.match(b.text(),/Holder key binding.*P-256.*eckey/);assert.match(b.text(),/Mani \/ XFSC Signer/);assert.ok([...b.w.document.querySelectorAll('.dialog button')].some(x=>x.textContent==='Revoke'));
});
test('native lifecycle UI: revoke acknowledgement retains copy and delete stays a separate action',async t=>{
 const b=await boot(t,{nativeLifecycle:true});await b.click('View');await b.click('Revoke');assert.match(b.w.document.querySelector('[role="dialog"]').textContent,/Revocation confirmed by the native Status service/);assert.match(b.text(),/local copy is retained/);assert.equal(b.calls.filter(x=>x.url.endsWith('/revoke')).length,1);assert.equal(b.calls.filter(x=>x.o.method==='DELETE').length,0);assert.equal(b.calls.filter(x=>x.url.endsWith('/verify')).length,0);assert.ok(b.w.document.querySelector('[role="dialog"]'));await b.click('Delete local copy');assert.equal(b.calls.filter(x=>x.o.method==='DELETE').length,1);
});
test('native lifecycle UI: native verification errors show evidence with the request context',async t=>{
 const b=await boot(t,{nativeLifecycle:true,nativeFailure:true});assert.match(b.text(),/does not mean active or revoked/);await b.click('View');await b.click('Verify');const dialog=b.w.document.querySelector('[role="dialog"]').textContent;assert.match(dialog,/UPSTREAM_REJECTED.*HTTP 500/);assert.match(dialog,/Not separately reported by the native service/);assert.match(dialog,/Requested by.*Mani/);assert.doesNotMatch(dialog,/Verified successfully/);
});

test('Required password change precedes credential access',async t=>{
 const b=await boot(t,{passwordChangeRequired:true});
 assert.equal(b.w.document.querySelector('nav'),null);
 assert.equal(b.calls.some(x=>x.url.includes('/credentials')),false);
 await fill(b,'f-currentPassword','initial-password-123');
 await fill(b,'f-newPassword','replacement-password-456');
 await b.click('Save');
 const change=b.calls.find(x=>x.url.endsWith('/auth/password'));
 assert.ok(change);assert.deepEqual(JSON.parse(change.o.body),{
  currentPassword:'initial-password-123',newPassword:'replacement-password-456'
 });
 assert.equal(change.o.headers['X-CSRF-Token'],'ui-session-csrf-token');
 assert.equal(b.w.auth.csrfToken(),undefined);
 assert.deepEqual(b.navigations,['/orce/']);
});

for(const sourceComponents of [false,true])test('UI: Clearing credential selection, consent and background progress '+(sourceComponents?'Vue components':'distribution'),async t=>{
 const b=await boot(t,{clearing:true,sourceComponents});await b.click('Gaia-X Clearing Center');
 const request=()=>[...b.w.document.querySelectorAll('button')].find(x=>x.textContent==='Request credential');
 assert.ok(request().disabled);
 for(const select of b.w.document.querySelectorAll('select[id^="s-gaiax-"]')){select.value=select.options[1].value;select.dispatchEvent(new b.w.Event('change',{bubbles:true}));}
 await b.settle();assert.equal(request().disabled,false);
 let consent;b.w.confirm=message=>{consent=message;return true;};await b.click('Request credential');
 assert.match(consent,/compliance-dispatcher.lab.gaia-x.eu/);assert.match(b.text(),/Receiving the compliance credential/);assert.match(b.text(),/clearing-1/);assert.ok(request().disabled);
 assert.equal(b.calls.filter(x=>x.url.endsWith('/clearing/requests')&&x.o.method==='POST').length,1);
});
