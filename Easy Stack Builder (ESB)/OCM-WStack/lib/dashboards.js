'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {fail}=require('./config'),{upgrade}=require('./api-recovery'),tls=require('./tls');
const {privatePatch}=require('./private-patch');
const get=(r,kind,name,ns)=>r.json('kubectl',['-n',ns,'get',kind,name,'--ignore-not-found','-o','json']);
async function preflight(r,c,credentials){
 if(!c.publicDashboards)return;
 const marker=await get(r,'configmap','esb-dashboard-access','infrastructure');
 if(marker&&marker.metadata?.labels?.['app.kubernetes.io/managed-by']!=='esb-ocmwstack')fail('OWNERSHIP','Dashboard initialization marker is not managed by this deployer.');
 if(marker?.data?.initialized!=='true'&&(typeof credentials.editorPassword!=='string'||credentials.editorPassword.length<12))fail('DASHBOARD_CREDENTIALS','The initial editor password is required to enable dashboard access.');
}
async function seedAdmins(r,c,credentials,grafana){
 const marker=await get(r,'configmap','esb-dashboard-access','infrastructure');
 if(marker?.data?.initialized==='true')return;
 if(typeof credentials.editorPassword!=='string'||credentials.editorPassword.length<12)fail('DASHBOARD_CREDENTIALS','The initial editor password is required to enable dashboard access.');
 const hash=await require('bcryptjs').hash(credentials.editorPassword,12);
 await privatePatch(r,['-n','argocd','patch','secret','argocd-secret','--type=merge'],{stringData:{'admin.password':hash,'admin.passwordMtime':new Date().toISOString()}});
 const deployments=await r.json('kubectl',['-n','observability','get','deployments','-l','app.kubernetes.io/name=grafana,app.kubernetes.io/instance=observability','-o','json']);
 if(deployments.items?.length!==1)fail('DASHBOARD_DISCOVERY','Expected one Grafana deployment.');
 const deployment=deployments.items[0];
 const ref=deployment.spec?.template?.spec?.containers?.find(x=>x.name==='grafana')?.env?.find(x=>x.name==='GF_SECURITY_ADMIN_PASSWORD')?.valueFrom?.secretKeyRef;
 if(ref?.name&&ref.key)await privatePatch(r,['-n','observability','patch','secret',ref.name,'--type=merge'],{stringData:{[ref.key]:credentials.editorPassword}});
 await r.run('kubectl',['-n','observability','exec','-i','deployment/'+deployment.metadata.name,'-c','grafana','--','grafana','cli','--homepath','/usr/share/grafana','--config','/etc/grafana/grafana.ini','admin','reset-admin-password','--password-from-stdin'],{input:credentials.editorPassword+'\n',timeout:120000});
 await r.run('kubectl',['apply','-f','-'],{input:JSON.stringify({apiVersion:'v1',kind:'ConfigMap',metadata:{name:'esb-dashboard-access',namespace:'infrastructure',labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack'}},data:{initialized:'true',username:'admin'}})});
}
async function install(r,c,credentials,material,directory){
 r.emit({type:'phase',phase:'dashboard-access'});
 const release='esb-dashboard-routes';
 const existing=await r.json('helm',['list','-n','infrastructure','-a','--filter','^'+release+'$','-o','json']);
 if(!c.publicDashboards){
  if(existing.length)await r.run('helm',['uninstall',release,'-n','infrastructure','--timeout',`${c.timeoutSeconds}s`],{timeout:(c.timeoutSeconds+30)*1000});
  return {public:false};
 }
 const services=await r.json('kubectl',['-n','observability','get','services','-l','app.kubernetes.io/name=grafana,app.kubernetes.io/instance=observability','-o','json']);
 if(services.items?.length!==1)fail('DASHBOARD_DISCOVERY','Expected one Grafana Service.');
 const grafana=services.items[0],port=grafana.spec.ports.find(p=>p.name==='http-web')||grafana.spec.ports.find(p=>p.port===80)||grafana.spec.ports[0];
 const argo=await get(r,'service','argocd-server','argocd');
 if(!argo?.spec?.ports?.some(p=>p.port===80))fail('DASHBOARD_DISCOVERY','Argo CD HTTP Service port is unavailable.');
 // Envoy terminates trusted TLS. Argo serves HTTP only inside the cluster.
 const params=await get(r,'configmap','argocd-cmd-params-cm','argocd');
 if(params?.data?.['server.insecure']!=='true'){
  await r.run('kubectl',['-n','argocd','patch','configmap','argocd-cmd-params-cm','--type=merge','-p',JSON.stringify({data:{'server.insecure':'true'}})]);
  await r.run('kubectl',['-n','argocd','rollout','restart','deployment/argocd-server']);
  await r.run('kubectl',['-n','argocd','rollout','status','deployment/argocd-server',`--timeout=${c.timeoutSeconds}s`],{timeout:(c.timeoutSeconds+30)*1000});
 }
 await seedAdmins(r,c,credentials,grafana);
 for(const ns of ['argocd','observability'])await tls.install(r,c,material,ns);
 const values={tlsSecret:tls.secretName(c),services:[{name:'argocd',namespace:'argocd',host:'argocd.'+c.domain,service:'argocd-server',port:80},{name:'grafana',namespace:'observability',host:'grafana.'+c.domain,service:grafana.metadata.name,port:port.port}]};
 const file=path.join(directory,'dashboards.json');await fs.writeFile(file,JSON.stringify(values),{mode:0o600});
 await upgrade(r,['upgrade','--install',release,path.join(__dirname,'../charts-dashboards'),'-n','infrastructure','-f',file,'--timeout',`${c.timeoutSeconds}s`],{namespace:'infrastructure',release,timeout:(c.timeoutSeconds+30)*1000});
 for(const s of values.services)await r.run('kubectl',['-n',s.namespace,'wait','--for=condition=Programmed','listenerset/esb-'+s.name,`--timeout=${c.timeoutSeconds}s`],{timeout:(c.timeoutSeconds+30)*1000});
 return {public:true,username:'admin',initialPassword:'Configured editor initial password; retained on subsequent deployments.',argocd:'https://argocd.'+c.domain,grafana:'https://grafana.'+c.domain};
}
module.exports={install,seedAdmins,preflight};
