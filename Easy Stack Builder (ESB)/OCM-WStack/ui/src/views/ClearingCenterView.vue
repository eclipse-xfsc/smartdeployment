<script>
import {h} from 'vue';
export default {props:{controller:{type:Object,required:true}},setup(props){
 const {s,t,button,select,act,api,load}=props.controller;
 return ()=>{
return s.providers.map(p=>h('article',{class:'card',key:p.id},[
  h('h3',p.name),h('p',[h('a',{href:p.url,target:'_blank',rel:'noopener noreferrer'},p.url)]),h('p',p.protocol+' · '+p.trustScope),
  h('p',t('clearingHelp')),p.code?h('p',{role:'status'},t(p.code)):null,
  ...s.clearingInputs.map(item=>select(item.id,s.clearingSelection[item.id]||'',[['','selectCredential'],...item.credentials.map(c=>[c.id,c.credentialId||c.id])],value=>s.clearingSelection[item.id]=value)),
  s.clearingInputs.some(item=>!item.credentials.length)?h('p',{role:'status'},t('clearingMissing')):null,
  button('requestCredential',()=>act(async()=>{
    if(!confirm(t('clearingConfirm')+' '+p.url))return;
    const result=await api('/clearing/requests','POST',{provider:p.id,credentials:{...s.clearingSelection}});
    s.result=result;await load();
  }),'primary',s.busy||!p.requestSupported||s.clearingInputs.length!==3||s.clearingInputs.some(item=>!item.credentials.some(c=>c.id===s.clearingSelection[item.id]))||s.clearingJobs.some(j=>!['succeeded','failed','unknown','received'].includes(j.state))),
  ...s.clearingJobs.map(job=>h('section',{class:'card',key:job.id,'aria-live':'polite'},[
    h('strong',t('clearingPhase_'+job.phase)),h('p',t(job.state)),h('small',job.id),
    job.code?h('p',{role:'status'},t(job.code)+(job.httpStatus?' (HTTP '+job.httpStatus+')':'')):null,
    job.state==='unknown'?h('p',t('clearingUnknown')):null,
    job.credentialId?h('p',t('clearingStored')+': '+job.credentialId):null,
    job.state==='received'?button('clearingStore',()=>act(async()=>{await api('/clearing/requests/'+encodeURIComponent(job.id)+'/store','POST');await load();})):null
  ]))
]));
 };
}};
</script>
