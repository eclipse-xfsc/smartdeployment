'use strict';
const { fail, object } = require('../errors.cjs');
module.exports = {
  actions: ["relationships", "relationship", "invite", "acceptRelationship", "updateRelationship", "deleteRelationship", "block", "unblock"],
  async execute(action, c, key, body, q, requestId) {
    const a = this.adapters;
    const scope = {tenant:c.tenant,subject:c.subject};
    switch(action) {
   case 'relationships':return a.relationships(c);
   case 'relationship':{const r=await a.relationship(c,key);return {did:r.remoteDid,label:r.properties?.label||'',createdAt:r.added,group:r.group};}
   case 'invite':return a.relationAction(c,null,'invitations',body);
   case 'acceptRelationship':return a.relationAction(c,null,'accept',body);
   case 'updateRelationship':return a.relationAction(c,key,'update',body);
   case 'deleteRelationship':return a.relationAction(c,key,'delete',body);
   case 'block':case 'unblock':return a.relationAction(c,key,action,body);
      default: fail(404, 'RESOURCE_NOT_FOUND');
    }
  }
};
