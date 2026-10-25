'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {cleanEnvironment,selection,bind}=require('../lib/kube-client');
const {Runner}=require('../lib/runner');
function config(auth={token:'redacted'}){return {'current-context':'uploaded-context',contexts:[{name:'uploaded-context',context:{user:'uploaded-user',cluster:'uploaded-cluster'}}],users:[{name:'uploaded-user',user:auth}],clusters:[{name:'uploaded-cluster',cluster:{server:'https://uploaded.example.test'}}]};}
test('inherited Helm authentication overrides are removed',()=>{assert.deepEqual(cleanEnvironment({PATH:'path',HELM_KUBETOKEN:'pod-token',HELM_KUBECONTEXT:'ambient',HELM_KUBEASUSER:'pod',ESB_KUBECONFIG:'ambient',HELM_QPS:'5'}),{PATH:'path',HELM_QPS:'5'});});
test('missing upload credentials or context fail without in-cluster fallback',()=>{assert.throws(()=>selection(config({})),{code:'KUBECONFIG_AUTH'});const doc=config();doc['current-context']='absent';assert.throws(()=>selection(doc),{code:'KUBECONFIG_CONTEXT'});});
test('workstation credential file paths are rejected',()=>{assert.throws(()=>selection(config({tokenFile:'/workstation/token'})),{code:'KUBECONFIG_FILES'});});
test('explicit uploaded tokens, certificate pairs and auth plugins are accepted',()=>{for(const [auth,method] of [[{token:'redacted'},'token'],[{'client-certificate-data':'DATA','client-key-data':'DATA'},'client-certificate'],[{exec:{command:'provider-cli'}},'exec-plugin']])assert.equal(selection(config(auth)).authentication,method);});
test('shell and nested helpers pin the uploaded file/context and cannot override credentials',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-kube-binding-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const bin=path.join(dir,'real-bin');await fs.mkdir(bin);
 const doc=config();
 for(const name of ['kubectl','helm'])await fs.writeFile(path.join(bin,name),`#!/usr/bin/env node
const args=process.argv.slice(2);if(args.includes('view'))console.log(${JSON.stringify(JSON.stringify(doc))});else console.log(JSON.stringify({args,config:process.env.KUBECONFIG,token:process.env.HELM_KUBETOKEN}));
`,{mode:0o700});
 const file=path.join(dir,'uploaded');await fs.writeFile(file,'exact uploaded bytes');
 const r=new Runner({cwd:dir,env:{...process.env,PATH:bin+':'+process.env.PATH,HELM_KUBETOKEN:'ambient-token',HELM_KUBECONTEXT:'wrong'}});
 await bind(r,dir,file,'exact uploaded bytes');
 for(const command of ['kubectl','helm']){
  const result=JSON.parse((await r.run('bash',['-c',`"$1" get harmless`,'nested',command])).stdout);
  assert.equal(result.args[0],'--kubeconfig');assert.equal(result.args[1],file);assert.equal(result.args[3],'uploaded-context');assert.equal(result.token,undefined);
 }
 await assert.rejects(r.run('kubectl',['--token=ambient-token','get','pods']),{code:'COMMAND_FAILED'});
 await fs.rm(file);await assert.rejects(r.run('kubectl',['get','pods']),{code:'COMMAND_FAILED'});
});
