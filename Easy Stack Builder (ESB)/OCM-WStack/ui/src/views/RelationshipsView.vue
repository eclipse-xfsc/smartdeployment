<script>
import { h } from 'vue';
export default {
  props:{controller:{type:Object,required:true}},
  setup(props){
    const {s,t,can,table,button,mutate,area,input,act,api,pre}=props.controller;
    return ()=>{
return [can('relationships.write')?h('div',{class:'card'},[h('h3',t('relationships')),h('div',{class:'actions'},[button('createInvitation',()=>mutate('/relationships/invitations'),'primary')]),area('invitation',s.invitation,v=>s.invitation=v),button('acceptInvitation',()=>mutate('/relationships/accept','POST',{invitation:s.invitation})),input('label',s.label,v=>s.label=v)]):null,
  table(['did','label','issuer','holder','credential','direction','status','action'],s.items.map(x=>h('tr',{key:x.did},[h('td',x.did),h('td',x.label),...['issuer','holder','credential','direction','status'].map(k=>h('td',x[k]||t('unknown'))),h('td',{class:'actions'},[button('view',()=>act(async()=>s.result=await api('/relationships/'+encodeURIComponent(x.did)))),...(can('relationships.write')?[button('save',()=>mutate('/relationships/'+encodeURIComponent(x.did),'PATCH',{label:s.label})),...['block','unblock'].map(a=>button(a,()=>mutate('/relationships/'+encodeURIComponent(x.did)+'/'+a))),button('remove',()=>mutate('/relationships/'+encodeURIComponent(x.did),'DELETE'),'danger')]:[])])]))),s.result?.invitation?h('div',{class:'card'},[h('pre',s.result.invitation),button('copyInvitation',()=>act(()=>navigator.clipboard.writeText(s.result.invitation)))]):s.result?pre(s.result):null];
    };
  }
};
</script>
