'use strict';
const { fail, object } = require('../errors.cjs');
module.exports = {
  actions: ["provenance"],
  async execute(action, c, key, body, q, requestId) {
    const a = this.adapters;
    const scope = {tenant:c.tenant,subject:c.subject};
    switch(action) {
   case 'provenance':{const graph=await a.provenance(c,key);graph.verifications=await this.db.collection('verification_events').find({tenant:c.tenant,account:c.account,group:c.group,wallet:'ocm',credentialId:key},{projection:{_id:0,expiresAt:0}}).sort({timestamp:-1}).limit(20).toArray();return graph;}
      default: fail(404, 'RESOURCE_NOT_FOUND');
    }
  }
};
