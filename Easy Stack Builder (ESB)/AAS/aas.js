module.exports = function(RED) {
  const { execFile } = require('child_process');
  const fs = require('fs');
  const tmp = require('tmp');
  const path = require('path');

  function pickOutputValue(text, key) {
    const match = (text || '').match(new RegExp('^' + key + '=(.*)$', 'm'));
    return match ? match[1].trim() : '';
  }

  function buildDeploymentPayload(stdout) {
    return {
      authServerUrl: pickOutputValue(stdout, 'AUTH_SERVER_URL'),
      keyServerUrl: pickOutputValue(stdout, 'KEY_SERVER_URL'),
      keycloakAdminUsername: pickOutputValue(stdout, 'KEYCLOAK_ADMIN_USERNAME'),
      keycloakAdminPassword: pickOutputValue(stdout, 'KEYCLOAK_ADMIN_PASSWORD'),
      iatToken: pickOutputValue(stdout, 'IAT_TOKEN')
    };
  }

  function normalizeDbType(value) {
    return String(value || '').trim().toLowerCase() === 'external' ? 'external' : 'embedded';
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

    function writeTempFiles() {
      const kubeTmp = tmp.fileSync({ prefix: 'kube-', postfix: '.yaml' });
      fs.writeFileSync(kubeTmp.name, kubeContent, { encoding: 'utf8' });

      const keyTmp = tmp.fileSync({ prefix: 'key-', postfix: '.key' });
      fs.writeFileSync(keyTmp.name, keyContent, { encoding: 'utf8', mode: 0o600 });

      const crtTmp = tmp.fileSync({ prefix: 'crt-', postfix: '.crt' });
      fs.writeFileSync(crtTmp.name, crtContent, { encoding: 'utf8' });

      return { kubeTmp, keyTmp, crtTmp };
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

      let kubeTmp, keyTmp, crtTmp;
      try {
        ({ kubeTmp, keyTmp, crtTmp } = writeTempFiles());
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

      node.log(`Executing deploy.sh for instance ${suffix} using ${dbType} database mode`);
      node.status({ fill: 'blue', shape: 'dot', text: `deploying (${dbType})` });

      execFile('bash', [deployScript].concat(deployArgs), {
        cwd: __dirname,
        maxBuffer: 10 * 1024 * 1024
      }, (err, stdout, stderr) => {
        try { kubeTmp.removeCallback(); } catch (_) {}
        try { keyTmp.removeCallback(); } catch (_) {}
        try { crtTmp.removeCallback(); } catch (_) {}

        if (err) {
          const errorMsg = (stderr && stderr.trim()) || err.message;
          node.error(errorMsg, msg);
          node.status({ fill: 'red', shape: 'ring', text: 'deploy failed' });
          msg.payload = errorMsg;
          send(msg);
          if (done) done(err);
          return;
        }

        const deploymentPayload = buildDeploymentPayload(stdout || '');
        msg.payload = deploymentPayload;
        msg.authServerUrl = deploymentPayload.authServerUrl;
        msg.keyServerUrl = deploymentPayload.keyServerUrl;
        msg.keycloakAdminUsername = deploymentPayload.keycloakAdminUsername;
        msg.keycloakAdminPassword = deploymentPayload.keycloakAdminPassword;
        msg.iatToken = deploymentPayload.iatToken;
        msg.dbType = dbType;
        msg.deploymentLogs = stdout || 'Deployment succeeded.';

        node.status({ fill: 'green', shape: 'dot', text: 'deployed' });
        send(msg);
        if (done) done();
      });
    });

    node.on('close', function(removed, done) {
      if (!removed) return done();

      let kubeTmp;
      try {
        kubeTmp = tmp.fileSync({ prefix: 'kube-', postfix: '.yaml' });
        fs.writeFileSync(kubeTmp.name, kubeContent, { encoding: 'utf8' });
      } catch (err) {
        node.warn(`uninstall: failed to write kubeconfig temp file: ${err.message}`);
        return done();
      }

      const uninstallScript = path.join(__dirname, 'uninstall.sh');
      const args = [suffix, kubeTmp.name];
      node.log(`Running uninstall for instance ${suffix}`);

      execFile('bash', [uninstallScript].concat(args), {
        cwd: __dirname,
        maxBuffer: 10 * 1024 * 1024
      }, (err, stdout, stderr) => {
        try { kubeTmp.removeCallback(); } catch (_) {}
        if (err) node.error(`uninstall failed: ${(stderr && stderr.trim()) || err.message}`);
        else node.log(`uninstall output:\n${stdout}`);
        done();
      });
    });
  }

  RED.nodes.registerType('AAS-Stack', DeployNode);
};