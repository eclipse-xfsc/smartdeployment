'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {register}=require('../../runtime/lib/browser-routes.cjs');
test('local cookie authentication registers no OAuth or PCM callback',()=>{
 const paths=[];register({settings:{httpNodeRoot:'/'},httpNode:{get:path=>paths.push(path)}});assert.deepEqual(paths,[]);
});
