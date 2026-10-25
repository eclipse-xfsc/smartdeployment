'use strict';
const {fail}=require('./config');
const PROVIDERS=['auto','generic','hetzner','ionos','aws','azure','gcp','openstack','digitalocean','oci','scaleway','alibaba'];
const ids=[[/^(?:hcloud|hetzner):\/\//i,'hetzner'],[/^(?:ionos|ionoscloud|ionos-cloud):\/\//i,'ionos'],[/^aws:\/\//i,'aws'],[/^azure:\/\//i,'azure'],[/^gce:\/\//i,'gcp'],[/^openstack:\/\//i,'openstack'],[/^digitalocean:\/\//i,'digitalocean'],[/^oci:\/\//i,'oci'],[/^scaleway:\/\//i,'scaleway'],[/^alicloud:\/\//i,'alibaba']];
const regionZones={fsn1:'eu-central',nbg1:'eu-central',hel1:'eu-central',ash:'us-east',hil:'us-west',sin:'ap-southeast'};
function detect(nodes={},classes={}){
 const strong=new Set(),storage=new Set(),locations=new Set(),zones=new Set();
 for(const n of nodes.items||[]){
  const match=ids.find(([r])=>r.test(n.spec?.providerID||''));if(match)strong.add(match[1]);
  const labels=n.metadata?.labels||{};
  for(const key of Object.keys(labels)){if(key.startsWith('ionoscloud.com/')||key.startsWith('cloud.ionos.com/'))strong.add('ionos');if(key.startsWith('hcloud.hetzner.cloud/'))strong.add('hetzner');}
  const region=labels['topology.kubernetes.io/region']||labels['failure-domain.beta.kubernetes.io/region'];
  const zone=labels['topology.kubernetes.io/zone']||labels['failure-domain.beta.kubernetes.io/zone'];
  if(region)locations.add(region);if(zone)zones.add(zone);
 }
 for(const s of classes.items||[]){if(/ionos/i.test(s.provisioner||''))storage.add('ionos');if(/csi\.hetzner\.cloud/i.test(s.provisioner||''))storage.add('hetzner');}
 // Storage is corroborating fallback evidence. Mixed node providers are never
 // reduced to the provider of a shared storage driver.
 const found=strong.size?strong:storage;
 return {provider:found.size===1?[...found][0]:'generic',evidence:strong.size?'nodes':storage.size?'storage-provisioner':'unknown',mixed:found.size>1,locations:[...locations].sort(),zones:[...zones].sort()};
}
function annotations(c){
 if(c.actualProvider!=='hetzner'){
  if(Object.keys(c.lbAnnotations||{}).some(k=>k.startsWith('load-balancer.hetzner.cloud/')&&c.lbAnnotations[k]!==null))fail('PROVIDER_ANNOTATIONS','Hetzner annotations require the Hetzner cluster provider.');
  return {...c.lbAnnotations};
 }
 const a={'load-balancer.hetzner.cloud/protocol':'tcp','load-balancer.hetzner.cloud/health-check-protocol':'tcp','load-balancer.hetzner.cloud/uses-proxyprotocol':'false'};
 const location=c.lbLocation|| (c.providerLocations?.length===1?c.providerLocations[0]:'');
 const regionZone=c.providerLocations?.length===1&&['eu-central','us-east','us-west','ap-southeast'].includes(c.providerLocations[0])?c.providerLocations[0]:'';
 const topologyZone=c.providerZones?.length===1?regionZones[c.providerZones[0]]||'':'';
 const zone=c.lbNetworkZone||regionZones[location]||regionZone||topologyZone||(c.providerZones?.length===1&&['eu-central','us-east','us-west','ap-southeast'].includes(c.providerZones[0])?c.providerZones[0]:'');
 if(c.lbLocation)a['load-balancer.hetzner.cloud/location']=c.lbLocation;
 else if(zone)a['load-balancer.hetzner.cloud/network-zone']=zone;
 if(!zone&&!c.lbLocation&&!c.lbAnnotations?.['load-balancer.hetzner.cloud/location']&&!c.lbAnnotations?.['load-balancer.hetzner.cloud/network-zone'])fail('PROVIDER_LOCATION','Hetzner location/network zone is ambiguous. Select a load-balancer location or network zone in the node editor.');
 if(c.lbNetworkZone){delete a['load-balancer.hetzner.cloud/location'];a['load-balancer.hetzner.cloud/network-zone']=c.lbNetworkZone;}
 if(c.lbType)a['load-balancer.hetzner.cloud/type']=c.lbType;
 a['load-balancer.hetzner.cloud/use-private-ip']=String(Boolean(c.lbPrivate));
 a['load-balancer.hetzner.cloud/disable-private-ingress']=String(Boolean(c.lbPrivate));
 return {...a,...c.lbAnnotations};
}
module.exports={PROVIDERS,detect,annotations,regionZones};
