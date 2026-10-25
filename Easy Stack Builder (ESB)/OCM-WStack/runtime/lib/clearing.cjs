'use strict';
const {request}=require('./http.cjs');
const {fail,object}=require('./errors.cjs');
const {decode}=require('./credentials.cjs');
const providers=[
 {id:'gaia-lab',name:'Gaia-X Lab / Wizard',environment:'test',url:'https://wizard.lab.gaia-x.eu/',guide:'https://wizard.lab.gaia-x.eu/userGuide',requestSupported:true},
 {id:'deltadao',name:'deltaDAO / Pontus-X',environment:'production',url:'https://www.delta-dao.com/gaia-x',guide:'https://docs.onboarding.delta-dao.com/getting-started',requestSupported:false},
 {id:'directory',name:'Gaia-X Digital Clearing Houses',environment:'directory',url:'https://gaia-x.eu/services-deliverables/digital-clearing-house/',guide:'https://compliance.gaia-x.eu/',requestSupported:false}
];
class Clearing {
 constructor(fetcher=request){this.fetch=fetcher;}
 list(){return {items:providers,checkedAt:'2026-09-30',supportedGrant:'urn:ietf:params:oauth:grant-type:pre-authorized_code'};}
 async acquire(body){
  object(body,['provider','verifiablePresentation']);
  if(body.provider!=='gaia-lab')fail(422,'CLEARING_ONBOARDING_REQUIRED');
  const vp=body.verifiablePresentation;
  if(!vp||(typeof vp!=='string'&&typeof vp!=='object')||Buffer.byteLength(JSON.stringify(vp))>524288)fail(400,'SIGNED_PRESENTATION_REQUIRED');
  // Documented Gaia-X Wizard API. The signed presentation is explicitly
  // submitted by the user; organization/PCM access tokens are never forwarded.
  const r=await this.fetch('https://wizard.lab.gaia-x.eu/api/credential-offers',{method:'POST',body:{verifiablePresentation:vp},timeout:30000,maxBytes:1048576});
  const value=r?.jwt||r?.data;
  if(!value)fail(502,'CLEARING_RESPONSE_UNSUPPORTED');
  if(value.credential_offer||value.credential_offer_uri)return {state:'succeeded',offer:value,provider:'gaia-lab',environment:'test'};
  const parsed=decode(value),types=parsed.claims.type;
  if(!parsed.tokenClaims.iss&&!(Array.isArray(types)&&types.includes('VerifiableCredential'))&&types!=='VerifiableCredential')fail(502,'CLEARING_RESPONSE_UNSUPPORTED');
  return {state:'succeeded',credential:value,provider:'gaia-lab',environment:'test',stored:false};
 }
}
module.exports={Clearing,providers};
