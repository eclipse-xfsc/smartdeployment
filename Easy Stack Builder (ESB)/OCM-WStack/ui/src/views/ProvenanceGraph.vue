<script>
import { h } from 'vue';
export default {
  props:{controller:{type:Object,required:true},graph:{type:Object,required:true}},
  setup(props){
    const {s,t,date,pre}=props.controller;
    return ()=>{
const g=props.graph;
  const entities=g.nodes.filter(n=>n.kind==='identity'),creds=g.nodes.filter(n=>n.kind==='credential'),positions=new Map();
  entities.forEach((n,i)=>positions.set(n.id,{x:20,y:24+i*100}));creds.forEach((n,i)=>positions.set(n.id,{x:420,y:24+i*100}));
  const height=Math.max(entities.length,creds.length,1)*100+25;
  return h('div',{class:'provenance'},[h('div',{class:'graph-scroll'},[h('svg',{viewBox:'0 0 800 '+height,role:'img','aria-label':t('provenance')},[
   h('defs',h('marker',{id:'arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse'},h('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#64748b'}))),
   ...g.edges.map(e=>{const a=positions.get(e.from),b=positions.get(e.to),left=a.x<b.x;return h('path',{d:`M ${a.x+(left?350:0)} ${a.y+32} C 395 ${a.y+32}, 395 ${b.y+32}, ${b.x+(left?0:350)} ${b.y+32}`,fill:'none',stroke:'#94a3b8','stroke-width':2,'marker-end':'url(#arrow)'},[h('title',t(e.role))]);}),
   ...g.nodes.map(n=>{const p=positions.get(n.id);return h('g',{transform:`translate(${p.x} ${p.y})`},[h('rect',{width:350,height:65,rx:10,fill:n.kind==='credential'?'#eff6ff':'#f8fafc',stroke:n.id===g.root?'#2563eb':'#cbd5e1'}),h('text',{x:12,y:25,fill:'#111827','font-size':12},n.label.length>44?n.label.slice(0,41)+'…':n.label),h('text',{x:12,y:47,fill:'#64748b','font-size':11},n.kind==='credential'?date(n.issuedAt):t('identity')),h('title',n.label)]);})
  ])]),h('ul',{class:'identity-links'},entities.filter(n=>n.url).map(n=>h('li',h('a',{href:n.url,target:'_blank',rel:'noopener noreferrer'},n.label)))),h('p',{class:'muted'},t('graphUnverified')),g.native?.result?h('details',[h('summary',t('nativeChainComposition')),pre(g.native.result)]):null,g.cycles?.length?h('p',t('graphCycles')+': '+g.cycles.length):null,g.truncated?h('p',{role:'status'},t('graphTruncated')):null,g.unresolvedReferences?.length?h('details',[h('summary',t('unresolvedReferences')),pre(g.unresolvedReferences)]):null,g.native?h('p',{class:'muted'},t('nativeChain')+': '+t(g.native.state)+(g.native.reason?' · '+g.native.reason:'')):null]);
 
    };
  }
};
</script>
