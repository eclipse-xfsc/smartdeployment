'use strict';
const {fail}=require('./config');
// Keep every native route from the checked deployment revision, changing only
// DIDComm's unusable root route. Never publish its unauthenticated /admin API.
function values(c,defaults){
 if(!Array.isArray(defaults.routes))fail('TENANT_ROUTES','Deployment tenant routes are missing.');
 const routes=defaults.routes.map(route=>route.name==='didcomm'?{...route,enabled:false}:route);
 if(c.runtimeEnabled&&!c.runtimeServices?.didcomm)routes.push({name:'didcomm-message',method:'POST',path:'/api/didcomm/message/receive',pathType:'Exact',targetPath:'/message/receive',backend:{name:'didcomm-connector',port:9090}});
 return {certificate:{enabled:false,secretName:require('./tls').secretName(c)},tenant:{domain:c.domain,id:c.tenantId,group:c.tenantId,subdomain:c.tenantSubdomain},openbao:{transit:{mountPath:`ocm-wstack/${c.tenantId}`}},routes};
}
module.exports={values};
