'use strict';
const {spawn} = require('node:child_process');

function tunnel(service,env,signal) {
  return new Promise((resolve,reject)=>{
    const child=spawn('kubectl',['-n','ocm-wstack','port-forward',`service/${service}`,':8080','--address=127.0.0.1'],{env,stdio:['ignore','pipe','pipe']});
    let output='',settled=false,closed=false,killTimer,resolveClosed;
    const closedPromise=new Promise(done=>{resolveClosed=done;});
    const stop=()=>{if(closed)return;child.kill('SIGTERM');if(!killTimer){killTimer=setTimeout(()=>{if(!closed)child.kill('SIGKILL');},3000);killTimer.unref();}};
    const abort=()=>{stop();if(!settled){settled=true;reject(new Error('Port-forward cancelled.'));}};
    const timer=setTimeout(()=>{stop();if(!settled){settled=true;reject(new Error(`Port-forward for ${service} timed out.`));}},30000);
    signal?.addEventListener('abort',abort,{once:true});
    const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);};
    child.stdout.on('data',chunk=>{
      output=(output+chunk).slice(-8000);
      const match=/Forwarding from 127\.0\.0\.1:(\d+) -> 8080/.exec(output);
      if(match&&!settled){settled=true;clearTimeout(timer);resolve({url:`http://127.0.0.1:${match[1]}`,close:async()=>{stop();await closedPromise;cleanup();}});}
    });
    child.stderr.on('data',()=>{});
    child.on('error',()=>{cleanup();if(!settled){settled=true;reject(new Error(`Cannot start port-forward for ${service}.`));}});
    child.on('close',()=>{closed=true;resolveClosed();cleanup();if(!settled){settled=true;reject(new Error(`Port-forward for ${service} exited before becoming ready.`));}});
    if(signal?.aborted)abort();
  });
}
module.exports={tunnel};
