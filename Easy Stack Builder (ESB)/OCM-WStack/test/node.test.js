'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {EventEmitter}=require('node:events');
function setup(operation) {
  let Constructor,credentials;const messages=[];
  const RED={nodes:{registerType:(name,ctor,options)=>{Constructor=ctor;credentials=options.credentials;},createNode(node){const emitter=new EventEmitter();node.on=emitter.on.bind(emitter);node.emit=emitter.emit.bind(emitter);node.status=()=>{};node.send=m=>messages.push(m);node.error=()=>{};node.credentials={kubeconfig:'private-kubeconfig'};}}};
  const box={module:{exports:{}},require:name=>{assert.equal(name,'./lib/install');return {operation};},AbortController};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ocmwstack.js'),'utf8'),box);box.module.exports(RED);
  return {node:new Constructor({procedureVersion:12,domainAddress:'example.com'}),messages,credentials};
}
test('node is inert until input; removal never calls teardown',async()=>{
  const calls=[];const h=setup(async(...args)=>{calls.push(args);return {status:'ready'};});
  assert.equal(calls.length,0);await new Promise(done=>h.node.emit('close',true,done));assert.equal(calls.length,0);
});
test('node ignores message configuration overrides and does not echo inbound credentials',async()=>{
  let observed;const h=setup(async(action,input,credentials,{emit})=>{observed={action,input,credentials};emit({type:'phase',phase:'tenant'});return {status:'ready'};});
  await new Promise((resolve,reject)=>h.node.emit('input',{action:'deploy',domainAddress:'evil.example',payload:{password:'inbound-secret'}},undefined,e=>e?reject(e):resolve()));
  assert.equal(observed.input.domainAddress,'example.com');assert.equal(observed.credentials.kubeconfig,'private-kubeconfig');assert.ok(!JSON.stringify(h.messages).includes('inbound-secret'));
  assert.equal(h.credentials.kubeconfig.type,'password');
});
test('closing an active node aborts local work and completes without cluster teardown',async()=>{
  const actions=[];let signal;
  const h=setup((action,input,credentials,options)=>{actions.push(action);signal=options.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled'))));});
  h.node.emit('input',{action:'deploy'},undefined,()=>{});
  await new Promise(done=>h.node.emit('close',true,done));assert.equal(signal.aborted,true);assert.deepEqual(actions,['deploy']);
});
