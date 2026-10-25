'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {install,preflight,seedAdmins}=require('../lib/dashboards');
const fs=require('node:fs/promises');
test('dashboard toggle off only removes its routing release and leaves services, secrets and data intact',async()=>{
 const commands=[];const r={emit(){},json:async(cmd,args)=>{assert.equal(cmd,'helm');return [{name:'esb-dashboard-routes'}];},run:async(cmd,args)=>commands.push([cmd,...args])};
 assert.deepEqual(await install(r,{publicDashboards:false,timeoutSeconds:60},{},null,'/tmp'),{public:false});
 assert.deepEqual(commands,[['helm','uninstall','esb-dashboard-routes','-n','infrastructure','--timeout','60s']]);
});
test('first dashboard initialization patches both passwords from private files then records completion',async()=>{
 const password='test-password-long-enough',files=[],patches=[],commands=[];
 const r={json:async(cmd,args)=>args.includes('deployments')?{items:[{metadata:{name:'grafana'},spec:{template:{spec:{containers:[{name:'grafana',env:[{name:'GF_SECURITY_ADMIN_PASSWORD',valueFrom:{secretKeyRef:{name:'grafana-secret',key:'admin-password'}}}]}]}}}}]}:null,
 run:async(cmd,args,options)=>{
  commands.push(args);
  if(args.includes('--patch-file')){const file=args[args.indexOf('--patch-file')+1];files.push(file);patches.push(JSON.parse(await fs.readFile(file,'utf8')));assert.equal(options,undefined);}
  if(args.includes('exec'))assert.equal(options.input,password+'\n');
  if(args.includes('apply'))assert.equal(JSON.parse(options.input).data.initialized,'true');
  return {stdout:''};
 }};
 await seedAdmins(r,{}, {editorPassword:password});
 assert.equal(patches.length,2);
 assert.equal(await require('bcryptjs').compare(password,patches[0].stringData['admin.password']),true);
 assert.equal(patches[1].stringData['admin-password'],password);
 assert.equal(commands.at(-1)[0],'apply');
 for(const file of files)await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('dashboard patch failure cleans up and does not mark initialization complete',async()=>{
 let file,writes=0;
 const r={json:async()=>null,run:async(cmd,args)=>{writes++;file=args[args.indexOf('--patch-file')+1];throw Object.assign(new Error('test failure'),{code:'COMMAND_FAILED'});}};
 await assert.rejects(seedAdmins(r,{}, {editorPassword:'test-password-long-enough'}),{code:'COMMAND_FAILED'});
 assert.equal(writes,1);await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('public dashboard credentials and ownership are checked before any write',async()=>{
 let writes=0;const r={json:async()=>null,run:async()=>writes++};await assert.rejects(preflight(r,{publicDashboards:true},{}),{code:'DASHBOARD_CREDENTIALS'});assert.equal(writes,0);
 r.json=async()=>({data:{initialized:'true'},metadata:{labels:{}}});await assert.rejects(preflight(r,{publicDashboards:true},{}),{code:'OWNERSHIP'});
 r.json=async()=>({data:{initialized:'true'},metadata:{labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack'}}});await preflight(r,{publicDashboards:true},{});await seedAdmins(r,{},{});assert.equal(writes,0);
});
