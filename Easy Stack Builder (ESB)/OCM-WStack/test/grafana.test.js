'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {validate}=require('../lib/grafana');
test('one default with unique datasource definitions passes',()=>{assert.equal(validate({wrapper:{datasources:[{name:'Prometheus',uid:'prometheus',isDefault:true},{name:'Loki',uid:'loki'}]},empty:{datasources:null}}),2);});
test('duplicate defaults across separate provisioning files fail',()=>{assert.throws(()=>validate({wrapper:{datasources:[{name:'Prometheus',uid:'prometheus',isDefault:true}]},dependency:{datasources:[{name:'Default',uid:'default',isDefault:true}]}}),{code:'GRAFANA_DATASOURCES'});});
test('duplicate UID or name fails even without multiple defaults',()=>{for(const ds of [{name:'Another',uid:'prometheus'},{name:'Prometheus',uid:'another'}])assert.throws(()=>validate({files:{datasources:[{name:'Prometheus',uid:'prometheus',isDefault:true},ds]}}),{code:'GRAFANA_DATASOURCES'});});
