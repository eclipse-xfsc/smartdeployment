<script>
import { h } from 'vue';
export default {
  props:{controller:{type:Object,required:true}},
  setup(props){
    const {s,t,walletControls,select,input,area,button,act,mutate,walletPath,lifecycleResults,api,pre,download}=props.controller;
    return ()=>{
const type=s.types.find(x=>x.id===s.type);return [walletControls(),type?.demo?h('div',{class:'banner'},[h('strong',t('demo')),h('p',t('demoHelp'))]):null,
  h('div',{class:'card'},[select('type',s.type,s.types.map(x=>[x.id,x.name||x.id]),v=>{s.type=v;s.claims={};s.advancedClaims='{}';}),...Object.entries(type?.fields||{}).map(([k])=>input(k,s.claims[k]||'',v=>s.claims[k]=v)),!Object.keys(type?.fields||{}).length?area('claims',s.advancedClaims,v=>s.advancedClaims=v):null,type?.schema?h('details',[h('summary',t('schema')),pre(type.schema)]):null,
   button('review',()=>act(async()=>{const claims=Object.keys(type?.fields||{}).length?s.claims:JSON.parse(s.advancedClaims);await mutate(walletPath('/issuance'),'POST',{credentialConfigurationId:s.type,claims});}),'primary',s.busy||!type||type.available===false)]),
  lifecycleResults(),s.result?h('div',{class:'card'},[h('h3',t('result')),s.result.requestId?button('inspectOperation',()=>act(async()=>{s.result=await api(walletPath('/issuance/'+encodeURIComponent(s.result.requestId)));})):null,s.result.offerQr?h('img',{src:s.result.offerQr,alt:t('offerQr'),width:280,height:280}):null,s.result.offerUrl?h('div',[h('p',t('shareOfferHelp')),h('pre',s.result.offerUrl),h('div',{class:'actions'},[button('copyOffer',()=>act(()=>navigator.clipboard.writeText(s.result.offerUrl))),button('download',()=>download(s.result.offer,'credential-offer.json'))])]):pre(s.result)]):null];
    };
  }
};
</script>
