'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const tls=require('../lib/tls'),{waitTenantTls}=require('../lib/gateway-routing'),{config}=require('../lib/config');
let dir,root,cert,key,material;
test.before(()=>{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'esb-test-pki-'));const openssl=args=>execFileSync('openssl',args,{cwd:dir,stdio:'pipe'});
 openssl(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-keyout','root.key','-out','root.crt','-days','2','-subj','/CN=ESB temporary test root','-addext','basicConstraints=critical,CA:TRUE']);
 openssl(['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj','/CN=*.example.com']);
 fs.writeFileSync(path.join(dir,'extensions'),'subjectAltName=DNS:*.example.com\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n');
 openssl(['x509','-req','-in','leaf.csr','-CA','root.crt','-CAkey','root.key','-CAcreateserial','-out','leaf.crt','-days','1','-extfile','extensions']);
 root=fs.readFileSync(path.join(dir,'root.crt'),'utf8');cert=fs.readFileSync(path.join(dir,'leaf.crt'),'utf8');key=fs.readFileSync(path.join(dir,'leaf.key'),'utf8');material={fullchain:cert,privateKey:key,...tls.validate(cert,key,['demo-tenant.example.com'],{roots:[root]})};
});
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const c=config({procedureVersion:12,domain:'example.com'});
const secret=()=>({type:'kubernetes.io/tls',data:{'tls.crt':Buffer.from(cert).toString('base64'),'tls.key':Buffer.from(key).toString('base64')}});
test('wildcard TLS covers tenant and dashboards, rejects wrong key, expiry, incomplete trust and nested hosts',()=>{
 assert.equal(tls.validate(cert,key,['demo-tenant.example.com','grafana.example.com','argocd.example.com'],{roots:[root]}).hosts.length,3);
 assert.throws(()=>tls.validate(cert,fs.readFileSync(path.join(dir,'root.key'),'utf8'),[c.tenantHost],{roots:[root]}),{code:'TLS_KEY_MISMATCH'});
 assert.throws(()=>tls.validate(cert,key,['a.b.example.com'],{roots:[root]}),{code:'TLS_HOSTNAME'});
 assert.throws(()=>tls.validate(cert,key,[c.tenantHost],{roots:[]}),{code:'TLS_CHAIN'});
 assert.throws(()=>tls.validate(cert,key,[c.tenantHost],{roots:[root],now:Date.now()+3*86400000}),{code:'TLS_EXPIRED'});
 assert.equal(tls.pem('base64:'+Buffer.from(key).toString('base64'),'key'),key);
});
test('TLS installation is idempotent, rotates a managed secret and refuses unmanaged collision',async()=>{
 let stored,writes=0;const r={secrets:[],emit(){},json:async()=>stored,run:async(cmd,args,o)=>{writes++;stored=JSON.parse(o.input);}};
 await tls.install(r,c,material);await tls.install(r,c,material);assert.equal(writes,1);assert.equal(stored.metadata.namespace,'ocm-wstack');assert.ok(r.secrets.includes(key));
 stored.data['tls.crt']='old';await tls.install(r,c,material);assert.equal(writes,2);
 stored.metadata.labels={};await assert.rejects(tls.install(r,c,material),{code:'TLS_OWNERSHIP'});
});
test('uploaded TLS is programmed without querying ACME or changing cert-manager, including a gateway IP change',async()=>{
 let time=0;const events=[],reads=[];const r={emit:e=>events.push(e),json:async(cmd,args)=>{reads.push(args);if(args.includes('secret'))return secret();if(args.includes('listenerset'))return {metadata:{generation:2},spec:{listeners:[{hostname:c.tenantHost,tls:{certificateRefs:[{name:tls.secretName(c)}]}}]},status:{conditions:[{type:'Programmed',status:time>=6000?'True':'False',observedGeneration:2}]}};if(args.includes('services'))return {items:[{metadata:{name:'dynamic-service'},spec:{type:'LoadBalancer',clusterIP:time?'100.64.2.3':'100.64.2.2',ports:[{port:80},...(time>=6000?[{port:443}]:[])]}}]};throw Error('Unexpected query');}};
 await waitTenantTls(r,{...c,internalGatewayRouting:true},{now:()=>time,sleep:async ms=>{time+=ms;}});
 assert.ok(reads.every(a=>!a.includes('certificate')&&!a.includes('deployments')&&!a.includes('challenges.acme.cert-manager.io')));assert.equal(events.at(-1).certificateSource,'uploaded');assert.equal(events.at(-1).clusterIP,'100.64.2.3');assert.equal(events.at(-1).httpsPortReady,true);
});
test('configuration always deploys the UI and supplied TLS without legacy public self-check mode',()=>{
 assert.equal(c.tlsMode,'uploaded');assert.equal(config({procedureVersion:12,domain:'*.example.com',runtimeEnabled:false,gatewayRouting:'public',pcm:{enabled:true}}).runtimeEnabled,true);assert.equal(c.gatewayRouting,'internal');assert.deepEqual(c.pcm,{enabled:false});
});
