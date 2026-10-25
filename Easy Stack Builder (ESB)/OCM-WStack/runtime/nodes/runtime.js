'use strict';
module.exports=function(RED){
 require('../lib/browser-routes.cjs').register(RED);
 function RuntimeNode(config){
  RED.nodes.createNode(this,config);const app=require('../lib/runtime.cjs').instance();
  app.start().then(()=>this.status({fill:'green',shape:'dot',text:'ready'})).catch(()=>this.status({fill:'red',shape:'ring',text:'startup failed'}));
  this.on('input',(msg,send,done)=>{app.handle(msg.req,msg.res._res||msg.res).then(()=>done&&done()).catch(()=>done&&done(new Error('Request failed')));});
  this.on('close',(removed,done)=>app.close().then(done,done));
 }
 RED.nodes.registerType('ocm-ui-runtime',RuntimeNode);
};
