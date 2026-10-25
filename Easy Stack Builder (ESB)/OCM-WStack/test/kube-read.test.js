'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {read}=require('../lib/kube-read');
const endpoint='/apis/argoproj.io/v1alpha1/namespaces/argocd/applications';
function mock(responses){let clock=0;const calls=[],events=[];return {calls,events,options:{now:()=>clock,sleep:async ms=>{clock+=ms;},timeoutSeconds:12},r:{emit:e=>events.push(e),redact:x=>x,run:async(cmd,args)=>{calls.push([cmd,args]);const next=responses.shift();if(next instanceof Error)throw next;return {stdout:JSON.stringify(next)};}}};}
const error=text=>Object.assign(new Error(text),{code:'COMMAND_FAILED',commandOutput:text});
test('raw Application read retries EOF and bypasses discovery',async()=>{const h=mock([error('Get "https://api.test/apis/argoproj.io": EOF'),{items:[]}]);assert.deepEqual(await read(h.r,endpoint,h.options),{items:[]});assert.equal(h.calls.length,2);assert.ok(h.calls.every(([,args])=>args.includes('--raw='+endpoint)));});
test('Argo CRD establishment waits through NotFound and unestablished state',async()=>{const h=mock([error('Error from server (NotFound): absent'),{status:{conditions:[]}},{status:{conditions:[{type:'Established',status:'True'}]}}]);await read(h.r,'/apis/apiextensions.k8s.io/v1/customresourcedefinitions/applications.argoproj.io',{...h.options,established:true});assert.equal(h.calls.length,3);});
test('persistent API errors stop at the deadline',async()=>{const h=mock(Array.from({length:4},()=>error('Get "https://api.test/apis": EOF')));await assert.rejects(read(h.r,endpoint,h.options),{code:'ARGO_API_UNAVAILABLE'});assert.equal(h.calls.length,3);});
test('authorization errors and invalid responses fail without retries',async()=>{for(const response of [error('Error from server (Forbidden): forbidden'),{}]){const h=mock([response]);await assert.rejects(read(h.r,endpoint,h.options));assert.equal(h.calls.length,1);}});
test('cancellation stops the readiness reader',async()=>{const h=mock([error('Get "https://api.test/apis": EOF')]);h.r.signal={aborted:true};await assert.rejects(read(h.r,endpoint,h.options));assert.equal(h.calls.length,1);});
