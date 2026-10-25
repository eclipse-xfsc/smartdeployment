'use strict';
const { fail, object } = require('../errors.cjs');
module.exports = {
  actions: ["clearingProviders", "clearingRequest"],
  async execute(action, c, key, body, q, requestId) {
    const a = this.adapters;
    const scope = {tenant:c.tenant,subject:c.subject};
    switch(action) {
   case 'clearingProviders':return this.clearing.list();
   case 'clearingRequest':return this.clearing.acquire(body);
      default: fail(404, 'RESOURCE_NOT_FOUND');
    }
  }
};
