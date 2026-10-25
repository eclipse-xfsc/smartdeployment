'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {register}=require('../../runtime/lib/browser-routes.cjs');
function red(){const routes=[];return {routes,settings:{httpNodeRoot:'/',httpNodeMiddleware(req,res,next){res.setHeader('X-Test-Middleware','applied');next();}},httpNode:{get(path,...handlers){routes.push({path,handlers});}},nodes:{registerType(){}}};}
test('runtime module registers exact callback before flow creation and only once',()=>{
 const RED=red();require('../../runtime/nodes/runtime.js')(RED);register(RED);
 assert.equal(RED.routes.length,1);assert.equal(RED.routes[0].path,'/orce/auth/callback');
});
test('disabled HTTP node server does not register browser endpoints',()=>{const RED=red();RED.settings.httpNodeRoot=false;register(RED);assert.equal(RED.routes.length,0);});
test('callback serves fixed HTML over HTTP without redirecting or reflecting login parameters',async t=>{
 const RED=red();register(RED);let received;
 const server=http.createServer((req,res)=>{
  const route=RED.routes.find(r=>r.path===new URL(req.url,'http://local').pathname);
  if(!route){res.statusCode=404;res.end();return;}
  received=req.url;let i=0;const next=()=>route.handlers[i++]?.(req,res,next);next();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const query='?code=fixture-code&state=fixture-state&iss=https%3A%2F%2Fauth.example&next=https%3A%2F%2Fevil.example';
 const result=await fetch('http://127.0.0.1:'+server.address().port+'/orce/auth/callback'+query,{redirect:'manual'});
 assert.equal(result.status,200);assert.equal(result.headers.get('location'),null);assert.equal(received,'/orce/auth/callback'+query);
 assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(result.headers.get('referrer-policy'),'no-referrer');assert.equal(result.headers.get('x-test-middleware'),'applied');
 const html=await result.text();assert.match(html,/id="app"/);assert.match(html,/src="\/orce\/app.js"/);assert.doesNotMatch(html,/fixture-code|evil.example/);
 const unknown=await fetch('http://127.0.0.1:'+server.address().port+'/orce/auth/not-a-route');assert.equal(unknown.status,404);
});
