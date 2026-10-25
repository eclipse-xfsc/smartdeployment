let config,accessToken,refreshToken,expires=0,pending;
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export async function setup(){const r=await fetch('/orce/ui-api/v1/auth/config',{cache:'no-store'});config=(await r.json()).data;const q=new URLSearchParams(location.search);
 if(q.has('code')||q.has('error')){
  const stored=sessionStorage.getItem('ocm.pkce');sessionStorage.removeItem('ocm.pkce');history.replaceState({},'', '/orce/');
  if(!stored)throw Error('AUTHENTICATION_REQUIRED');const p=JSON.parse(stored);
  if(q.get('state')!==p.state||Date.now()-p.created>600000||q.has('error'))throw Error('TOKEN_INVALID');
  await exchange({grant_type:'authorization_code',code:q.get('code'),code_verifier:p.verifier,redirect_uri:config.redirectUri});
 }
 return Boolean(accessToken);
}
async function exchange(data){const r=await fetch(config.issuer+'/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,...data}),cache:'no-store'});if(!r.ok)throw Error('AUTHENTICATION_REQUIRED');const t=await r.json();accessToken=t.access_token;refreshToken=t.refresh_token;expires=Date.now()+t.expires_in*1000;}
export async function login(){const verifier=b64(crypto.getRandomValues(new Uint8Array(48))),state=b64(crypto.getRandomValues(new Uint8Array(32))),challenge=b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));sessionStorage.setItem('ocm.pkce',JSON.stringify({verifier,state,created:Date.now()}));location.assign(config.issuer+'/protocol/openid-connect/auth?'+new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:'code',scope:'openid profile email',state,code_challenge:challenge,code_challenge_method:'S256'}));}
export async function token(){if(!accessToken)throw Error('AUTHENTICATION_REQUIRED');if(Date.now()>expires-30000){if(!pending)pending=exchange({grant_type:'refresh_token',refresh_token:refreshToken}).finally(()=>pending=null);await pending;}return accessToken;}
export function logout(){const refresh=refreshToken;accessToken=refreshToken=null;expires=0;sessionStorage.removeItem('ocm.pkce');if(refresh)fetch(config.issuer+'/protocol/openid-connect/logout',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,refresh_token:refresh}),keepalive:true}).catch(()=>{});location.assign('/orce/');}
