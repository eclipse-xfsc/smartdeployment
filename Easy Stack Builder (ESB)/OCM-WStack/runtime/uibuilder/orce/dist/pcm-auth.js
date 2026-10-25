// Personal OCM context tokens stay in memory, separate from the organizational login.
import {token as organizationalToken} from './auth.js';
let config,accessToken,refreshToken,expires=0,refreshing;
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export async function configure(){
 const r=await fetch('/orce/ui-api/v1/auth/config',{cache:'no-store'});
 if(!r.ok)throw Error('CONFIGURATION_ERROR');config=(await r.json()).data.pcm;return config;
}
export function connected(){return Boolean(accessToken);}
export function disconnect(){accessToken=null;refreshToken=null;expires=0;}
async function exchange(data){
 const r=await fetch('/orce/ui-api/v1/pcm/token',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+await organizationalToken()},body:JSON.stringify(data),cache:'no-store'});
 if(!r.ok){disconnect();throw Error('PCM_AUTHENTICATION_REQUIRED');}
 const t=(await r.json()).data;accessToken=t.access_token;refreshToken=t.refresh_token||refreshToken;expires=Date.now()+t.expires_in*1000;
}
export async function login(){
 // Open synchronously in the click handler, before awaiting network/crypto.
 const popup=window.open('about:blank','ocm-pcm-login','popup,width=520,height=720');
 if(!popup)throw Error('POPUP_BLOCKED');
 try{
  if(!config)await configure();if(!config?.enabled)throw Error('PCM_NOT_CONFIGURED');
  const verifier=b64(crypto.getRandomValues(new Uint8Array(48))),state=b64(crypto.getRandomValues(new Uint8Array(32)));
  const challenge=b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
  await new Promise((resolve,reject)=>{
   const clear=()=>{window.removeEventListener('message',receive);clearTimeout(timer);clearInterval(closed);};
   const receive=e=>{
    if(e.origin!==location.origin||e.source!==popup||e.data?.type!=='pcm:callback')return;
    clear();popup.close();
    if(e.data.state!==state||e.data.error||typeof e.data.code!=='string')return reject(Error('PCM_AUTHENTICATION_REQUIRED'));
    exchange({grant_type:'authorization_code',code:e.data.code,code_verifier:verifier}).then(resolve,reject);
   };
   const timer=setTimeout(()=>{clear();popup.close();reject(Error('PCM_AUTHENTICATION_REQUIRED'));},300000);
   const closed=setInterval(()=>{if(popup.closed){clear();reject(Error('PCM_SIGN_IN_CANCELLED'));}},500);
   window.addEventListener('message',receive);
   popup.location=(config.authorizationEndpoint||config.issuer+'/protocol/openid-connect/auth')+'?'+new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:'code',scope:'openid profile email',state,code_challenge:challenge,code_challenge_method:'S256'});
  });
 }catch(e){popup.close();throw e;}
}
export async function token(){
 if(!accessToken)throw Error('PCM_AUTHENTICATION_REQUIRED');
 if(Date.now()>expires-30000){if(!refreshing)refreshing=exchange({grant_type:'refresh_token',refresh_token:refreshToken}).finally(()=>refreshing=null);await refreshing;}
 return accessToken;
}
if(location.pathname==='/orce/pcm/callback'){
 const q=new URLSearchParams(location.search);
 history.replaceState({},'',location.pathname);
 if(window.opener)window.opener.postMessage({type:'pcm:callback',code:q.get('code'),state:q.get('state'),error:q.get('error')},location.origin);
}
