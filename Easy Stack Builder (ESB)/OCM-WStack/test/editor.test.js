'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');

test('editor reveals relevant DNS fields, safely previews the endpoint and preserves uploaded kubeconfig newlines',async()=>{
  const html=fs.readFileSync(path.join(__dirname,'../ocmwstack.html'),'utf8');
  const dom=new JSDOM('<body></body>',{runScripts:'outside-only'});const w=dom.window;
  const fragment=html.match(/<script type="text\/html" data-template-name="OCM-W-Stack">([\s\S]*?)<\/script>/)[1];
  w.document.body.innerHTML=fragment;
  function $(selector){const nodes=typeof selector==='string'?[...w.document.querySelectorAll(selector)]:[selector];return {
    val(v){if(v===undefined)return nodes[0]?.value;nodes.forEach(n=>n.value=v);return this;},
    prop(k,v){if(v===undefined)return nodes[0]?.[k];nodes.forEach(n=>n[k]=v);return this;},
    toggle(v){nodes.forEach(n=>n.style.display=v?'':'none');return this;},
    text(v){nodes.forEach(n=>n.textContent=v);return this;},
    on(event,fn){nodes.forEach(n=>n.addEventListener(event,fn));return this;},
    trigger(event){nodes.forEach(n=>n.dispatchEvent(new w.Event(event)));return this;}
  };}
  let definition;w.$=$;w.RED={nodes:{registerType:(name,def)=>{assert.equal(name,'OCM-W-Stack');definition=def;}},notify:()=>{}};
  w.eval(html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1]);
  for(const [key,val] of Object.entries(definition.defaults)){const el=w.document.getElementById('node-input-'+key);if(el){if(el.type==='checkbox')el.checked=val.value;else el.value=val.value;}}
  definition.oneditprepare.call({});
  const visible=id=>w.document.getElementById(id).style.display!=='none';
  assert.equal(visible('esb-ocm-dns-fields'),false);assert.equal(visible('esb-ocm-manual-dns'),true);
  $('#node-input-externalDns').prop('checked',true).trigger('change');assert.equal(visible('esb-ocm-dns-fields'),true);
  $('#node-input-dnsProvider').val('ionos').trigger('change');assert.equal(visible('esb-ocm-dns-token'),true);assert.equal(visible('esb-ocm-dns-custom'),false);
  $('#node-input-dnsProvider').val('custom').trigger('change');assert.equal(visible('esb-ocm-dns-token'),false);assert.equal(visible('esb-ocm-dns-custom'),true);
  $('#node-input-domainAddress').val('example.com').trigger('input');$('#node-input-tenantId').val('company_one').trigger('input');
  assert.equal(w.document.getElementById('esb-ocm-tenant-preview').textContent,'Tenant endpoint: https://company-one.example.com');
  $('#node-input-domainAddress').val('<img onerror="alert(1)">').trigger('input');assert.equal(w.document.querySelectorAll('#esb-ocm-tenant-preview img').length,0);
  for(const secret of ['kubeconfig','dnsToken','dnsSecretData']){assert.equal(definition.credentials[secret].type,'password');assert.equal(definition.defaults[secret],undefined);}
  const kubeText='apiVersion: v1\nclusters:\n  - name: test\n';
  const upload=w.document.getElementById('esb-ocm-kube-file');
  Object.defineProperty(upload,'files',{value:[new w.File([kubeText],'cluster.yaml',{type:'text/yaml'})]});
  await new Promise(resolve=>{$('#node-input-kubeconfig').on('change',resolve);upload.dispatchEvent(new w.Event('change'));});
  const stored=$('#node-input-kubeconfig').val();assert.ok(stored.startsWith('base64:'));assert.equal(Buffer.from(stored.slice(7),'base64').toString('utf8'),kubeText);
  dom.window.close();
});
