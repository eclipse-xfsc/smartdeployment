'use strict';
// No bearer and no idempotency key: exercise parsing + authentication without
// dispatching issuance or touching any credential, user or relationship.
async function checks(origin,{requester,signal}){
 return Promise.all(['POST','PATCH','DELETE'].map(async method=>{
  const name='ui-json-'+method.toLowerCase();
  try{
   const path=method==='POST'?'/issuance':method==='PATCH'?'/preferences':'/credentials/esb-auth-probe';
   const r=await requester(origin+'/orce/ui-api/v1'+path,{method,body:{},signal});
   return {name,httpStatus:r.status,ok:r.status===401&&r.data?.error?.code==='AUTHENTICATION_REQUIRED',code:r.data?.error?.code||'API_INVALID_RESPONSE'};
  }catch{return {name,ok:false,code:'API_UNREACHABLE'};}
 }));
}
module.exports={checks};
