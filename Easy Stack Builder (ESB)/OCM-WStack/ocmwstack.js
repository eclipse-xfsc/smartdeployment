'use strict';
const {operation}=require('./lib/install');

module.exports=function(RED) {
  function OCMWStack(input) {
    RED.nodes.createNode(this,input);
    const node=this;
    let active,controller,closed=false;
    node.status({fill:'grey',shape:'ring',text:'Official bootstrap · idle'});
    node.on('input',function(msg,send,done) {
      send=send||node.send.bind(node);done=done||function(e){if(e)node.error(e);};
      if(active){done(new Error('An OCM operation is already running on this node.'));return;}
      const action=msg.action||'deploy';
      controller=new AbortController();
      const emit=event=>{
        if(closed)return;
        if(event.type==='phase')node.status({fill:'blue',shape:'dot',text:event.phase});
        if(event.type==='tls-progress')node.status({fill:'blue',shape:'dot',text:`TLS ${event.elapsedSeconds}s: ${event.message}`.slice(0,100)});
        if(event.type==='routing-progress')node.status({fill:'blue',shape:'dot',text:`Routing ${event.elapsedSeconds}s: ${event.message}`.slice(0,100)});
        send([null,{_msgid:msg._msgid,topic:'ocm-wstack/progress',payload:{timestamp:new Date().toISOString(),action,...event}}]);
      };
      // Configuration and credentials come only from the configured node, never message overrides.
      active=operation(action,{...input,confirm:msg.confirm},node.credentials,{emit,signal:controller.signal})
        .then(result=>{
          if(!closed){
            const ok=['ready','passed','charts-validated','api-reachable','authentication-checked','tenant-removed'].includes(result.status);
            node.status({fill:ok?'green':'yellow',shape:ok?'dot':'ring',text:result.status||'inspection complete'});
            send([{_msgid:msg._msgid,topic:'ocm-wstack/result',payload:{action,...result}},null]);
          }
          done();
        })
        .catch(error=>{
          if(!closed){node.status({fill:'red',shape:'ring',text:error.code||'failed'});send([{_msgid:msg._msgid,topic:'ocm-wstack/result',payload:{action,status:'failed',code:error.code||'ERROR',message:error.message}},null]);}
          done(error);
        }).finally(()=>{active=null;controller=null;});
    });
    node.on('close',function(removed,done){
      closed=true;
      // Cancels local processes only. Node removal never uninstalls or deletes cluster resources.
      controller?.abort();
      if(active)active.finally(done);else done();
    });
  }
  RED.nodes.registerType('OCM-W-Stack',OCMWStack,{credentials:{kubeconfig:{type:'password'},dnsToken:{type:'password'},dnsSecretData:{type:'password'},editorPassword:{type:'password'},uiAdminPassword:{type:'password'},mongoUri:{type:'password'}}});
};
