'use strict';
const fs=require('node:fs');
function load(){
 const c=JSON.parse(fs.readFileSync(process.env.OCM_RUNTIME_CONFIG||'/data/config.json','utf8'));
 const secrets=JSON.parse(fs.readFileSync(process.env.OCM_RUNTIME_SECRETS||'/run/ocm-secrets/secrets.json','utf8'));
 for(const k of ['publicOrigin','issuer','jwks','keycloakInternal','realm','tenant','account','group','clientId','cryptoNamespace','holderKey'])if(typeof c[k]!=='string'||!c[k])throw Error('Missing config key '+k);
 if(typeof c.cryptoGroup!=='string')throw Error('Missing config key cryptoGroup');
 if(!c.publicOrigin.startsWith('https://')||new URL(c.publicOrigin).origin!==c.publicOrigin)throw Error('Invalid public origin');
 for(const k of ['mongoUri','adminClientSecret','editorUsername','editorHash','credentialSecret','offerKey'])if(typeof secrets[k]!=='string'||!secrets[k])throw Error('Missing secret key '+k);
 if(Buffer.from(secrets.offerKey,'hex').length!==32)throw Error('Invalid offer key');
 return {...c,...secrets};
}
module.exports={load};
