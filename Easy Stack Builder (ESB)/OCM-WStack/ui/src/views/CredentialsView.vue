<script>
import { h } from 'vue';
export default {
  props:{controller:{type:Object,required:true}},
  setup(props){
    const {s,t,input,select,act,load,table,pill,detail,button}=props.controller;
    return ()=>{
return [
  s.counts&&s.loaded?h('div',{class:'stats'},[['total',s.counts.total],['active',s.counts.active],['expired',s.counts.expired],['revoked',s.counts.revoked],['not_checked',s.counts.notChecked]].map(([k,n])=>h('div',{class:'stat-card'},[h('span',t(k)),h('strong',String(n))]))):null,
  h('form',{class:'filter-bar',onSubmit:e=>{e.preventDefault();s.cursor=null;act(()=>load());}},[
   input('search',s.query,v=>s.query=v),select('sort',s.sort,[['issuedAt','issued'],['expiresAt','expires'],['id','credentialId']],v=>s.sort=v),
   select('direction',s.direction,[['desc','newest'],['asc','oldest']],v=>s.direction=v),select('status',s.status,[['','all'],['active','active'],['expired','expired'],['revoked','revoked'],['suspended','suspended'],['not_yet_valid','not_yet_valid'],['not_checked','not_checked']],v=>s.status=v),
   h('button',{type:'submit',class:'primary',disabled:s.busy},t('search'))]),
  h('p',{class:'muted'},t('statusHelp')),
  table(['type','issuer','status','expires','action'],s.items.map(d=>h('tr',{key:d.id},[h('td',[h('strong',d.types?.join(', ')||t('unknown')),h('small',{class:'row-id'},d.id)]),h('td',{class:'identity-cell'},d.issuer?.id||t('unknown')),h('td',[pill(d.status?.state),d.status?.reason?h('small',{class:'row-id'},d.status.reason):null]),h('td',d.expiresAt?new Date(d.expiresAt).toLocaleDateString(s.locale):'—'),h('td',button('view',()=>detail(d.id)))]))),
  h('div',{class:'pagination'},[h('span',s.loaded?t('total')+': '+s.total:''),select('pageSize',String(s.pageSize),[['10','10'],['25','25'],['50','50'],['100','100']],v=>{s.pageSize=Number(v);s.cursor=null;act(()=>load());}),button('back',()=>{s.cursor=null;act(()=>load());}),button('next',()=>{s.cursor=s.next;act(()=>load());},'',s.busy||!s.next)])];
    };
  }
};
</script>
