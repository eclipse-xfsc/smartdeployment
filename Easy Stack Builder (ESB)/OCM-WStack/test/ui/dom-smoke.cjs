'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const ui=path.join(__dirname,'../../runtime/uibuilder/orce/dist');
const vue=fs.readFileSync(path.join(path.dirname(require.resolve('vue/package.json')),'dist/vue.runtime.global.prod.js'),'utf8');
const permissions=['credentials.read','credentials.receive','credentials.issue','credentials.verify','credentials.delete','credentials.revoke','relationships.read','relationships.manage','roles.read','roles.manage','audit.read','system.health.read'];
const summary={id:'one',types:['Participant'],issuer:{id:'did:web:issuer.example'},subject:{id:'did:web:holder.example'},status:{state:'not_checked'},format:'ldp_vc'};
async function boot(t,{failure=false}={}){
 const dom=new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',{url:'https://wallet.example/orce/',runScripts:'outside-only'}),w=dom.window,calls=[];t.after(()=>dom.window.close());
 Object.defineProperty(w,'crypto',{value:require('node:crypto').webcrypto});w.confirm=()=>true;w.setInterval=()=>1;w.clearInterval=()=>{};w.io=()=>({on(){},disconnect(){}});
 w.auth={setup:async()=>true,token:async()=>'ocm-token',logout(){},login:async()=>{}};w.pcmAuth={configure:async()=>({enabled:true}),login:async()=>{},token:async()=>'pcm-token',disconnect(){}};
 let removed=false,accepted=false;
 w.fetch=async(url,o)=>{calls.push({url,o});const p=url.replace('/orce/ui-api/v1','').replace(/^\/pcm/,'').split('?')[0];let data={items:[]};
  if(p==='/auth/me')data={subject:'operator',username:'Mani',permissions};
  else if(p==='/me')data={account:'alice'};
  else if(p==='/preferences')data={locale:'en'};
  else if(p==='/credentials'&&failure)return {ok:false,status:502,json:async()=>({error:{code:'UPSTREAM_REJECTED',upstream:'storage',upstreamStatus:400,reason:'STORAGE_REGION_MISSING'},requestId:'req-1'})};
  else if(p==='/credentials')data={items:removed?[]:[summary],total:removed?0:1,counts:{total:removed?0:1,active:0,expired:0,revoked:0,notChecked:removed?0:1}};
  else if(p==='/credentials/one/provenance')data={root:'one',nodes:[],edges:[],verified:false};
  else if(p==='/credentials/one/verify')data={overall:'valid',cryptographic:{state:'valid'},status:{state:'not_required'},disclosedClaims:{name:'Alice'}};
  else if(p==='/credentials/one'&&o.method==='DELETE'){removed=true;data={state:'succeeded',credentialId:'one'};}
  else if(p==='/credentials/one')data={...summary,raw:{type:['VerifiableCredential']},claims:{name:'Alice'},capabilities:{revoke:false,delete:true,verify:true}};
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
