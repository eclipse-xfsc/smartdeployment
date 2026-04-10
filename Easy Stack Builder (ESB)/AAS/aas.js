module.exports = function(RED) {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const tmp = require('tmp');

  function pickOutputValue(text, key) {
    const match = (text || '').match(new RegExp('^' + key + '=(.*)$', 'm'));
    return match ? match[1].trim() : '';
  }

  function maskSecrets(text) {
    return String(text || '')
      .replace(/(password|secret|token)=([^\n]+)/gi, '$1=[masked]')
      .replace(/(admin-password: )(.*)/gi, '$1[masked]')
      .replace(/(client secret: )(.*)/gi, '$1[masked]');
  }

  function normalizeDbType(value) {
    return String(value || '').trim().toLowerCase() === 'external' ? 'external' : 'embedded';
  }

  function buildDeploymentPayload(stdout, domain) {
    const aasAuthUrl = pickOutputValue(stdout, 'AAS_AUTH_URL') || pickOutputValue(stdout, 'AUTH_SERVER_URL');
    const keyServerUrl = pickOutputValue(stdout, 'KEY_SERVER_URL');
    const testUrl = pickOutputValue(stdout, 'TEST_URL') || (domain ? `https://test-server.${domain}/demo` : '');
    const status = pickOutputValue(stdout, 'STATUS') || 'Deployed';
    const diagnostics = {
      keycloakAdminUsername: pickOutputValue(stdout, 'KEYCLOAK_ADMIN_USERNAME') || 'admin',
      keycloakRealm: pickOutputValue(stdout, 'KEYCLOAK_REALM') || 'gaia-x',
      initialAccessTokenSecret: pickOutputValue(stdout, 'INITIAL_ACCESS_TOKEN_SECRET') || 'aas-initial-access-token'
    };

    return {
      payload: { aasAuthUrl, keyServerUrl, testUrl, status },
      diagnostics
    };
  }

  function writeTempFile(prefix, postfix, content, mode) {
    const tmpFile = tmp.fileSync({ prefix, postfix });
    fs.writeFileSync(tmpFile.name, content, { encoding: 'utf8', mode });
    return tmpFile;
  }

  function createLineReader(onLine) {
    let buffer = '';
    return (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.forEach((line) => onLine(line));
    };
  }

  function parseEventLine(line) {
    if (!String(line || '').startsWith('EVENT_JSON=')) return null;
    try { return JSON.parse(line.slice('EVENT_JSON='.length)); } catch (error) { return null; }
  }

  function runScriptStreaming(scriptPath, args, handlers, onDone) {
    const child = spawn('bash', [scriptPath].concat(args), {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', createLineReader((line) => {
      stdout += `${line}\n`;
      if (handlers && typeof handlers.onStdoutLine === 'function') handlers.onStdoutLine(line);
    }));
    child.stderr.on('data', createLineReader((line) => {
      stderr += `${line}\n`;
      if (handlers && typeof handlers.onStderrLine === 'function') handlers.onStderrLine(line);
    }));

    child.on('error', (err) => onDone(err, stdout, stderr));
    child.on('close', (code) => {
      if (code !== 0) {
        return onDone(new Error((stderr || `script exited with code ${code}`).trim()), stdout, stderr);
      }
      return onDone(null, stdout, stderr);
    });
  }

  function DeployNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const kubeContent = config.kubeconfigContent;
    const keyContent = config.privateKeyContent;
    const crtContent = config.certificateContent;
    const domain = (config.domainAddress || '').trim();
    const suffix = (config.instanceName || '').trim();
    const dbType = normalizeDbType(config.dbType);
    const externalDbUrl = (config.externalDbUrl || '').trim();
    const externalDbUsername = (config.externalDbUsername || '').trim();
    const externalDbPassword = typeof config.externalDbPassword === 'string' ? config.externalDbPassword : '';

    function updateStatusFromEvent(event) {
      const text = event && event.step ? `${event.phase}:${event.step}` : (event && event.phase) || 'deploying';
      const fill = event && event.status === 'failed' ? 'red' : event && event.status === 'succeeded' ? 'green' : 'blue';
      node.status({ fill, shape: fill === 'red' ? 'ring' : 'dot', text });
    }

    node.on('input', function(msg, send, done) {
      send = send || node.send;

      if (!suffix || !domain || !kubeContent || !keyContent || !crtContent) {
        const err = new Error('Missing required configuration (instanceName, domain, kubeconfig, key, certificate).');
        node.error(err.message, msg);
        node.status({ fill: 'red', shape: 'ring', text: 'missing config' });
        msg.payload = err.message;
        send(msg);
        if (done) done(err);
        return;
      }

      if (dbType === 'external' && (!externalDbUrl || !externalDbUsername || !externalDbPassword)) {
        const err = new Error('External DB mode requires JDBC URL, username, and password.');
        node.error(err.message, msg);
        node.status({ fill: 'red', shape: 'ring', text: 'missing db config' });
        msg.payload = err.message;
        send(msg);
        if (done) done(err);
        return;
      }

      let kubeTmp;
      let keyTmp;
      let crtTmp;
      try {
        kubeTmp = writeTempFile('kube-', '.yaml', kubeContent);
        keyTmp = writeTempFile('key-', '.key', keyContent, 0o600);
        crtTmp = writeTempFile('crt-', '.crt', crtContent);
      } catch (e) {
        node.error(`Failed to write temp files: ${e.message}`, msg);
        node.status({ fill: 'red', shape: 'ring', text: 'file error' });
        msg.payload = e.message;
        send(msg);
        if (done) done(e);
        return;
      }

      const deployScript = path.join(__dirname, 'deploy.sh');
      const deployArgs = [
        suffix,
        domain,
        crtTmp.name,
        keyTmp.name,
        kubeTmp.name,
        dbType,
        dbType === 'external' ? externalDbUrl : '',
        dbType === 'external' ? externalDbUsername : '',
        dbType === 'external' ? externalDbPassword : ''
      ];
      const events = [];

      node.status({ fill: 'blue', shape: 'dot', text: `deploying (${dbType})` });
      runScriptStreaming(deployScript, deployArgs, {
        onStdoutLine: (line) => {
          const event = parseEventLine(line);
          if (event) {
            events.push(event);
            updateStatusFromEvent(event);
          }
        }
      }, (err, stdout, stderr) => {
        try { kubeTmp.removeCallback(); } catch (_) {}
        try { keyTmp.removeCallback(); } catch (_) {}
        try { crtTmp.removeCallback(); } catch (_) {}

        if (err) {
          const errorMsg = maskSecrets((stderr && stderr.trim()) || err.message);
          node.error(errorMsg, msg);
          node.status({ fill: 'red', shape: 'ring', text: 'deploy failed' });
          msg.payload = errorMsg;
          msg.deploymentEvents = events;
          send(msg);
          if (done) done(err);
          return;
        }

        const result = buildDeploymentPayload(stdout || '', domain);
        msg.payload = result.payload;
        msg.aasAuthUrl = result.payload.aasAuthUrl;
        msg.keyServerUrl = result.payload.keyServerUrl;
        msg.testUrl = result.payload.testUrl;
        msg.status = result.payload.status;
        msg.diagnostics = result.diagnostics;
        msg.dbType = dbType;
        msg.deploymentLogs = maskSecrets(stdout || 'Deployment succeeded.');
        msg.deploymentEvents = events;

        node.status({ fill: 'green', shape: 'dot', text: result.payload.status || 'deployed' });
        send(msg);
        if (done) done();
      });
    });

    node.on('close', function(removed, done) {
      if (!removed) return done();

      let kubeTmp;
      try {
        kubeTmp = writeTempFile('kube-', '.yaml', kubeContent);
      } catch (err) {
        node.warn(`uninstall: failed to write kubeconfig temp file: ${err.message}`);
        return done();
      }

      const uninstallScript = path.join(__dirname, 'uninstall.sh');
      const args = [suffix, kubeTmp.name];
      runScriptStreaming(uninstallScript, args, {}, () => {
        try { kubeTmp.removeCallback(); } catch (_) {}
        done();
      });
    });
  }

  RED.nodes.registerType('AAS-Stack', DeployNode);
};
