// orce.js
module.exports = function(RED) {
    const { exec }  = require('child_process');
    const fs        = require('fs');
    const tmp       = require('tmp');
    const path      = require('path');

    function DeployNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // presets
        const kubeContent           = config.kubeconfigContent;
        const keyContent            = config.privateKeyContent;
        const crtContent            = config.certificateContent;
        const domain                = config.domainAddress;
        const suffix                = config.instanceName;
        const adminUser             = config.username;
        const adminPass             = config.password;
        const deploymentType        = config.deploymentType; // not needed yet
        const deploymentPathType    = config.deploymentPathType; // not needed yet

        let storedClientSecret = null;

        // generating temp files
        function writeTempFiles() {
            const kubeTmp = tmp.fileSync({ prefix: 'kube-', postfix: '.yaml' });
            fs.writeFileSync(kubeTmp.name, kubeContent);
            const keyTmp = tmp.fileSync({ prefix: 'key-', postfix: '.key' });
            fs.writeFileSync(keyTmp.name, keyContent);
            const crtTmp = tmp.fileSync({ prefix: 'crt-', postfix: '.crt' });
            fs.writeFileSync(crtTmp.name, crtContent);
            return { kubeTmp, keyTmp, crtTmp };
        }


        node.on('input', function(msg) {
            // deploy
            let kubeTmp, keyTmp, crtTmp;
            try {
                ({ kubeTmp, keyTmp, crtTmp } = writeTempFiles());
            } catch (err) {
                node.error(`Failed to write temp files: ${err.message}`, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'file error' });
                return;
            }

            const args = [ suffix, kubeTmp.name, domain, crtTmp.name, keyTmp.name, adminUser, adminPass ];
            const deployScript = path.join(__dirname, 'deploy.sh');
            const cmd = `bash ${JSON.stringify(deployScript)} ` + args.map(a => JSON.stringify(a)).join(' ');

            node.log(`Executing: ${cmd}`);
            node.status({ fill: 'blue', shape: 'dot', text: 'deploying' });

            exec(cmd, { cwd: __dirname }, (err, stdout, stderr) => {
                try { kubeTmp.removeCallback(); keyTmp.removeCallback(); crtTmp.removeCallback(); } catch (_) {}
                if (err) {
                    const errorMsg = stderr || err.message;
                    node.error(errorMsg, msg);
                    node.status({ fill: 'red', shape: 'ring', text: 'deploy failed' });
                    msg.payload = errorMsg;
                    node.send(msg);
                    return;
                }

                node.status({ fill: 'green', shape: 'dot', text: 'deployed' });
                node.send(msg);
            });
        });

        node.on('close', function(removed, done) {
            if (removed) {
                let kubeTmp;
                try {
                    kubeTmp = tmp.fileSync({ prefix: 'kube-', postfix: '.yaml' });
                    fs.writeFileSync(kubeTmp.name, kubeContent);
                } catch (err) {
                    node.warn(`uninstall: failed to write kubeconfig temp file: ${err.message}`);
                    done();
                    return;
                }
                const args = [ suffix, kubeTmp.name ];
                const uninstallScript = path.join(__dirname, 'uninstall.sh');
                const cmd = `bash ${JSON.stringify(uninstallScript)} ` + args.map(a => JSON.stringify(a)).join(' ');
                node.log(`🔄 Running uninstall: ${cmd}`);
                exec(cmd, { cwd: __dirname }, (err, stdout, stderr) => {
                    try { kubeTmp.removeCallback(); } catch (_) {}
                    if (err) {
                        node.error(`uninstall failed: ${stderr||err.message}`);
                    } else {
                        node.log(`uninstall output:\n${stdout}`);
                    }
                    done();
                });
            } else {
                done();
            }
        });
    }

    RED.nodes.registerType("Orchestration Engine", DeployNode);
};
