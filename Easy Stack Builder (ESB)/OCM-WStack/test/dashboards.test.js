'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {install,preflight,seedAdmins}=require('../lib/dashboards');
test('dashboard toggle off only removes its routing release and leaves services, secrets and data intact',async()=>{
 const commands=[];const r={emit(){},json:async(cmd,args)=>{assert.equal(cmd,'helm');return [{name:'esb-dashboard-routes'}];},run:async(cmd,args)=>commands.push([cmd,...args])};
 assert.deepEqual(await install(r,{publicDashboards:false,timeoutSeconds:60},{},null,'/tmp'),{public:false});
 assert.deepEqual(commands,[['helm','uninstall','esb-dashboard-routes','-n','infrastructure','--timeout','60s']]);
});
test('public dashboard credentials and ownership are checked before any write',async()=>{
 let writes=0;const r={json:async()=>null,run:async()=>writes++};await assert.rejects(preflight(r,{publicDashboards:true},{}),{code:'DASHBOARD_CREDENTIALS'});assert.equal(writes,0);
 r.json=async()=>({data:{initialized:'true'},metadata:{labels:{}}});await assert.rejects(preflight(r,{publicDashboards:true},{}),{code:'OWNERSHIP'});
 r.json=async()=>({data:{initialized:'true'},metadata:{labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack'}}});await preflight(r,{publicDashboards:true},{});await seedAdmins(r,{},{});assert.equal(writes,0);
});
