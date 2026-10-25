'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {upgrade,transportFailure,diagnose,delay}=require('../lib/api-recovery');
const EOF='Post "https://api.example.test/apis/rbac.authorization.k8s.io/v1/clusterrolebindings?fieldManager=helm": EOF';
const error=text=>Object.assign(new Error(text),{code:'COMMAND_FAILED',commandOutput:text});
const args=['upgrade','--install','kyverno','./INFRA/security/kyverno','-n','security','--timeout','1800s'];
function harness({errors=[],statuses=[],readyErrors=[],otherHolder=false}={}) {
  let status='absent',writes=0;const calls=[],events=[],pauses=[];
  const r={env:{ESB_LEASE_HOLDER:'owner'},redact:String,emit:e=>events.push(e),
    async run(cmd,a,options){
      calls.push({cmd,args:a,options});
      if(cmd==='kubectl') {const e=readyErrors.shift();if(e)throw e;return {code:0,stdout:'ok\n'};}
      if(a[0]==='status') {
        const current=statuses.length?statuses.shift():status;
        if(current instanceof Error)return {code:1,stdout:'',stderr:current.message};
        return current==='absent'?{code:1,stdout:'',stderr:'Error: release: not found'}:{code:0,stdout:JSON.stringify({info:{status:current}})};
      }
      assert.deepEqual(a,args);writes++;
      const e=errors.shift();status=e?'failed':'deployed';if(e)throw e;return {code:0,stdout:'installed'};
    },
    async json(cmd,a,options){calls.push({cmd,args:a,options});return {spec:{holderIdentity:otherHolder?'someone-else':'owner',renewTime:new Date().toISOString(),leaseDurationSeconds:180}};}
  };
  return {r,calls,events,pauses,get writes(){return writes;},options:{namespace:'security',release:'kyverno',timeout:1800000,sleep:async ms=>pauses.push(ms)}};
}
test('API transport classification excludes template EOF and mixed permanent failures',()=>{
  for(const text of [EOF,'Patch "https://api.test/a": connection reset by peer','Unable to connect to the server: EOF','Error from server (ServiceUnavailable): unavailable'])assert.equal(transportFailure(error(text)),true,text);
  for(const text of ['template: file: unexpected EOF',EOF+'\nError: pods is forbidden: exceeded quota',EOF+'\nValidation failed', 'context deadline exceeded','nil pointer evaluating interface {}.enabled'])assert.equal(transportFailure(error(text)),false,text);
  assert.equal(transportFailure({...error(EOF),code:'TIMEOUT'}),false);
});
test('partial failed installation retries the same release only after API, state and owner checks',async()=>{
  const h=harness({errors:[error(EOF)]});await upgrade(h.r,args,h.options);
  assert.equal(h.writes,2);assert.deepEqual(h.pauses,[5000]);
  assert.deepEqual(h.events.filter(e=>e.type==='helm-state').map(e=>e.status),['absent','failed']);
  const sequence=h.calls.map(c=>c.cmd==='helm'?c.args[0]:c.args.includes('lease')?'lease':'ready');
  assert.deepEqual(sequence,['ready','status','lease','upgrade','ready','status','lease','upgrade','status']);
});
test('pending Helm state after an ambiguous API write stops without another write',async()=>{
  const h=harness({errors:[error(EOF)],statuses:['absent','pending-install']});
  await assert.rejects(upgrade(h.r,args,h.options),{code:'HELM_PENDING'});assert.equal(h.writes,1);
});
test('persistent API transport failure has a strict three-attempt limit',async()=>{
  const h=harness({errors:[error(EOF),error(EOF),error(EOF)]});
  await assert.rejects(upgrade(h.r,args,h.options),{code:'API_TRANSPORT'});
  assert.equal(h.writes,3);assert.deepEqual(h.pauses,[5000,15000]);
});
test('unreachable API, unreadable release state and lost ownership never permit writes',async()=>{
  const unavailable=harness({readyErrors:[error(EOF),error(EOF),error(EOF)]});
  await assert.rejects(upgrade(unavailable.r,args,unavailable.options),{code:'API_TRANSPORT'});assert.equal(unavailable.writes,0);
  const state=harness({statuses:[error(EOF),error(EOF),error(EOF)]});
  await assert.rejects(upgrade(state.r,args,state.options),{code:'API_TRANSPORT'});assert.equal(state.writes,0);
  const owner=harness({otherHolder:true});await assert.rejects(upgrade(owner.r,args,owner.options),{code:'LEASE_LOST'});assert.equal(owner.writes,0);
});
test('permanent errors are not retried and successful commands require a deployed Helm record',async()=>{
  const bad=harness({errors:[error('template: unexpected EOF')]});await assert.rejects(upgrade(bad.r,args,bad.options),{code:'COMMAND_FAILED'});assert.equal(bad.writes,1);assert.deepEqual(bad.pauses,[]);
  const unconfirmed=harness({statuses:['absent','failed']});await assert.rejects(upgrade(unconfirmed.r,args,unconfirmed.options),{code:'HELM_STATE_UNAVAILABLE'});assert.equal(unconfirmed.writes,1);
});
test('cancellation interrupts retry backoff',async()=>{
  const controller=new AbortController();const p=delay(60000,controller.signal);controller.abort();await assert.rejects(p,{code:'CANCELLED'});
});
test('diagnosis samples only API readiness and reports intermittent failure',async()=>{
  const h=harness({readyErrors:[null,error(EOF)]});
  const result=await diagnose(h.r,{samples:3,sleep:async()=>{}});
  assert.equal(result.status,'api-unreliable');assert.deepEqual(result.checks.map(c=>c.ok),[true,false,true]);assert.equal(h.writes,0);
  assert.ok(h.calls.every(c=>c.cmd==='kubectl'&&c.args[0]==='get'&&c.args.includes('--raw=/readyz')));
});
