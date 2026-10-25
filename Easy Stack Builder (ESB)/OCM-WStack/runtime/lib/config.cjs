'use strict';
const fs = require('node:fs');

function load() {
  const config = JSON.parse(fs.readFileSync(process.env.OCM_RUNTIME_CONFIG || '/data/config.json', 'utf8'));
  const secrets = JSON.parse(fs.readFileSync(process.env.OCM_RUNTIME_SECRETS || '/run/ocm-secrets/secrets.json', 'utf8'));
  for (const key of ['publicOrigin', 'tenant', 'account', 'group', 'cryptoNamespace', 'holderKey', 'uiAdminUsername']) {
    if (typeof config[key] !== 'string' || !config[key]) throw Error('Missing config key ' + key);
  }
  if (typeof config.cryptoGroup !== 'string') throw Error('Missing config key cryptoGroup');
  if (!config.publicOrigin.startsWith('https://') || new URL(config.publicOrigin).origin !== config.publicOrigin) {
    throw Error('Invalid public origin');
  }
  for (const key of ['mongoUri', 'editorUsername', 'editorHash', 'credentialSecret', 'offerKey', 'uiAdminHash']) {
    if (typeof secrets[key] !== 'string' || !secrets[key]) throw Error('Missing secret key ' + key);
  }
  if (!/^[a-f0-9]{64}$/i.test(secrets.offerKey)) throw Error('Invalid application encryption key');
  if (config.pcm?.enabled) throw Error('PCM is outside the approved scope');
  return { ...config, ...secrets };
}
module.exports = { load };
