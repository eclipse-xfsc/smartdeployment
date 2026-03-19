module.exports = function(RED) {
  const { exec } = require('child_process');
  const fs = require('fs');
  const tmp = require('tmp');
  const path = require('path');

  function DeployNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const namespace = config.instanceName;
    const ocmwNamespace = config.ocmwNamespace;
    const domain = config.domainAddress;
    const email = config.emailAddress || "";
    const ocmAddress = config.ocmAddress || "";
    const crtContent = config.certificateContent;
    const keyContent = config.privateKeyContent;
    const kubeContent = config.kubeconfigContent;
    const registryPrefix = config.registryImagePrefix;
    const registryUser = config.registryUserName;
    const registryPass = config.registryPassword;
    const deployLegacyLogin = String(config.deployLegacyLogin) === 'true' || config.deployLegacyLogin === true;

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

      if (!namespace || !ocmwNamespace || !domain || !crtContent || !keyContent || !kubeContent || !registryPrefix || !registryUser || !registryPass) {
        const err = new Error('Missing required configuration');
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
      const args = [
        namespace,
        ocmwNamespace,
        domain,
        crtTmp.name,
        keyTmp.name,
        kubeTmp.name,
        registryPrefix,
        registryUser,
        registryPass,
        email,
        ocmAddress,
        deployLegacyLogin ? 'true' : 'false'
      ];
      const cmd = `bash ${JSON.stringify(deployScript)} ` + args.map(a => JSON.stringify(a)).join(' ');

      node.log(`Executing: ${cmd}`);
      node.status({ fill: 'blue', shape: 'dot', text: 'deploying' });

      exec(cmd, { cwd: __dirname, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
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

        node.status({ fill: 'green', shape: 'dot', text: 'deployed' });
        msg.payload = stdout || 'Deployment succeeded.';
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
      const args = [ namespace, kubeTmp.name ];
      const cmd = `bash ${JSON.stringify(uninstallScript)} ` + args.map(a => JSON.stringify(a)).join(' ');
      node.log(`Running uninstall: ${cmd}`);

      exec(cmd, { cwd: __dirname, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        try { kubeTmp.removeCallback(); } catch (_) {}
        if (err) node.error(`uninstall failed: ${(stderr && stderr.trim()) || err.message}`);
        else node.log(`uninstall output:\n${stdout}`);
        done();
      });
    });
  }

  RED.nodes.registerType('tsastack', DeployNode);
};
