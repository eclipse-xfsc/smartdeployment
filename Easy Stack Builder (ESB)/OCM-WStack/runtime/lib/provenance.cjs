'use strict';
const {summarize,decode}=require('./credentials.cjs');
const {fail}=require('./errors.cjs');
function didUrl(did){
 if(typeof did!=='string'||!did.startsWith('did:web:'))return null;
 try{const parts=did.slice(8).split(':').map(decodeURIComponent);const host=parts.shift();const u=new URL('https://'+host+'/'+(parts.length?parts.map(encodeURIComponent).join('/')+'/did.json':'.well-known/did.json'));
  if(u.username||u.password||u.hash||u.search)return null;return u.href;
 }catch{return null;}
}
// Read-side join only: an identity match is a declared relationship, not a proof.
function graph(records,key){
 if(!Object.hasOwn(records,key))fail(404,'RESOURCE_NOT_FOUND');
 const all=Object.entries(records).flatMap(([id,raw])=>{try{return [summarize(id,raw)];}catch{return [];}});
 const selected=new Map(),visited=new Set();let frontier=[all.find(x=>x.id===key)].filter(Boolean);
 for(let depth=0;frontier.length&&depth<8;depth++){
  const next=[];
  for(const c of frontier){if(visited.has(c.id))continue;visited.add(c.id);selected.set(c.id,c);
   if(selected.size>=40)break;
   for(const other of all)if(!visited.has(other.id)&&((c.issuer.id&&other.subject.id===c.issuer.id)||(c.subject.id&&other.issuer.id===c.subject.id)))next.push(other);
  }
  if(selected.size>=40)break;frontier=next;
 }
 const nodes=new Map(),edges=[];
 for(const c of selected.values()){
  const credential='credential:'+c.id;nodes.set(credential,{id:credential,kind:'credential',label:c.types.join(', ')||c.id,credentialId:c.id,issuedAt:c.issuedAt,expiresAt:c.expiresAt});
  for(const [role,value] of [['issuer',c.issuer.id],['holder',c.subject.id]])if(value){
   const entity='identity:'+value;nodes.set(entity,{id:entity,kind:'identity',label:value,url:didUrl(value)});
   edges.push({from:role==='issuer'?entity:credential,to:role==='issuer'?credential:entity,role,evidence:'credential-declaration',verified:false});
  }
  if(!c.subject.id&&c.holder?.kind==='key-binding'){
   const binding='holder-key:'+c.id;nodes.set(binding,{id:binding,kind:'identity',label:c.holder.label,url:null});
   edges.push({from:credential,to:binding,role:'holder',evidence:'credential-key-binding-declaration',verified:false});
  }
 }
 const raw=decode(records[key]).claims;
 return {root:'credential:'+key,nodes:[...nodes.values()],edges,source:'wallet-credential-declarations',verified:false,truncated:selected.size>=40,declaredEvidence:raw.evidence||null};
}
module.exports={graph,didUrl};
