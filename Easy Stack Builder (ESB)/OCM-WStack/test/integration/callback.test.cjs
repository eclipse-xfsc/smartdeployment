'use strict';
// Test dependency only: npm install --prefix /tmp/ocm-callback-test express@4.21.2
// NODE_PATH=/tmp/ocm-callback-test/node_modules node --test test/integration/callback.test.cjs
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),express=require('express');
const assets=path.resolve(__dirname,'../../runtime/uibuilder/orce/dist');
async function fixture(t,fixed=true){
 const app=express(),exchanges=[];let origin;
 const middleware=(req,res,next)=>{res.setHeader('Referrer-Policy','no-referrer');if(!fixed&&req.path==='/orce/auth/callback')req.url='/orce/';next();};
 if(fixed)require('../../runtime/nodes/runtime.js')({settings:{httpNodeRoot:'/',httpNodeMiddleware:middleware},httpNode:app,nodes:{registerType(){}}});
 app.get('/orce/ui-api/v1/auth/config',middleware,(req,res)=>res.json({data:{issuer:origin+'/issuer',clientId:'ocm-ui',redirectUri:origin+'/orce/auth/callback'}}));
 app.post('/issuer/protocol/openid-connect/token',express.urlencoded({extended:false}),(req,res)=>{exchanges.push({...req.body});res.json({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:300});});
 app.use('/orce',express.static(assets));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 origin='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(resolve=>server.close(resolve)));
 return {origin,exchanges};
}
async function browserAuth(origin,query,stored){
 // Execute the shipped auth module with browser globals. This is a VM harness,
 // not Chromium or a real Keycloak server; HTTP requests go to real Express.
 const source=await (await fetch(origin+'/orce/auth.js')).text();
 const storage=new Map(stored?[['ocm.pkce',JSON.stringify(stored)]]:[]),history=[];
 const browser={URLSearchParams,Date,location:{search:query},sessionStorage:{getItem:k=>storage.get(k)??null,removeItem:k=>storage.delete(k)},history:{replaceState:(a,b,url)=>history.push(url)},fetch:(url,opts)=>fetch(new URL(url,origin),opts)};
 vm.createContext(browser);vm.runInContext(source.replace(/\bexport /g,''),browser);
 return {browser,storage,history};
}
test('reproduces callback 404 with the old HTTP In middleware placement',async t=>{const {origin}=await fixture(t,false);const r=await fetch(origin+'/orce/auth/callback?code=example&state=example');assert.equal(r.status,404);});
test('explicit callback returns HTML and completes the existing PKCE exchange',async t=>{
 const {origin,exchanges}=await fixture(t),query='?code=fixture-code&state=good-state&iss='+encodeURIComponent(origin+'/issuer');
 const response=await fetch(origin+'/orce/auth/callback'+query,{redirect:'manual'});
 assert.equal(response.status,200);assert.equal(response.headers.get('location'),null);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(await response.text(),/id="app"/);
 const {browser,storage,history}=await browserAuth(origin,query,{state:'good-state',verifier:'fixture-verifier',created:Date.now()});
 assert.equal(await browser.setup(),true);assert.equal(await browser.token(),'fixture-access');assert.deepEqual(history,['/orce/']);assert.equal(storage.size,0);
 assert.deepEqual(exchanges,[{client_id:'ocm-ui',grant_type:'authorization_code',code:'fixture-code',code_verifier:'fixture-verifier',redirect_uri:origin+'/orce/auth/callback'}]);
 const head=await fetch(origin+'/orce/auth/callback',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
});
for(const [name,query,stored,message] of [
 ['mismatched state','?code=fixture&state=wrong',{state:'good',verifier:'v',created:Date.now()},'TOKEN_INVALID'],
 ['expired state','?code=fixture&state=good',{state:'good',verifier:'v',created:Date.now()-700000},'TOKEN_INVALID'],
 ['missing session','?code=fixture&state=good',null,'AUTHENTICATION_REQUIRED'],
 ['provider error','?error=access_denied&state=good',{state:'good',verifier:'v',created:Date.now()},'TOKEN_INVALID']
])test('callback rejects '+name+' without exchanging a code',async t=>{
 const {origin,exchanges}=await fixture(t),{browser,storage}=await browserAuth(origin,query,stored);
 await assert.rejects(browser.setup(),new RegExp(message));assert.equal(exchanges.length,0);assert.equal(storage.size,0);
});
