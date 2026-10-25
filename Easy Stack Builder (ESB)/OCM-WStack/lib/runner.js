'use strict';
const {spawn} = require('node:child_process');
const {boundCommand}=require('./kube-client');

class Runner {
  constructor({cwd, env, emit = () => {}, secrets = [], signal} = {}) {
    this.cwd = cwd; this.env = env || process.env; this.emit = emit; this.signal = signal;
    this.secrets = secrets.filter(x => typeof x === 'string' && x.length > 0);
  }
  redact(value) {
    let text = String(value);
    for (const secret of this.secrets) text = text.split(secret).join('[redacted]');
    return text.replace(/(Bearer\s+)[^\s"']+/gi,'$1[redacted]').replace(/((?:password|token|client-key-data|certificate-authority-data|credential_offer)\s*[:=]\s*)\S+/gi,'$1[redacted]');
  }
  async run(command, args = [], options = {}) {
    if (this.signal?.aborted) throw Object.assign(new Error('Operation cancelled; installed cluster resources are retained.'),{code:'CANCELLED'});
    const {timeout = 180000, input, live = false, allowFailure = false, cwd = this.cwd, processGroup = process.platform !== 'win32'} = options;
    return new Promise((resolve,reject) => {
      // Helpers inherit the binding and invoke the real CLI directly. PATH
      // changes in a nested shell must never select an ambient service account.
      const bound=boundCommand(command,args,this.env);
      const child = spawn(bound.command,bound.args,{cwd, env:this.env, stdio:['pipe','pipe','pipe'], detached:processGroup});
      let out = '', err = '', pending = '', pendingError = '', stopped = '', killTimer;
      const kill = () => { try { if (processGroup) process.kill(-child.pid,'SIGTERM'); else child.kill(); } catch {} };
      const stop = (reason) => {
        stopped = reason; kill();
        killTimer = setTimeout(() => { try { if (processGroup) process.kill(-child.pid,'SIGKILL'); else child.kill('SIGKILL'); } catch {} },3000);
        killTimer.unref();
      };
      const abort = () => stop('CANCELLED');
      const timer = setTimeout(() => stop('TIMEOUT'),timeout); timer.unref();
      this.signal?.addEventListener('abort',abort,{once:true});
      const finish = () => {clearTimeout(timer); clearTimeout(killTimer); this.signal?.removeEventListener('abort',abort);};
      const log = line => {
        const phase = /^\[ESB_PHASE\] ([a-z0-9-]+)$/.exec(line);
        // Preserve structured gateway progress from the bootstrap helper.
        if(line.startsWith('[ESB_API] ')) {
          try {
            const event=JSON.parse(this.redact(line.slice(10)));
            if(['phase','routing-progress','routing-drift','gateway-configured','ocm-startup','migration-recovery','cassandra-probes','verification-pull-secret','kubeconfig-identity','kube-access'].includes(event.type)){this.emit(event);return;}
          } catch {}
        }
        this.emit(phase ? {type:'phase',phase:phase[1]} : {type:'log',message:this.redact(line).slice(0,2000)});
      };
      child.stdout.on('data',data => {
        out += data;
        if (out.length > 8*1024*1024) { out = out.slice(-4*1024*1024); }
        if (live) {pending += data; const lines=pending.split(/\r?\n/); pending=lines.pop(); for(const line of lines) if(line)log(line); if(pending.length>16000)pending=pending.slice(-16000);}
      });
      child.stderr.on('data',data => {
        err = (err+data).slice(-256000);
        if(live){pendingError+=data;const lines=pendingError.split(/\r?\n/);pendingError=lines.pop();for(const line of lines)if(line)log(line);}
      });
      child.on('error',e => {finish(); reject(Object.assign(new Error(`Cannot start ${command}: ${e.code || 'process error'}. Install the required CLI in the ORCE container.`),{code:'PREREQUISITE'}));});
      child.on('close',(code) => {
        finish(); if(live && pending)log(pending);if(live&&pendingError)log(pendingError);
        if (stopped || (code !== 0 && !allowFailure)) {
          const e = new Error(`${command} ${stopped === 'TIMEOUT' ? 'timed out' : stopped === 'CANCELLED' ? 'cancelled' : `exited ${code}`}. ${this.redact(err || out).slice(-3500)}`);
          // Preserve redacted diagnostics for classification; the public message stays bounded.
          e.commandOutput = this.redact(err || out);
          e.code = stopped || 'COMMAND_FAILED'; reject(e);
        } else resolve({code,stdout:out,stderr:err});
      });
      child.stdin.on('error',() => {});
      child.stdin.end(input);
    });
  }
  async json(command,args,options) {const r=await this.run(command,args,options); return r.stdout.trim()?JSON.parse(r.stdout):null;}
}
module.exports = {Runner};
