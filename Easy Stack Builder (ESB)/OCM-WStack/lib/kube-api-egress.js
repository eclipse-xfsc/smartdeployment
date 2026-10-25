'use strict';
const net=require('node:net');
const {fail}=require('./config');
function validPort(port){return Number.isInteger(port)&&port>0&&port<=65535;}
function rules(service,slices,endpoints){
  if(service?.metadata?.name!=='kubernetes'||service.metadata.namespace!=='default')fail('GUARD_API_SERVICE','Expected the default/kubernetes Service.');
  const ports=service.spec?.ports||[],https=ports.filter(p=>(p.protocol||'TCP')==='TCP'&&(p.name==='https'||ports.length===1));
  if(https.length!==1||!validPort(https[0].port))fail('GUARD_API_SERVICE','Kubernetes API Service has no unambiguous TCP HTTPS port.');
  const port=https[0],ips=[...new Set([service.spec.clusterIP,...(service.spec.clusterIPs||[])].filter(Boolean))];
  if(!ips.length||ips.some(ip=>!net.isIP(ip)))fail('GUARD_API_SERVICE','Kubernetes API Service has no valid ClusterIP.');
  const peers=new Map(),backends=new Map();
  function add(map,ip,value){if(!net.isIP(ip)||!validPort(value))fail('GUARD_API_ENDPOINTS','Kubernetes API backend address or port is invalid.');if(!map.has(value))map.set(value,new Set());map.get(value).add(ip);}
  const matches=p=>(p.protocol||'TCP')==='TCP'&&p.name===port.name;
  for(const slice of slices?.items||[]){
    if(slice.metadata?.namespace!=='default'||slice.metadata?.labels?.['kubernetes.io/service-name']!=='kubernetes'||!['IPv4','IPv6'].includes(slice.addressType))continue;
    const selected=(slice.ports||[]).filter(matches);
    for(const endpoint of slice.endpoints||[]){
      if(endpoint.conditions?.ready===false||endpoint.conditions?.terminating===true)continue;
      for(const ip of endpoint.addresses||[])for(const p of selected){if(net.isIP(ip)!==(slice.addressType==='IPv4'?4:6))fail('GUARD_API_ENDPOINTS','Kubernetes API EndpointSlice address family is invalid.');add(backends,ip,p.port);}
    }
  }
  // Some managed API Services explicitly disable legacy EndpointSlice mirroring.
  // Fall back only when no usable slice backend was found; never guess a port.
  if(!backends.size&&endpoints){
    if(endpoints.metadata?.name!=='kubernetes'||endpoints.metadata.namespace!=='default')fail('GUARD_API_ENDPOINTS','Expected default/kubernetes Endpoints.');
    for(const subset of endpoints.subsets||[])for(const ip of subset.addresses||[])for(const p of (subset.ports||[]).filter(matches))add(backends,ip.ip,p.port);
  }
  if(!backends.size)fail('GUARD_API_ENDPOINTS_PENDING','No ready Kubernetes API backend address and TCP port were discovered.');
  for(const ip of ips)add(peers,ip,port.port);
  for(const [value,addresses] of backends)for(const ip of addresses)add(peers,ip,value);
  return [...peers].sort(([a],[b])=>a-b).map(([value,addresses])=>({to:[...addresses].sort().map(ip=>({ipBlock:{cidr:ip+'/'+(net.isIP(ip)===6?128:32)}})),ports:[{protocol:'TCP',port:value}]}));
}
async function discover(r){
  const [service,slices]=await Promise.all([
    r.json('kubectl',['-n','default','get','service','kubernetes','-o','json'],{timeout:20000}),
    r.json('kubectl',['-n','default','get','endpointslices.discovery.k8s.io','-l','kubernetes.io/service-name=kubernetes','-o','json'],{timeout:20000})
  ]);
  try{return rules(service,slices);}catch(e){if(e.code!=='GUARD_API_ENDPOINTS_PENDING')throw e;}
  const endpoints=await r.json('kubectl',['-n','default','get','endpoints','kubernetes','-o','json'],{timeout:20000});
  return rules(service,slices,endpoints);
}
module.exports={rules,discover};
