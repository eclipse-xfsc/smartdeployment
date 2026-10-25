'use strict';
const { fail, object } = require('../errors.cjs');
module.exports = {
  actions: ["lifecycle", "credentials", "credential", "importCredential", "deleteCredential", "verify", "revoke", "chain", "offers", "import", "accept", "reject"],
  async execute(action, c, key, body, q, requestId) {
    const a = this.adapters;
    const scope = {tenant:c.tenant,subject:c.subject};
    switch(action) {
   case 'lifecycle':return require('../lifecycle.cjs').inspect(a,c,key);
   case 'credentials':return a.list(c,q);
   case 'credential':return a.detail(c,key);
   case 'importCredential':{const result=await a.importCredential(c,body,requestId);return {...result,lifecycle:result.credentialId&&c.permissions.includes('credentials.read')?await require('../lifecycle.cjs').inspect(a,c,result.credentialId):require('../lifecycle.cjs').awaiting('storage_readback')};}
   case 'deleteCredential':return a.remove(c,key);
   case 'verify':{const result=await a.verify(c,key);await this.db.collection('verification_events').insertOne({tenant:c.tenant,account:c.account,group:c.group,wallet:'ocm',credentialId:key,verifier:c.subject,verifierName:c.username||c.subject,service:result.service||'XFSC Signer',code:result.code||null,overall:result.overall,cryptographic:result.cryptographic.state,status:result.status.state,timestamp:new Date(),expiresAt:new Date(Date.now()+90*86400000),requestId});return {...result,requestId,requestedBy:{subject:c.subject,username:c.username||c.subject}};}
   case 'revoke':return a.revoke(c,key);
   case 'chain':return a.chain(c,body);
   case 'offers':return a.offers(c);
   case 'import':object(body,['offer','source']);return a.importOffer(c,body.offer);
   case 'accept':{const result=await a.accept(c,key,true,body);return {...result,lifecycle:result.storageConfirmation==='confirmed'&&result.credentialId&&c.permissions.includes('credentials.read')?await require('../lifecycle.cjs').inspect(a,c,result.credentialId):require('../lifecycle.cjs').awaiting(result.storageConfirmation==='confirmed'?'lifecycle_readback':'asynchronous_retrieval')};}
   case 'reject':return a.accept(c,key,false,body);
      default: fail(404, 'RESOURCE_NOT_FOUND');
    }
  }
};
