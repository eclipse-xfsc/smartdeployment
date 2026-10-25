'use strict';
const { fail, object } = require('../errors.cjs');
module.exports = {
  actions: ["metrics", "health"],
  async execute(action, c, key, body, q, requestId) {
    const a = this.adapters;
    const scope = {tenant:c.tenant,subject:c.subject};
    switch(action) {
   case 'metrics':return {requests:Object.fromEntries(this.counts),natsConnected:this.events.connected,mongoReady:this.ready};
   case 'health':return {nats:{connected:this.events.connected,mode:(this.c.eventSubjects||[]).length?'events-and-polling':'polling'},upstreams:this.http.health(),issuerTenant:this.issuerBootstrap.state,version:require('../../package.json').version,sessionArchitecture:'mongodb-absolute-24h',native:this.nativeState};
      default: fail(404, 'RESOURCE_NOT_FOUND');
    }
  }
};
