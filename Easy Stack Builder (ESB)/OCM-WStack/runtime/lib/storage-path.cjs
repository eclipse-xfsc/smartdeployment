'use strict';
// Storage 1.2.5 retains microservice-core-go's /v1/tenants/:tenantId
// prefix and adds geography inside /storage. Defaults match upstream Retrieval.
function credentialsPath(c) {
 const region=c.storageRegion||'EU', country=c.storageCountry||'DE';
 for(const [name,value] of Object.entries({tenant:c.tenant,account:c.account,region,country})) {
  if(typeof value!=='string'||!value||value==='.'||value==='..'||/[\/\\\x00-\x1f]/.test(value))throw new Error('Invalid Storage '+name);
 }
 return '/v1/tenants/'+[c.tenant,'storage',region,country,c.account,'credentials'].map(encodeURIComponent).join('/');
}
module.exports={credentialsPath};
