'use strict';
// A real DOM plus the pinned Vue runtime. No component/rendering mocks.
const vm=require('node:vm');
async function environment(url){
 const {parseHTML}=process.env.ESB_TEST_DOM_PATH?await import(process.env.ESB_TEST_DOM_PATH):await import('linkedom');
 const dom=parseHTML('<!doctype html><html><body><div id="app"></div></body></html>');
 // linkedom implements the browser DOM without a layout engine. Supply the
 // standard select setter used by Vue; its getter is implemented upstream.
 Object.defineProperty(dom.window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.options].find(x=>x.selected)?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.selected=o.value===String(v);}});
 const errors=[];
 const w={document:dom.document,location:new URL(url),Element:dom.window.Element,SVGElement:dom.window.SVGElement,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,AbortController,URL,URLSearchParams,TextEncoder,Blob,crypto:require('node:crypto').webcrypto,queueMicrotask,setTimeout,clearTimeout,setInterval,clearInterval,navigator:{},console:{...console,error:e=>errors.push(String(e))}};
 w.window=w;w.close=()=>{};w.eval=source=>vm.runInContext(source,context,{filename:'ocm-ui.js'});const context=vm.createContext(w);return {window:w,errors};
}
module.exports={environment};
