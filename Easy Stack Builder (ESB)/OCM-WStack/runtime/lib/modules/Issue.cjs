'use strict';
const { fail, object } = require('../errors.cjs');
module.exports = {
  actions: ["refresh", "types", "createType", "updateType", "deleteType", "issue", "job"],
  async execute(action, c, key, body, q, requestId) {
    const a = this.adapters;
    const scope = {tenant:c.tenant,subject:c.subject};
    switch(action) {
      case 'refresh':fail(503,'NATIVE_REFRESH_CONTRACT_UNVERIFIED');
   case 'types':return this.registry.list(c);
   case 'createType':return this.registry.change(c,null,body);
   case 'updateType':return this.registry.change(c,key,body);
   case 'deleteType':return this.registry.change(c,key,body,true);
   case 'issue':return {...await this.registry.issue(c,body,requestId),lifecycle:require('../lifecycle.cjs').awaiting('offer_acceptance')};
   case 'job':{const job=await this.db.collection('operation_jobs').findOne({...this.coordination.scope(c),requestId:key},{projection:{_id:0,key:0,requestHash:0}});if(!job)fail(404,'RESOURCE_NOT_FOUND');return this.coordination.publicJob(job);}
      default: fail(404, 'RESOURCE_NOT_FOUND');
    }
  }
};
