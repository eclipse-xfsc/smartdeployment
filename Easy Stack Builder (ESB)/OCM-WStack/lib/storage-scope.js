'use strict';
const {fail}=require('./config');
function scope(region='EU',country='DE'){
 for(const [name,value] of Object.entries({region,country}))if(typeof value!=='string'||!value||value==='.'||value==='..'||/[\/\\\x00-\x1f]/.test(value))fail('STORAGE_SCOPE','Invalid native Storage '+name+'.');
 return {storageRegion:region,storageCountry:country};
}
async function discover(r,c){
 const deployment=await r.json('kubectl',['-n','ocm-wstack','get','deployment','credential-retrieval-service','--ignore-not-found','-o','json']);
 const env=(deployment?.spec?.template?.spec?.containers||[]).find(x=>x.name==='credential-retrieval-service')?.env||[];
 const read=(key,fallback)=>{
  const item=env.find(x=>x.name==='CREDENTIALRETRIEVAL_'+key);
  if(item?.valueFrom)fail('STORAGE_SCOPE','Retrieval '+key+' uses an indirect value; resolve its configured geography before changing the OCM Storage scope.');
  return item?.value||fallback;
 };
 const values=scope(read('REGION',c.storageRegion||'EU'),read('COUNTRY',c.storageCountry||'DE'));
 Object.assign(c,values);r.emit({type:'storage-scope',...values,source:deployment?'retrieval-deployment':'upstream-defaults'});
 return values;
}
module.exports={scope,discover};
