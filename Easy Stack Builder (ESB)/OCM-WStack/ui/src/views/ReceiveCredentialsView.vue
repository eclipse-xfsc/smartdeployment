<script>
import { h } from 'vue';
export default {
  props:{controller:{type:Object,required:true}},
  setup(props){
    const {s,t,walletControls,area,button,mutate,walletPath,input,select,lifecycleResults,table,pill,pre}=props.controller;
    return ()=>{
return [walletControls(),
  h('div',{class:'card'},[h('h3',t('receive')),h('p',t('offerHelp')),area('offer',s.offer,v=>s.offer=v),h('div',{class:'actions'},[button('import',()=>mutate(walletPath('/offers/import'),'POST',{offer:s.offer,source:'paste'}),'primary'),button('clearing',()=>change('clearing'))]),input('txCode',s.txCode,v=>s.txCode=v,'password'),null]),
  h('details',{class:'card'},[h('summary',t('importCredential')),h('p',t('importCredentialHelp')),area('credentialJson',s.rawCredential,v=>s.rawCredential=v),button('importCredential',()=>{let credential=s.rawCredential;try{credential=JSON.parse(credential);}catch{}return mutate(walletPath('/credentials/import'),'POST',{credential});})]),
  lifecycleResults(),s.result?.upstreamRequestId?h('div',{class:'banner'},[h('strong',t('requestId')+': '+s.result.upstreamRequestId),s.result.accepted===true?h('p',t(s.result.storageConfirmation==='confirmed'?'acceptedStored':'acceptedAwaitingStorage')):null,s.result.code?h('p',t(s.result.code)):null,s.result.storageError?h('p',s.result.storageError):null]):null,
  h('h3',t('pendingOffers')),table(['issuer','type','status','action'],s.items.map(o=>h('tr',{key:o.requestId},[h('td',o.issuer||t('unknown')),h('td',o.credentialConfigurationIds?.join(', ')),h('td',pill(o.state)),h('td',{class:'actions'},[button('accept',()=>mutate(walletPath('/offers/'+encodeURIComponent(o.requestId)+'/accept'),'POST',{...(s.txCode?{txCode:s.txCode}:{}),}),'primary'),button('reject',()=>mutate(walletPath('/offers/'+encodeURIComponent(o.requestId)+'/reject')))])])))];
    };
  }
};
</script>
