'use strict';
const dns=new (require('node:dns/promises').Resolver)({timeout:2000,tries:2});
const {setTimeout:sleep}=require('node:timers/promises');
const {fail}=require('./config');
async function addresses(host){const values=await Promise.allSettled([dns.resolve4(host),dns.resolve6(host)]);return values.flatMap(v=>v.status==='fulfilled'?v.value:[]);}
async function waitDns(r,c,{resolve=addresses,now=Date.now,pause=sleep}={}){
 const start=now(),hosts=[c.tenantHost,...(c.publicDashboards?['argocd.'+c.domain,'grafana.'+c.domain]:[])];
 while(true){
  const service=await require('./gateway-routing').publicService(r),targets=(service.status?.loadBalancer?.ingress||[]).map(x=>x.ip||x.hostname);
  const targetIps=[...new Set((await Promise.all(targets.map(t=>require('node:net').isIP(t)?[t]:resolve(t)))).flat())];
  const records=await Promise.all(hosts.map(async hostname=>{const ips=await resolve(hostname);return {hostname,addresses:ips,ready:ips.length>0&&ips.every(ip=>targetIps.includes(ip))};}));
  r.emit({type:'dns-progress',phase:'public-dns',automatic:c.externalDns,targets,records,elapsedSeconds:Math.floor((now()-start)/1000),message:records.every(x=>x.ready)?'DNS points to this gateway':'Waiting for DNS records to match the current gateway; stale A/AAAA records also need to be removed.'});
  if(targetIps.length&&records.every(x=>x.ready))return records;
  if(now()-start>=c.timeoutSeconds*1000)fail('DNS_NOT_READY','DNS does not point only to the current gateway ('+targets.join(', ')+'). The deployed tenant, TLS and UI are retained. Required hostnames: '+hosts.join(', ')+'.');
  await pause(Math.min(10000,c.timeoutSeconds*1000-(now()-start)),undefined,{signal:r.signal});
 }
}
module.exports={addresses,waitDns};
