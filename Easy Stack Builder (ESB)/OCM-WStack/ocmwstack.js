'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const READY_STATUSES = new Set([
  'ready', 'passed', 'charts-validated', 'api-reachable',
  'authentication-checked', 'tenant-removed',
]);
const ACTIONS = new Set([
  'deploy', 'preflight', 'inspect', 'validate', 'diagnose-api', 'diagnose-auth',
  'repair-ocm', 'repair-network', 'install-ui', 'test-credentials', 'teardown', 'diagnose-storage',
]);
const CREDENTIALS = Object.fromEntries([
  'tlsCertificate', 'tlsPrivateKey', 'kubeconfig', 'dnsToken', 'dnsSecretData',
  'editorPassword', 'uiAdminPassword', 'mongoUri',
].map(name => [name, { type: 'password' }]));

/** Stop the script and its subprocesses together when the node closes. */
function stopProcess(child, signal) {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

/** Execute one Bash action; stdout is a result and stderr carries JSON progress. */
function execute(action, directory, onProgress, signal, backupDirectory) {
  return new Promise((resolve, reject) => {
    const resultFile = path.join(directory, 'result.json');
    let lastPhase;
    const child = spawn('bash', [
      path.join(__dirname, 'deploy.sh'), action,
      '--config', path.join(directory, 'config.json'),
      '--credentials', path.join(directory, 'credentials.json'),
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ESB_RESULT_FILE: resultFile, ...(backupDirectory ? { ESB_RECOVERY_BACKUP_DIR: backupDirectory } : {}) } });

    let output = '';
    let killTimer;
    let finished = false;
    let cancelled = false;
    let outputError;

    function cancel() {
      if (cancelled) return;
      cancelled = true;
      stopProcess(child, 'SIGTERM');
      killTimer = setTimeout(() => stopProcess(child, 'SIGKILL'), 5000);
      killTimer.unref();
    }

    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(result);
    }

    const progress = readline.createInterface({ input: child.stderr });
    progress.on('line', line => {
      if (line.length > 65536) return;
      try {
        const event = JSON.parse(line);
        if (event && typeof event.type === 'string') {
          if (typeof event.phase === 'string') lastPhase = event.phase;
          onProgress(event);
        }
      } catch {
        // Only deliberate progress records are forwarded. Raw diagnostics
        // can contain subprocess arguments or private response bodies.
      }
    });
    child.stdout.on('data', data => {
      if (outputError) return;
      output += data.toString();
      if (Buffer.byteLength(output) > 8 * 1024 * 1024) {
        outputError = Object.assign(new Error('Deployment result exceeds 8 MiB.'), { code: 'RESULT_LIMIT' });
        cancel();
        output = '';
      }
    });
    child.once('error', error => {
      finish(Object.assign(new Error(`Cannot start Bash: ${error.code}.`), { code: 'PREREQUISITE' }));
    });
    child.once('close', async (code, exitSignal) => {
      progress.close();
      if (cancelled) {
        stopProcess(child, 'SIGKILL');
        finish(outputError || Object.assign(new Error('Operation cancelled; cluster resources are retained.'), { code: 'CANCELLED' }));
        return;
      }
      let result;
      try {
        result = JSON.parse(output);
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
      } catch {
        try {
          result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
          if (result?.status !== 'failed' || typeof result.code !== 'string' ||
              typeof result.message !== 'string') throw new Error();
        } catch {
          const reason = exitSignal ? `signal ${exitSignal}` : `exit code ${code}`;
          const phase = lastPhase ? ` during ${lastPhase}` : '';
          finish(Object.assign(new Error(`Deployment script ended${phase} with ${reason} without a valid result.`), {
            code: exitSignal ? 'SCRIPT_TERMINATED' : 'RESULT_FORMAT',
          }));
          return;
        }
      }
      if ((result.status === 'failed' && result.code) || (code !== 0 && code !== 2)) {
        finish(Object.assign(new Error(result.message || 'Deployment failed.'), { code: result.code || 'COMMAND_FAILED', diagnostics: result.diagnostics }));
      } else {
        finish(null, result);
      }
    });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

/** Public access details only; never copy credentials or internal ClusterIPs. */
function accessDetails(config, addresses = []) {
  const domain = String(config.domainAddress || config.domain || '').trim().toLowerCase().replace(/^\*\./, '');
  const tenant = String(config.tenantSubdomain || config.tenantId || 'demo-tenant').trim().toLowerCase().replace(/_/g, '-');
  const hostname = domain ? `${tenant}.${domain}` : null;
  const targets = addresses.filter(a => a && typeof a.value === 'string' && a.value &&
    ['IPAddress', 'Hostname'].includes(a.type));
  const hosts = hostname ? [hostname] : [];
  const urls = { tenant: hostname ? `https://${hostname}` : null,
    ui: hostname ? `https://${hostname}/orce/` : null,
    editor: hostname ? `https://${hostname}/orce/editor/` : null };
  if (domain && [true, 'true', 1, '1'].includes(config.publicDashboards)) {
    hosts.push(`argocd.${domain}`, `grafana.${domain}`);
    urls.argocd = `https://argocd.${domain}`;
    urls.grafana = `https://grafana.${domain}`;
  }
  return { urls, dns: { status: targets.length ? 'discovered' : 'pending',
    automatic: [true, 'true', 1, '1'].includes(config.externalDns),
    hostnames: hosts, targets: targets.map(a => a.value),
    records: hosts.flatMap(name => targets.map(a => ({ name,
      type: a.type === 'Hostname' ? 'CNAME' : a.value.includes(':') ? 'AAAA' : 'A',
      value: a.value }))) } };
}

module.exports = function register(RED) {
  function OCMWStack(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    let active;
    let controller;
    let closed = false;
    node.status({ fill: 'grey', shape: 'ring', text: 'Idle' });

    node.on('input', (msg, send, done) => {
      send = send || node.send.bind(node);
      done = done || (error => { if (error) node.error(error); });
      if (active) {
        done(new Error('An OCM operation is already running on this node.'));
        return;
      }
      const action = msg.action || 'deploy';
      controller = new AbortController();
      let access = accessDetails(config);
      function progress(event) {
        if (closed) return;
        if (Array.isArray(event.gatewayAddresses)) access = accessDetails(config, event.gatewayAddresses);
        const text = event.phase || event.message;
        if (text) node.status({ fill: 'blue', shape: 'dot', text: text.slice(0, 100) });
        send([null, { _msgid: msg._msgid, topic: 'ocm-wstack/progress',
          payload: { timestamp: new Date().toISOString(), action, ...event, access } }]);
      }
      active = Promise.resolve().then(async () => {
        let directory;
        let failure;
        try {
          if (!ACTIONS.has(action)) throw Object.assign(new Error('Unknown deployment action.'), { code: 'ACTION' });
          directory = await fs.mkdtemp(path.join(os.tmpdir(), 'esb-ocmwstack-node-'));
          await fs.chmod(directory, 0o700);
          // Messages select an action and confirmation. Configuration and
          // credentials always come from the configured node.
          await fs.writeFile(path.join(directory, 'config.json'),
            JSON.stringify({ ...config, confirm: msg.confirm }), { mode: 0o600 });
          await fs.writeFile(path.join(directory, 'credentials.json'),
            JSON.stringify(node.credentials || {}), { mode: 0o600 });
          const result = await execute(action, directory, progress, controller.signal, path.join(RED.settings?.userDir || os.tmpdir(), 'ocm-deployer-backups'));
          if (Array.isArray(result.gatewayAddresses)) access = accessDetails(config, result.gatewayAddresses);
          if (!closed) {
            const ready = READY_STATUSES.has(result.status);
            node.status({ fill: ready ? 'green' : 'yellow', shape: ready ? 'dot' : 'ring',
              text: result.status || 'Inspection complete' });
            send([{ _msgid: msg._msgid, topic: 'ocm-wstack/result', payload: { action, ...result, access } }, null]);
          }
        } catch (error) {
          failure = error;
          if (!closed) {
            node.status({ fill: 'red', shape: 'ring', text: error.code || 'Failed' });
            send([{ _msgid: msg._msgid, topic: 'ocm-wstack/result',
              payload: { action, status: 'failed', code: error.code || 'ERROR', message: error.message,
                ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}), access } }, null]);
          }
        } finally {
          try {
            if (directory) await fs.rm(directory, { recursive: true, force: true });
          } catch (error) {
            failure = failure || error;
          }
          controller = null;
          active = null;
          done(failure);
        }
      });
    });
    node.on('close', (removed, done) => {
      closed = true;
      controller?.abort();
      // Removing the node stops local work. Teardown is an explicit action.
      if (active) active.then(() => done(), done);
      else done();
    });
  }
  RED.nodes.registerType('OCM-W-Stack', OCMWStack, { credentials: CREDENTIALS });
};

// The terminal installer shares the node's bcrypt dependency. Passwords arrive
// on stdin, never in command-line arguments or progress messages.
if (require.main === module) {
  (async () => {
    if (process.argv[2] !== '--hash-password') throw new Error('Unsupported node utility.');
    let password = '';
    for await (const chunk of process.stdin) {
      password += chunk;
      if (Buffer.byteLength(password) > 72) throw new Error('Password exceeds 72 UTF-8 bytes.');
    }
    if ([...password].length < 12 || /[\x00-\x1f\x7f]/.test(password)) {
      throw new Error('Password requires at least 12 characters without control characters.');
    }
    process.stdout.write(await require('bcryptjs').hash(password, 12));
  })().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
