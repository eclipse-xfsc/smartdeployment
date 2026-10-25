'use strict';
const { fail, object } = require('../errors.cjs');
module.exports = {
  actions: ["me", "preferences", "setPreferences", "audit", "createUser", "updateUser", "deleteUser", "roles", "createRole", "updateRole", "deleteRole", "assignments", "assign", "effective"],
  async execute(action, c, key, body, q, requestId) {
    const a = this.adapters;
    const scope = {tenant:c.tenant,subject:c.subject};
    switch(action) {
   case 'me':return {subject:c.subject,username:c.username,tenant:c.tenant,account:c.account,group:c.group,permissions:c.permissions,expiresAt:c.expiresAt,passwordChangeRequired:c.passwordChangeRequired};
   case 'preferences':return await this.db.collection('ui_preferences').findOne(scope,{projection:{_id:0}})||{locale:'en',pageSize:25};
   case 'setPreferences':object(body,['locale','pageSize']);if(body.locale&&!['en','de','fr'].includes(body.locale))fail(400,'VALIDATION_ERROR');if(body.pageSize!==undefined&&![10,25,50,100].includes(body.pageSize))fail(400,'VALIDATION_ERROR');await this.db.collection('ui_preferences').updateOne(scope,{$set:{...body,updatedAt:new Date()}},{upsert:true});return body;
   case 'audit':return {items:await this.db.collection('ui_audit_log').find({tenant:c.tenant},{projection:{_id:0}}).sort({timestamp:-1}).limit(100).toArray()};
   case 'createUser':return this.roles.user(null,body);
   case 'updateUser':return this.roles.user(key,body);
   case 'deleteUser':return this.roles.user(key,body,true);
   case 'roles':return this.roles.list();
   case 'createRole':return this.roles.change(null,body);
   case 'updateRole':return this.roles.change(key,body);
   case 'deleteRole':return this.roles.change(key,body,true);
   case 'assignments':return this.roles.users(q.search||'');
   case 'assign':return this.roles.assign(key,body);
   case 'effective':return {permissions:await this.roles.effective(key)};
      default: fail(404, 'RESOURCE_NOT_FOUND');
    }
  }
};
