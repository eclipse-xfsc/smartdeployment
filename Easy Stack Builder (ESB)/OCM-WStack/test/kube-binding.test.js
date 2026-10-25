'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Runner}=require('../lib/runner'),{boundCommand,bind}=require('../lib/kube-client');

async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'esb-binding-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const ambient=path.join(dir,'ambient');await fs.mkdir(ambient);
  const real=path.join(dir,'real-cli');
  await fs.writeFile(real,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const file=args[args.indexOf('--kubeconfig')+1];if(!file||!fs.existsSync(file)){console.error('uploaded kubeconfig missing');process.exit(1);}if(args.includes('view'))console.log(JSON.stringify({'current-context':'uploaded-context',contexts:[{name:'uploaded-context',context:{user:'admin',cluster:'cluster'}}],users:[{name:'admin',user:{token:'test'}}],clusters:[{name:'cluster',cluster:{server:'https://cluster.example'}}]}));else if(args.some(a=>a.startsWith('--raw=/apis/argoproj.io')))console.log(JSON.stringify({items:[]}));else console.log(JSON.stringify({args}));\n`,{mode:0o700});
  for(const command of ['kubectl','helm'])await fs.writeFile(path.join(ambient,command),`#!${process.execPath}\nconsole.error('ambient service account must not be used');process.exit(91);\n`,{mode:0o700});
  const config=path.join(dir,'uploaded-config');await fs.writeFile(config,'test-only');
  const env={...process.env,PATH:ambient+':/usr/bin:/bin',KUBECONFIG:'/ambient/config',ESB_KUBECONFIG:config,ESB_KUBE_CONTEXT:'uploaded-context',ESB_REAL_KUBECTL:real,ESB_REAL_HELM:real};
  return {dir,config,env};
}

test('Runner pins kubectl and Helm to uploaded credentials even with ambient PATH/KUBECONFIG',async t=>{
  const {env,config}=await fixture(t);const r=new Runner({env});
  for(const command of ['kubectl','helm']) {
    const result=await r.json(command,['version']);
    assert.deepEqual(result.args,['--kubeconfig',config,command==='kubectl'?'--context':'--kube-context','uploaded-context','version']);
  }
});

test('real readiness helper inherits direct binding when PATH cannot find the ESB wrappers',async t=>{
  const {env}=await fixture(t),r=new Runner({env});
  const result=await r.json(process.execPath,[path.join(__dirname,'../scripts/kube-read.js'),'/apis/argoproj.io/v1alpha1/namespaces/argocd/applications']);
  assert.deepEqual(result,{items:[]});
});

test('missing uploaded file cannot fall back to ambient credentials',async t=>{
  const {env,config}=await fixture(t);await fs.unlink(config);
  await assert.rejects(new Runner({env}).run('kubectl',['version']),e=>e.code==='COMMAND_FAILED'&&e.message.includes('uploaded kubeconfig missing'));
});

test('partial binding and explicit credential/server overrides fail before spawn',async t=>{
  const {env}=await fixture(t);
  await assert.rejects(new Runner({env:{...env,ESB_REAL_KUBECTL:''}}).run('kubectl',['version']),{code:'KUBECONFIG_BINDING'});
  for(const args of [['--context','other'],['--token=other'],['--as','other'],['-shttps://other'],['-s','https://other']])await assert.rejects(new Runner({env}).run('kubectl',args),{code:'KUBECONFIG_OVERRIDE'});
  await assert.rejects(new Runner({env}).run('helm',['--kube-context=other']),{code:'KUBECONFIG_OVERRIDE'});
});

test('normal non-Kubernetes commands and unbound diagnostic runners retain their arguments',()=>{
  for(const command of ['bash','git','kubectl','helm'])assert.deepEqual(boundCommand(command,['version'],{}),{command,args:['version']});
});

test('shell wrappers also pin credentials and reject kubectl server shorthand',async t=>{
  const {dir,config,env}=await fixture(t);
  // Bind resolves the original executables client-side, then generates wrappers.
  const initial={...env};for(const key of Object.keys(initial))if(key.startsWith('ESB_'))delete initial[key];
  const realBin=path.join(dir,'bin');await fs.mkdir(realBin);
  for(const command of ['kubectl','helm'])await fs.symlink(env.ESB_REAL_KUBECTL,path.join(realBin,command));
  initial.PATH=realBin+':/usr/bin:/bin';const r=new Runner({env:initial});
  await bind(r,dir,config,'test-only');
  const result=await r.json('/bin/bash',['-c','kubectl version']);
  assert.equal(result.args[1],config);assert.equal(result.args[3],'uploaded-context');
  await assert.rejects(r.run('/bin/bash',['-c','kubectl -shttps://other version']),e=>e.code==='COMMAND_FAILED'&&e.message.includes('cannot override'));
});
