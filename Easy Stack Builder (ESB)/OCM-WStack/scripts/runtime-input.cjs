'use strict';
const fs=require('node:fs');
function validate(c){
 for(const k of ['editorUsername','uiAdminUsername'])if(typeof c[k]!=='string'||!c[k]||c[k].length>64||!/^[A-Za-z0-9_.@-]+$/.test(c[k]))throw Error('Invalid '+k);
 if(typeof c.uiAdminEmail!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.uiAdminEmail))throw Error('Invalid UI administrator email');
 for(const k of ['editorPassword','uiAdminPassword'])if(typeof c[k]!=='string'||c[k].length<12||Buffer.byteLength(c[k])>72)throw Error('Administrator passwords must contain 12 to 72 bytes');
 for(const k of ['orceStorageSize','mongoStorageSize'])if(!/^[1-9][0-9]{0,3}Gi$/.test(c[k]||''))throw Error('Invalid '+k);
 if(c.storageClass&&!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(c.storageClass))throw Error('Invalid storage class');
 if(typeof c.useExternalMongo!=='boolean')throw Error('Invalid MongoDB mode');
 if(c.useExternalMongo&&(!/^mongodb(?:\+srv)?:\/\//.test(c.mongoUri||'')||c.mongoUri.length>8192))throw Error('External MongoDB requires a connection string');
 for(const name of ['offerIssuerHosts','relationshipHosts']){
  const raw=c[name]||'';if(typeof raw!=='string'||raw.length>2048)throw Error('Invalid approved hosts');
  const hosts=raw.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  if(hosts.some(x=>!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(x)))throw Error('Approved hosts must be bare DNS names');
  c[name]=hosts;
 }
 return c;
}
if(require.main===module){try{validate(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));}catch(e){console.error(e.message);process.exit(1);}}
module.exports={validate};
