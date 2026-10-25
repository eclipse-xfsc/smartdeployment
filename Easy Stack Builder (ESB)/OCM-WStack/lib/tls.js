'use strict';
const crypto=require('node:crypto'),tls=require('node:tls');
const {fail}=require('./config');
function pem(value,name){
 if(typeof value!=='string'||!value||value==='__PWRD__')fail('TLS_CONFIGURATION','Upload the wildcard fullchain certificate and matching private key in Domain & certificate.');
 if(value.startsWith('base64:'))value=Buffer.from(value.slice(7),'base64').toString('utf8');
 if(Buffer.byteLength(value)>131072||!value.includes('-----BEGIN '))fail('TLS_CONFIGURATION',name+' must be a PEM file smaller than 128 KiB.');
 return value.trim()+'\n';
}
function validate(fullchain,privateKey,hosts,{now=Date.now(),roots=tls.rootCertificates}={}){
 let chain,key;
 try{const blocks=fullchain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);if(!blocks?.length)throw Error();chain=blocks.map(p=>new crypto.X509Certificate(p));key=crypto.createPrivateKey(privateKey);}catch{fail('TLS_CONFIGURATION','The certificate chain or unencrypted private key is not valid PEM.');}
 if(!chain[0].checkPrivateKey(key))fail('TLS_KEY_MISMATCH','The private key does not match the leaf certificate.');
 for(const cert of chain)if(Date.parse(cert.validFrom)>now||Date.parse(cert.validTo)<=now)fail('TLS_EXPIRED','The certificate chain contains an expired or not-yet-valid certificate.');
 for(const host of hosts)if(!chain[0].checkHost(host,{subject:'never',partialWildcards:false,multiLabelWildcards:false,singleLabelSubdomains:false}))fail('TLS_HOSTNAME','The certificate does not cover '+host+'.');
 for(let i=0;i<chain.length-1;i++)if(!chain[i].verify(chain[i+1].publicKey)||!chain[i+1].ca)fail('TLS_CHAIN','The fullchain must contain the leaf certificate followed by its signing intermediates.');
 const tail=chain.at(-1);
 const trusted=roots.some(p=>{try{const root=new crypto.X509Certificate(p);return tail.fingerprint256===root.fingerprint256||tail.checkIssued(root)&&tail.verify(root.publicKey);}catch{return false;}});
 if(!trusted)fail('TLS_CHAIN','The supplied chain does not link to a public trusted root. Include every intermediate certificate in fullchain order.');
 return {fingerprint:chain[0].fingerprint256,expiresAt:new Date(chain[0].validTo).toISOString(),hosts};
}
function configuration(c,credentials){
 const fullchain=pem(credentials.tlsCertificate,'Fullchain certificate'),privateKey=pem(credentials.tlsPrivateKey,'Private key');
 const hosts=[c.tenantHost,...(c.publicDashboards?['argocd','grafana'].map(n=>n+'.'+c.domain):[])];
 return {fullchain,privateKey,...validate(fullchain,privateKey,hosts)};
}
function secretName(c){return 'esb-'+c.tenantRelease+'-tls';}
function ready(secret,host){
 try{const cert=new crypto.X509Certificate(Buffer.from(secret.data['tls.crt'],'base64'));return secret.type==='kubernetes.io/tls'&&cert.checkPrivateKey(crypto.createPrivateKey(Buffer.from(secret.data['tls.key'],'base64')))&&Date.parse(cert.validFrom)<=Date.now()&&Date.parse(cert.validTo)>Date.now()&&Boolean(cert.checkHost(host,{subject:'never',partialWildcards:false,multiLabelWildcards:false,singleLabelSubdomains:false}));}catch{return false;}
}
async function install(r,c,material,namespace='ocm-wstack'){
 const name=secretName(c),old=await r.json('kubectl',['-n',namespace,'get','secret',name,'--ignore-not-found','-o','json']);
 if(old&&old.metadata.labels?.['app.kubernetes.io/managed-by']!=='esb-ocmwstack')fail('TLS_OWNERSHIP','An unmanaged Secret already exists at '+namespace+'/'+name+'.');
 const data={'tls.crt':Buffer.from(material.fullchain).toString('base64'),'tls.key':Buffer.from(material.privateKey).toString('base64')};
 if(r.secrets)r.secrets.push(material.privateKey,data['tls.key']);
 if(old&&Object.entries(data).every(([k,v])=>old.data?.[k]===v))return name;
 const doc={apiVersion:'v1',kind:'Secret',metadata:{name,namespace,labels:{'app.kubernetes.io/managed-by':'esb-ocmwstack','app.kubernetes.io/instance':c.instanceName}},type:'kubernetes.io/tls',data};
 await r.run('kubectl',['apply','--server-side','--field-manager=esb-ocm-tls','-f','-'],{input:JSON.stringify(doc)});
 r.emit({type:'tls-installed',namespace,secret:name,hostname:c.tenantHost,fingerprint:material.fingerprint,expiresAt:material.expiresAt});
 return name;
}
module.exports={pem,validate,configuration,secretName,ready,install};
