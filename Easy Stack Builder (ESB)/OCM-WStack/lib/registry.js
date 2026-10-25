'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const ACCEPT='Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

function challenge(headers) {
  // Proxy CONNECT and informational responses can precede the actual response.
  const blocks=headers.split(/\r?\n\r?\n/).filter(x=>/^HTTP\/\S+\s+\d{3}/.test(x));
  const last=blocks.at(-1)||'';
  const line=last.split(/\r?\n/).find(x=>/^www-authenticate:\s*Bearer\s+/i.test(x));
  if(!line)throw new Error('Registry returned HTTP 401 without a supported Bearer challenge.');
  let rest=line.replace(/^www-authenticate:\s*Bearer\s+/i,'');const fields={};
  while(rest.trim()) {
    const match=/^\s*([a-z][a-z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s]+)\s*(?:,|$)/i.exec(rest);
    if(!match)throw new Error('Registry returned a malformed Bearer challenge.');
    const key=match[1].toLowerCase();
    if(Object.hasOwn(fields,key))throw new Error('Registry returned a duplicate Bearer challenge field.');
    fields[key]=match[2].startsWith('"')?match[2].slice(1,-1).replace(/\\(.)/g,'$1'):match[2];
    rest=rest.slice(match[0].length);
  }
  let realm;try {realm=new URL(fields.realm);}catch {throw new Error('Registry Bearer challenge has no valid token endpoint.');}
  if(realm.protocol!=='https:'||realm.username||realm.password||realm.hash)throw new Error('Registry token endpoint must use HTTPS without URL credentials.');
  return {realm,service:fields.service};
}
function imageManifest(doc) {
  if(doc?.schemaVersion!==2)return false;
  const config=/^(application\/vnd\.oci\.image\.config\.v1\+json|application\/vnd\.docker\.container\.image\.v1\+json)$/;
  const image=/^(application\/vnd\.oci\.image\.manifest\.v1\+json|application\/vnd\.docker\.distribution\.manifest\.v2\+json)$/;
  const index=/^(application\/vnd\.oci\.image\.index\.v1\+json|application\/vnd\.docker\.distribution\.manifest\.list\.v2\+json)$/;
  if(doc.mediaType&&!image.test(doc.mediaType)&&!index.test(doc.mediaType))return false;
  if(doc.config)return config.test(doc.config.mediaType||'');
  // A Helm artifact index is not evidence that this is a runnable image.
  return Array.isArray(doc.manifests)&&doc.manifests.some(x=>image.test(x.mediaType||'')&&!x.artifactType);
}

async function verifyImage(r,directory,{registry,repository,tag}) {
  const privateDir=await fs.mkdtemp(path.join(directory,'registry-'));await fs.chmod(privateDir,0o700);
  const body=path.join(privateDir,'body.json'),headers=path.join(privateDir,'headers.txt'),auth=path.join(privateDir,'authorization.txt');
  let authenticated=false;
  async function request(url,{head=false,token=false}={}) {
    for(const file of [body,headers])await fs.writeFile(file,'',{mode:0o600});
    const args=['--disable','--silent','--show-error','--max-time','30','--dump-header',headers,'--output',body,'--write-out','%{http_code}'];
    if(head)args.push('--head');
    if(!token)args.push('--header',ACCEPT);
    // The token stays out of process arguments and emitted events. Do not follow
    // redirects, which could send the token to a different host.
    if(authenticated&&!token)args.push('--header','@'+auth);
    args.push(url);
    const result=await r.run('curl',args,{timeout:35000});
    const status=Number(result.stdout.trim());
    if(!Number.isInteger(status)||status<100||status>599)throw new Error('Registry did not return a valid HTTP status.');
    return status;
  }
  try {
    const url=`https://${registry}/v2/${repository}/manifests/${tag}`;
    async function manifestRequest(head) {
      let status=await request(url,{head});
      if(status!==401||authenticated)return status;
      const {realm,service}=challenge(await fs.readFile(headers,'utf8'));
      // Request only this repository's pull scope, never server-supplied push
      // permissions. No cluster credentials or registry passwords are sent.
      realm.searchParams.delete('account');realm.searchParams.delete('offline_token');
      realm.searchParams.delete('scope');realm.searchParams.set('scope',`repository:${repository}:pull`);
      if(service)realm.searchParams.set('service',service);
      const tokenStatus=await request(realm.href,{token:true});
      if(tokenStatus!==200)throw new Error(`Anonymous registry token request returned HTTP ${tokenStatus}.${[401,403].includes(tokenStatus)?' Registry pull credentials may be required.':''}`);
      let tokenDoc;try {tokenDoc=JSON.parse(await fs.readFile(body,'utf8'));}catch {throw new Error('Registry token endpoint returned invalid JSON.');}
      const bearer=tokenDoc&&typeof tokenDoc==='object'&&(tokenDoc.token||tokenDoc.access_token);
      if(typeof bearer!=='string'||!bearer||/[\s\x00-\x1f\x7f]/.test(bearer))throw new Error('Registry token endpoint did not return a usable bearer token.');
      r.secrets.push(bearer,JSON.stringify(bearer).slice(1,-1));
      await fs.writeFile(auth,`Authorization: Bearer ${bearer}\n`,{mode:0o600});authenticated=true;
      return await request(url,{head});
    }
    let status=await manifestRequest(true);
    if(status!==200)throw new Error(`Policy manifest HEAD returned HTTP ${status}.${[401,403].includes(status)?' Anonymous pull access was not granted; registry pull credentials are required.':''}`);
    status=await manifestRequest(false);
    if(status!==200)throw new Error(`Policy manifest GET returned HTTP ${status}.${[401,403].includes(status)?' Anonymous pull access was not granted; registry pull credentials are required.':''}`);
    let manifest;try {manifest=JSON.parse(await fs.readFile(body,'utf8'));}catch {throw new Error('Registry manifest response is not valid JSON.');}
    if(!imageManifest(manifest))throw new Error('The tag does not contain a container image manifest.');
    return {authentication:authenticated?'anonymous-bearer':'anonymous'};
  } finally {await fs.rm(privateDir,{recursive:true,force:true});}
}
module.exports={verifyImage,challenge,imageManifest};
