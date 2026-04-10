module.exports = function(RED) {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const tmp = require('tmp');

  const RESERVED_NAMES = new Set(['default', 'kube-system', 'kube-public', 'kube-node-lease', 'ingress-nginx', 'cert-manager']);

  function writeTempFile(prefix, postfix, content, mode) {
    const file = tmp.fileSync({ prefix, postfix });
    fs.writeFileSync(file.name, content, { encoding: 'utf8', mode });
    return file;
  }

  function maskSecrets(text) {
    return String(text || '')
      .replace(/(CLIENT_SECRET=)([^\n]+)/g, '$1[masked]')
      .replace(/(client-secret["=: ]+)([^\n]+)/gi, '$1[masked]')
      .replace(/(password["=: ]+)([^\n]+)/gi, '$1[masked]')
      .replace(/(token["=: ]+)([^\n]+)/gi, '$1[masked]');
  }

  function pickOutputValue(text, key) {
    const match = String(text || '').match(new RegExp('^' + key + '=(.*)$', 'm'));
    return match ? match[1].trim() : '';
  }

  function isBareDomain(value) {
    const domain = String(value || '').trim();
    return /^([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/.test(domain) && !domain.startsWith('http://') && !domain.startsWith('https://') && !domain.includes('/');
  }

  function validateLocalConfig(config) {
    const errors = [];
    const instanceName = String(config.instanceName || '').trim();
    const ocmInstanceName = String(config.ocmInstanceName || '').trim();
    const domain = String(config.domainAddress || '').trim();
    const kube = String(config.kubeconfigContent || '');
    const key = String(config.privateKeyContent || '');
    const cert = String(config.certificateContent || '');
    const expirationDays = Number(config.expirationDays || 0);

    if (!instanceName) errors.push('PCM instance name is required.');
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(instanceName)) errors.push('PCM instance name must be a valid Kubernetes namespace.');
    if (RESERVED_NAMES.has(instanceName)) errors.push('PCM instance name uses a reserved namespace.');
    if (!ocmInstanceName) errors.push('OCM instance name is required.');
    if (!isBareDomain(domain)) errors.push('Domain must be a bare FQDN without scheme or path.');
    if (!/(apiVersion:|clusters:|contexts:|current-context:)/m.test(kube)) errors.push('kubeconfig content is missing expected YAML sections.');
    if (!/BEGIN CERTIFICATE/.test(cert)) errors.push('TLS certificate must be PEM encoded.');
    if (!/BEGIN (RSA |EC |)?PRIVATE KEY/.test(key)) errors.push('TLS private key must be PEM encoded.');
    if (!String(config.registryRepository || '').trim()) errors.push('Registry repository is required.');
    if (!String(config.registryUserName || '').trim()) errors.push('Registry username is required.');
    if (!String(config.registryPassword || '').trim()) errors.push('Registry password is required.');
    if (!String(config.credentialType || '').trim()) errors.push('Credential type is required.');
    if (!String(config.issuerBinding || '').trim()) errors.push('Issuer binding is required.');
    if (!Number.isFinite(expirationDays) || expirationDays <= 0) errors.push('Expiration days must be a positive number.');
    if (!String(config.revocationMode || '').trim()) errors.push('Revocation mode is required.');
    if (!String(config.trustFrameworkId || '').trim()) errors.push('Trust framework identifier is required.');
    return errors;
  }

  function validateOutputContract(payload) {
    ['pcmUrl', 'issuerId', 'keycloakUrl', 'clientSecret', 'status'].forEach((key) => {
      if (!payload[key] || typeof payload[key] !== 'string') throw new Error(`Output contract validation failed: missing ${key}`);
    });
    if (!/^https:\/\//.test(payload.pcmUrl) || !/^https:\/\//.test(payload.keycloakUrl)) {
      throw new Error('Output contract validation failed: URLs must be https:// URLs.');
    }
    return payload;
  }

  function buildPayload(stdout, domain, issuerBinding) {
    return validateOutputContract({
      pcmUrl: pickOutputValue(stdout, 'PCM_URL') || `https://cloud-wallet.${domain}`,
      issuerId: pickOutputValue(stdout, 'ISSUER_ID') || issuerBinding,
      keycloakUrl: pickOutputValue(stdout, 'KEYCLOAK_URL') || `https://auth-cloud-wallet.${domain}`,
      clientSecret: pickOutputValue(stdout, 'CLIENT_SECRET') || '[unavailable]',
      status: pickOutputValue(stdout, 'STATUS') || 'Deployed'
    });
  }

  function createLineReader(onLine) {
    let buffer = '';
    return (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      parts.forEach((line) => onLine(line));
    };
  }

  function parseEventLine(line) {
    if (!String(line || '').startsWith('EVENT_JSON=')) return null;
    try { return JSON.parse(line.slice('EVENT_JSON='.length)); } catch (error) { return null; }
  }

  function runScriptStreaming(scriptPath, args, handlers, callback) {
    const child = spawn('bash', [scriptPath].concat(args), { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const onStdout = createLineReader((line) => {
      stdout += `${line}\n`;
      if (handlers && typeof handlers.onStdoutLine === 'function') handlers.onStdoutLine(line);
    });
    const onStderr = createLineReader((line) => {
      stderr += `${line}\n`;
      if (handlers && typeof handlers.onStderrLine === 'function') handlers.onStderrLine(line);
    });
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', (error) => callback(error, stdout, stderr));
    child.on('close', (code) => {
      if (code !== 0) return callback(new Error((stderr || `script exited with code ${code}`).trim()), stdout, stderr);
      return callback(null, stdout, stderr);
    });
  }

  function DeployNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    function updateStatusFromEvent(event) {
      const text = event && event.step ? `${event.phase}:${event.step}` : (event && event.phase) || 'deploying';
      const fill = event && event.status === 'succeeded' ? 'green' : event && event.status === 'failed' ? 'red' : 'blue';
      node.status({ fill, shape: fill === 'red' ? 'ring' : 'dot', text });
    }

    node.on('input', function(msg, send, done) {
      send = send || node.send;
      const localErrors = validateLocalConfig(config);
      if (localErrors.length > 0) {
        const error = new Error(localErrors.join(' '));
        node.error(error.message, msg);
        node.status({ fill: 'red', shape: 'ring', text: 'invalid config' });
        msg.payload = error.message;
        send(msg);
        if (done) done(error);
        return;
      }

      let kubeTmp; let keyTmp; let crtTmp;
      try {
        kubeTmp = writeTempFile('kube-', '.yaml', config.kubeconfigContent);
        keyTmp = writeTempFile('key-', '.key', config.privateKeyContent, 0o600);
        crtTmp = writeTempFile('crt-', '.crt', config.certificateContent);
      } catch (error) {
        node.error(`Failed to write temp files: ${error.message}`, msg);
        node.status({ fill: 'red', shape: 'ring', text: 'file error' });
        msg.payload = error.message;
        send(msg);
        if (done) done(error);
        return;
      }

      const args = [
        config.instanceName.trim(),
        config.ocmInstanceName.trim(),
        config.domainAddress.trim(),
        crtTmp.name,
        keyTmp.name,
        kubeTmp.name,
        config.registryRepository.trim(),
        config.registryUserName.trim(),
        config.registryPassword,
        String(config.credentialType || '').trim(),
        String(config.issuerBinding || '').trim(),
        String(config.expirationDays || '').trim(),
        String(config.revocationMode || '').trim(),
        String(config.trustFrameworkId || '').trim()
      ];
      const events = [];
      const preflightScript = path.join(__dirname, 'preflight.sh');
      const deployScript = path.join(__dirname, 'deploy.sh');

      node.status({ fill: 'blue', shape: 'dot', text: 'preflight' });
      runScriptStreaming(preflightScript, args, {}, (preflightError) => {
        if (preflightError) {
          try { kubeTmp.removeCallback(); } catch (_) {}
          try { keyTmp.removeCallback(); } catch (_) {}
          try { crtTmp.removeCallback(); } catch (_) {}
          node.error(preflightError.message, msg);
          node.status({ fill: 'red', shape: 'ring', text: 'preflight failed' });
          msg.payload = preflightError.message;
          send(msg);
          if (done) done(preflightError);
          return;
        }

        node.status({ fill: 'blue', shape: 'dot', text: 'deploying' });
        runScriptStreaming(deployScript, args, {
          onStdoutLine: (line) => {
            const event = parseEventLine(line);
            if (event) {
              events.push(event);
              updateStatusFromEvent(event);
            }
          }
        }, (error, stdout, stderr) => {
          try { kubeTmp.removeCallback(); } catch (_) {}
          try { keyTmp.removeCallback(); } catch (_) {}
          try { crtTmp.removeCallback(); } catch (_) {}

          if (error) {
            const errorMessage = maskSecrets((stderr && stderr.trim()) || error.message);
            node.error(errorMessage, msg);
            node.status({ fill: 'red', shape: 'ring', text: 'deploy failed' });
            msg.payload = errorMessage;
            msg.deploymentEvents = events;
            send(msg);
            if (done) done(error);
            return;
          }

          try {
            const payload = buildPayload(stdout, config.domainAddress.trim(), String(config.issuerBinding || '').trim());
            msg.payload = payload;
            msg.pcmUrl = payload.pcmUrl;
            msg.issuerId = payload.issuerId;
            msg.keycloakUrl = payload.keycloakUrl;
            msg.status = payload.status;
            msg.deploymentEvents = events;
            msg.deploymentLogs = maskSecrets(stdout);
            if (stderr && stderr.trim()) msg.deploymentStderr = maskSecrets(stderr.trim());
            node.status({ fill: 'green', shape: 'dot', text: payload.status });
            send(msg);
            if (done) done();
          } catch (validationError) {
            node.error(validationError.message, msg);
            node.status({ fill: 'red', shape: 'ring', text: 'output invalid' });
            msg.payload = validationError.message;
            msg.deploymentLogs = maskSecrets(stdout);
            send(msg);
            if (done) done(validationError);
          }
        });
      });
    });

    node.on('close', function(removed, done) {
      if (!removed) return done();
      let kubeTmp;
      try {
        kubeTmp = writeTempFile('kube-', '.yaml', config.kubeconfigContent || '');
      } catch (error) {
        node.warn(`uninstall: failed to write kubeconfig temp file: ${error.message}`);
        return done();
      }
      const uninstallScript = path.join(__dirname, 'uninstall.sh');
      const args = [String(config.instanceName || '').trim(), kubeTmp.name, String(config.ocmInstanceName || '').trim()];
      runScriptStreaming(uninstallScript, args, {}, () => {
        try { kubeTmp.removeCallback(); } catch (_) {}
        done();
      });
    });
  }

  RED.nodes.registerType('pcmcloud', DeployNode);
};
