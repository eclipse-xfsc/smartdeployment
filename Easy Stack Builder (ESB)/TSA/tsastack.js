module.exports = function(RED) {
  const { exec } = require('child_process');
  const fs = require('fs');
  const tmp = require('tmp');
  const path = require('path');

  function DeployNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const kubeContent = config.kubeconfigContent;
    const keyContent = config.privateKeyContent;
    const crtContent = config.certificateContent;
    const domain = config.domainAddress;
    const namespace = config.instanceName;
    const policyRepoUrl = config.policyRepoUrl || 'https://github.com/eclipse-xfsc/rego-policies';
    const policyRepoFolder = config.policyRepoFolder || '';

    function writeTempFiles() {
      const kubeTmp = tmp.fileSync({ prefix: 'kube-', postfix: '.yaml' });
      fs.writeFileSync(kubeTmp.name, kubeContent, { encoding: 'utf8' });

      const keyTmp = tmp.fileSync({ prefix: 'key-', postfix: '.key' });
      fs.writeFileSync(keyTmp.name, keyContent, { encoding: 'utf8', mode: 0o600 });

      const crtTmp = tmp.fileSync({ prefix: 'crt-', postfix: '.crt' });
      fs.writeFileSync(crtTmp.name, crtContent, { encoding: 'utf8' });

      return { kubeTmp, keyTmp, crtTmp };
    }

    function parseOutput(stdout) {
      const out = { tsaUrl: '', keyId: '', policyStatus: '', status: '' };
      String(stdout || '').split(/\r?\n/).forEach((line) => {
        if (line.startsWith('TSA_URL=')) out.tsaUrl = line.slice(8).trim();
        if (line.startsWith('KEY_ID=')) out.keyId = line.slice(7).trim();
        if (line.startsWith('POLICY_STATUS=')) out.policyStatus = line.slice(14).trim();
        if (line.startsWith('STATUS=')) out.status = line.slice(7).trim();
      });
      return out;
    }

    node.on('input', function(msg, send, done) {
      send = send || node.send;

      if (!namespace || !domain || !kubeContent || !keyContent || !crtContent) {
        const err = new Error('Missing required configuration (instanceName, domain, kubeconfig, key, certificate).');
        node.error(err.message, msg);
        node.status({ fill: 'red', shape: 'ring', text: 'missing config' });
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
      const args = [namespace, domain, crtTmp.name, keyTmp.name, kubeTmp.name, policyRepoUrl, policyRepoFolder];
      const cmd = `bash ${JSON.stringify(deployScript)} ` + args.map(a => JSON.stringify(a)).join(' ');

      node.status({ fill: 'blue', shape: 'dot', text: 'deploying' });
      exec(cmd, { cwd: __dirname, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
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

        const parsed = parseOutput(stdout);
        msg.payload = parsed.tsaUrl ? parsed : (stdout || 'Deployment succeeded.');
        msg.logs = stdout;
        node.status({ fill: 'green', shape: 'dot', text: parsed.status || 'deployed' });
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
      const args = [namespace, kubeTmp.name];
      const cmd = `bash ${JSON.stringify(uninstallScript)} ` + args.map(a => JSON.stringify(a)).join(' ');
      exec(cmd, { cwd: __dirname }, () => {
        try { kubeTmp.removeCallback(); } catch (_) {}
        done();
      });
    });
  }

  RED.nodes.registerType('tsastack', DeployNode);
};
