'use strict';
const fs=require('node:fs'),path=require('node:path');
const registered=new WeakSet();
function register(RED){
 if(RED.settings.httpNodeRoot===false||registered.has(RED.httpNode))return;
 // Register before flow instances start (including uibuilder). This works on
 // existing PVCs without replacing the user's persisted flows.json.
 const html=fs.readFileSync(path.join(__dirname,'../uibuilder/orce/dist/index.html'));
 const middleware=RED.settings.httpNodeMiddleware||((req,res,next)=>next());
 RED.httpNode.get('/orce/auth/callback',middleware,(req,res)=>{
  // Serve the fixed UI shell in place. The browser must retain the original
  // code/state query until auth.js verifies PKCE state and exchanges the code.
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.statusCode=200;
  res.end(html);
 });
 // PCM can be enabled later from Connections, without restarting this process.
  RED.httpNode.get('/orce/pcm/callback',middleware,(req,res)=>{
   res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
   res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>PCM sign in</title><p>Completing PCM sign in…</p><script type="module" src="/orce/pcm-auth.js"></script></html>');
  });
 registered.add(RED.httpNode);
}
module.exports={register};
