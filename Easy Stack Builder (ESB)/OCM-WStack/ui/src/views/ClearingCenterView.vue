<script>
import { h } from 'vue';
export default {
  props:{controller:{type:Object,required:true}},
  setup(props){
    const {s,t,button}=props.controller;
    return ()=>{
return s.providers.map(p=>h('article',{class:'card',key:p.id},[h('h3',p.name),h('p',p.url),h('p',p.protocol),h('p',{role:'status'},t(p.code||'CLEARING_CONTRACT_UNVERIFIED')),button('requestCredential',()=>{},'primary',true)]));
    };
  }
};
</script>
