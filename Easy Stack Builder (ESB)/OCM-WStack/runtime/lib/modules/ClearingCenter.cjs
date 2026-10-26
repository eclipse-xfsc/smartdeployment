"use strict";
const {fail}=require('../errors.cjs');
module.exports={
  actions:['clearingProviders','clearingInputs','clearingHistory','clearingJob','clearingRequest','clearingStore'],
  async execute(action,c,key,body,q,requestId){
    switch(action){
      case 'clearingProviders': return this.clearing.list();
      case 'clearingInputs': return this.clearing.inputs(c);
      case 'clearingHistory': return this.clearing.history(c);
      case 'clearingJob': return this.clearing.get(c,key);
      case 'clearingRequest':
        try{return await this.clearing.acquire(c,body,requestId);}
        catch(error){error.dispatchNotStarted=true;throw error;}
      case 'clearingStore': return this.clearing.store(c,key);
      default: fail(404,'RESOURCE_NOT_FOUND');
    }
  }
};
