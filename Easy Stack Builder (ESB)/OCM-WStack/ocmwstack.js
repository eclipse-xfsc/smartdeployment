module.exports = function(RED) {
  const { exec } = require('child_process');
  const fs       = require('fs');
  const tmp      = require('tmp');
  const path     = require('path');

  function DeployNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Required config from the editor
    const kubeContent = config.kubeconfigContent;
    const keyContent  = config.privateKeyContent;
    const crtContent  = config.certificateContent;
    const domain      = config.domainAddress;
    const suffix      = config.instanceName;
    const email       = config.emailAddress;

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
      // prefer Node-RED 1.0+ send/done, fallback for older
      send = send || node.send;

      // Basic guardrails
      if (!suffix || !domain || !email || !kubeContent || !keyContent || !crtContent) {
        const err = new Error("Missing required configuration (instanceName, domain, email, kubeconfig, key, certificate).");
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
      const args = [ suffix, domain, crtTmp.name, keyTmp.name, email, kubeTmp.name ];
      const cmd = `bash ${JSON.stringify(deployScript)} ` + args.map(a => JSON.stringify(a)).join(' ');

      node.log(`Executing: ${cmd}`);
      node.status({ fill: 'blue', shape: 'dot', text: 'deploying' });

      exec(cmd, { cwd: __dirname }, (err, stdout, stderr) => {
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
        msg.payload = stdout || "Deployment succeeded.";
        send(msg);
        if (done) done();
      });
    });

    node.on('close', function(removed, done) {
      if (!removed) return done();

      // On delete: run uninstall with instanceName + kubeconfig
      let kubeTmp;
      try {
        kubeTmp = tmp.fileSync({ prefix: 'kube-', postfix: '.yaml' });
        fs.writeFileSync(kubeTmp.name, kubeContent, { encoding: 'utf8' });
      } catch (err) {
        node.warn(`uninstall: failed to write kubeconfig temp file: ${err.message}`);
        return done();
      }

      const uninstallScript = path.join(__dirname, 'uninstall.sh');
      const args = [ suffix, kubeTmp.name ];
      const cmd = `bash ${JSON.stringify(uninstallScript)} ` + args.map(a => JSON.stringify(a)).join(' ');
      node.log(`🔄 Running uninstall: ${cmd}`);

      exec(cmd, { cwd: __dirname }, (err, stdout, stderr) => {
        try { kubeTmp.removeCallback(); } catch (_) {}
        if (err) node.error(`uninstall failed: ${(stderr && stderr.trim()) || err.message}`);
        else node.log(`uninstall output:\n${stdout}`);
        done();
      });
    });
  }

  RED.nodes.registerType("OCM-W-Stack", DeployNode);
};
