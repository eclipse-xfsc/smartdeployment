module.exports = function(RED) {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const tmp = require('tmp');
  const path = require('path');
  const readline = require('readline');

  function DeployNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const kubeContent = config.kubeconfigContent;
    const keyContent = config.privateKeyContent;
    const crtContent = config.certificateContent;
    const domain = config.domainAddress;
    const suffix = config.instanceName;
    const email = config.emailAddress;

    function writeTempFiles() {
      const kubeTmp = tmp.fileSync({ prefix: 'kube-', postfix: '.yaml' });
      fs.writeFileSync(kubeTmp.name, kubeContent, { encoding: 'utf8', mode: 0o600 });

      const keyTmp = tmp.fileSync({ prefix: 'key-', postfix: '.key' });
      fs.writeFileSync(keyTmp.name, keyContent, { encoding: 'utf8', mode: 0o600 });

      const crtTmp = tmp.fileSync({ prefix: 'crt-', postfix: '.crt' });
      fs.writeFileSync(crtTmp.name, crtContent, { encoding: 'utf8', mode: 0o600 });

      return { kubeTmp, keyTmp, crtTmp };
    }

    function cleanupTempFiles(files) {
      if (!files) return;
      for (const handle of [files.kubeTmp, files.keyTmp, files.crtTmp]) {
        try {
          if (handle && typeof handle.removeCallback === 'function') handle.removeCallback();
        } catch (_) {
          // ignore cleanup failures
        }
      }
    }

    function parseLine(prefix, line) {
      if (!line.startsWith(prefix)) return null;
      try {
        return JSON.parse(line.slice(prefix.length));
      } catch (_) {
        return null;
      }
    }

    function maskSecrets(text) {
      if (!text) return text;
      return String(text)
        .replace(/(BRIDGE_CLIENT_SECRET=)[^\s]+/g, '$1***')
        .replace(/("clientSecret"\s*:\s*")[^"]+("?)/g, '$1***$2')
        .replace(/(clientSecret["'=:\s]+)[^,\s\"]+/gi, '$1***')
        .replace(/(secret=)[^\s]+/gi, '$1***');
    }

    function setRuntimeStatus(event) {
      if (!event) return;
      const fill = event.status === 'failed'
        ? 'red'
        : event.status === 'done'
          ? 'green'
          : event.status === 'warning'
            ? 'yellow'
            : 'blue';
      const shape = event.status === 'failed' ? 'ring' : 'dot';
      const text = [event.phase, event.status].filter(Boolean).join(' ');
      node.status({ fill, shape, text: text || 'deploying' });
      node.context().set('ocmStatus', event);
    }

    node.on('input', function(msg, send, done) {
      send = send || node.send;

      if (!suffix || !domain || !email || !kubeContent || !keyContent || !crtContent) {
        const err = new Error('Missing required configuration (instanceName, domain, email, kubeconfig, key, certificate).');
        node.error(err.message, msg);
        node.status({ fill: 'red', shape: 'ring', text: 'missing config' });
        msg.payload = err.message;
        send(msg);
        if (done) done(err);
        return;
      }

      let tempFiles;
      try {
        tempFiles = writeTempFiles();
      } catch (e) {
        node.error(`Failed to write temp files: ${e.message}`, msg);
        node.status({ fill: 'red', shape: 'ring', text: 'file error' });
        msg.payload = e.message;
        send(msg);
        if (done) done(e);
        return;
      }

      const deployScript = path.join(__dirname, 'deploy.sh');
      const args = [suffix, domain, tempFiles.crtTmp.name, tempFiles.keyTmp.name, email, tempFiles.kubeTmp.name];
      const child = spawn('bash', [deployScript, ...args], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let outputContract = null;
      const deploymentEvents = [];
      const deploymentWarnings = [];

      node.log('Starting OCM-W-Stack deployment');
      node.status({ fill: 'blue', shape: 'dot', text: 'starting' });
      node.context().set('ocmStatus', { phase: 'starting', status: 'running' });

      const handleLine = (source, rawLine) => {
        const line = String(rawLine || '').replace(/\r$/, '');
        if (!line.trim()) return;

        const event = parseLine('EVENT_JSON=', line);
        if (event) {
          deploymentEvents.push(event);
          setRuntimeStatus(event);
          return;
        }

        const warning = parseLine('WARN_JSON=', line);
        if (warning) {
          deploymentWarnings.push(warning);
          return;
        }

        const output = parseLine('OUTPUT_JSON=', line);
        if (output) {
          outputContract = output;
          return;
        }

        if (source === 'stderr') {
          stderr += `${line}\n`;
          node.warn(maskSecrets(line));
        } else {
          stdout += `${line}\n`;
          node.debug(maskSecrets(line));
        }
      };

      const stdoutReader = readline.createInterface({ input: child.stdout });
      const stderrReader = readline.createInterface({ input: child.stderr });
      stdoutReader.on('line', (line) => handleLine('stdout', line));
      stderrReader.on('line', (line) => handleLine('stderr', line));

      child.on('error', (err) => {
        cleanupTempFiles(tempFiles);
        const message = maskSecrets(err.message);
        node.error(message, msg);
        node.status({ fill: 'red', shape: 'ring', text: 'deploy failed' });
        node.context().set('ocmStatus', { phase: 'complete', status: 'failed', detail: message });
        msg.payload = message;
        send(msg);
        if (done) done(err);
      });

      child.on('close', (code) => {
        cleanupTempFiles(tempFiles);
        try { stdoutReader.close(); } catch (_) {}
        try { stderrReader.close(); } catch (_) {}

        if (code !== 0 || !outputContract) {
          const errorMsg = maskSecrets((stderr && stderr.trim()) || (stdout && stdout.trim()) || `Deployment failed with exit code ${code}.`);
          node.error(errorMsg, msg);
          node.status({ fill: 'red', shape: 'ring', text: 'deploy failed' });
          node.context().set('ocmStatus', { phase: 'complete', status: 'failed', detail: errorMsg });
          msg.payload = errorMsg;
          msg.deploymentOutput = maskSecrets(stdout.trim());
          if (stderr && stderr.trim()) msg.deploymentStderr = maskSecrets(stderr.trim());
          if (deploymentEvents.length) msg.deploymentEvents = deploymentEvents;
          if (deploymentWarnings.length) msg.deploymentWarnings = deploymentWarnings;
          send(msg);
          if (done) done(new Error(errorMsg));
          return;
        }

        node.status({ fill: 'green', shape: 'dot', text: 'implemented' });
        node.context().set('ocmStatus', { phase: 'complete', status: 'done', detail: 'Implemented' });
        msg.payload = outputContract;
        msg.deploymentOutput = maskSecrets(stdout.trim() || 'Deployment succeeded.');
        if (stderr && stderr.trim()) msg.deploymentStderr = maskSecrets(stderr.trim());
        if (deploymentEvents.length) msg.deploymentEvents = deploymentEvents;
        if (deploymentWarnings.length) msg.deploymentWarnings = deploymentWarnings;
        send(msg);
        if (done) done();
      });
    });

    node.on('close', function(removed, done) {
      if (!removed) return done();

      let kubeTmp;
      try {
        kubeTmp = tmp.fileSync({ prefix: 'kube-', postfix: '.yaml' });
        fs.writeFileSync(kubeTmp.name, kubeContent, { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        node.warn(`uninstall: failed to write kubeconfig temp file: ${err.message}`);
        return done();
      }

      const uninstallScript = path.join(__dirname, 'uninstall.sh');
      const child = spawn('bash', [uninstallScript, suffix, kubeTmp.name], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      node.context().set('ocmStatus', { phase: 'uninstall', status: 'running' });

      const finalize = () => {
        try {
          kubeTmp.removeCallback();
        } catch (_) {
          // ignore cleanup failures
        }
      };

      child.stdout.on('data', () => {});
      child.stderr.on('data', (chunk) => {
        const line = maskSecrets(chunk.toString().trim());
        if (line) node.warn(`uninstall: ${line}`);
      });

      child.on('close', (code) => {
        finalize();
        if (code !== 0) {
          node.error(`uninstall failed with exit code ${code}`);
          node.context().set('ocmStatus', { phase: 'uninstall', status: 'failed' });
        } else {
          node.context().set('ocmStatus', { phase: 'uninstall', status: 'done' });
        }
        done();
      });

      child.on('error', (err) => {
        finalize();
        node.error(`uninstall failed: ${err.message}`);
        node.context().set('ocmStatus', { phase: 'uninstall', status: 'failed', detail: err.message });
        done();
      });
    });
  }

  RED.nodes.registerType('OCM-W-Stack', DeployNode);
};
