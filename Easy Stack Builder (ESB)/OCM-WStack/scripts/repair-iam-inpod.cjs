'use strict';
// Runs in the ORCE pod. Admin password arrives only through stdin.
const {request}=require('/data/lib/http.cjs');
const config=require('/data/lib/config.cjs').load();
const {adminPassword}=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
(async()=>{
 const base=config.keycloakInternal;
 const token=await request(base+'/realms/master/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:'admin',password:adminPassword}).toString()});
 const call=(path,method='GET',body)=>request(base+'/admin/realms/'+encodeURIComponent(config.realm)+path,{method,body,headers:{authorization:'Bearer '+token.access_token}});
 const client=async name=>{const result=await call('/clients?clientId='+encodeURIComponent(name));if(result.length!==1)throw Error('Expected one Keycloak client: '+name);return result[0];};
 const backend=await client(config.adminClientId),realm=await client('realm-management');
 const needed=['query-users','view-users','manage-users','view-clients','manage-clients'];
 const roles=(await call('/clients/'+realm.id+'/roles')).filter(r=>needed.includes(r.name));
 if(roles.length!==needed.length)throw Error('Required realm-management roles are missing');
 const sa=await call('/clients/'+backend.id+'/service-account-user');
 await call('/users/'+sa.id+'/role-mappings/clients/'+realm.id,'POST',roles);
 await call('/clients/'+backend.id+'/scope-mappings/clients/'+realm.id,'POST',roles);
 const verify=await request(base+'/realms/'+encodeURIComponent(config.realm)+'/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:config.adminClientId,client_secret:config.adminClientSecret}).toString()});
 // The admin API validates the freshly issued token; never print the token.
 await request(base+'/admin/realms/'+encodeURIComponent(config.realm)+'/clients?clientId='+encodeURIComponent(config.clientId),{headers:{authorization:'Bearer '+verify.access_token}});
 console.log('Keycloak backend assignments and token scopes repaired; admin API verified.');
})().catch(e=>{console.error('IAM repair failed: '+(e.code||e.message)+(e.upstreamStatus?' HTTP '+e.upstreamStatus:''));process.exitCode=1;});
