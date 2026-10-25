'use strict';
async function inspect(adapter,c,key){
 const checkedAt=new Date().toISOString();
 try{
  const d=await adapter.detail(c,key),permissions=c.permissions||[];
  const options=['verify','revoke','delete'].map(action=>({action,available:d.capabilities?.[action]===true&&permissions.includes('credentials.'+action),reason:!permissions.includes('credentials.'+action)?'PERMISSION_DENIED':d.capabilities?.[action]!==true?(action==='revoke'?d.capabilities?.revocationReason:null)||'UNSUPPORTED_CREDENTIAL_OPERATION':null}));
  return {state:'checked',checkedAt,credentialId:key,persistence:'confirmed',status:d.status?.state||'not_checked',expiresAt:d.expiresAt||null,options,cryptographicVerification:'not_performed'};
 }catch(e){return {state:e.status===404?'pending':'blocked',checkedAt,credentialId:key,persistence:e.status===404?'not_yet_confirmed':'unknown',code:e.reason||e.code||'UPSTREAM_UNAVAILABLE',options:[]};}
}
function awaiting(stage){return {state:'pending',checkedAt:new Date().toISOString(),persistence:'not_yet_confirmed',stage,options:[]};}
module.exports={inspect,awaiting};
