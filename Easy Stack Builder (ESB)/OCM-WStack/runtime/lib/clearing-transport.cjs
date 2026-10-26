'use strict';

const https = require('node:https');
const dns = require('node:dns');
const { BlockList, isIP } = require('node:net');
const { AppError, fail } = require('./errors.cjs');
const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(ip,bits,'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
blocked.addSubnet('2001::',23,'ipv6'); blocked.addSubnet('2001:db8::',32,'ipv6');
blocked.addSubnet('2002::',16,'ipv6');
function publicAddress(address) {
  const family=isIP(address);
  return family===4?!blocked.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!blocked.check(address,'ipv6');
}
function httpsUrl(value) {
  let url; try { url=new URL(value); } catch { fail(422,'CLEARING_ENDPOINT_INVALID'); }
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||isIP(url.hostname)||url.hostname.includes(':')) fail(422,'CLEARING_ENDPOINT_INVALID');
  return url;
}
// Resolve at connection time and use only the checked addresses. Redirects are rejected.
function lookup(host, options, callback) {
  dns.lookup(host,{all:true},(error,addresses)=>{
    if(error)return callback(error);
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))return callback(new AppError(422,'CLEARING_ENDPOINT_INVALID'));
    if(options.all)return callback(null,addresses);
    const address=addresses.find(a=>!options.family||a.family===options.family);
    if(!address)return callback(new AppError(503,'CLEARING_DNS_UNAVAILABLE'));
    callback(null,address.address,address.family);
  });
}
function request(value,{method='GET',body,headers={},text=false,timeout=20000}={}) {
  const url=httpsUrl(value);
  return new Promise((resolve,reject)=>{
    const data=body===undefined?null:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
    const req=https.request(url,{method,lookup,headers:{accept:text?'application/oauth-authz-req+jwt, text/plain':'application/json',...(data?{'content-type':'application/json','content-length':data.length}:{}),...headers}},res=>{
      const chunks=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>2097152)req.destroy(new AppError(502,'CLEARING_RESPONSE_TOO_LARGE'));else chunks.push(chunk);});
      res.on('error',()=>reject(new AppError(503,'CLEARING_CONNECTION_FAILED')));
      res.on('end',()=>{
        if(res.statusCode<200||res.statusCode>=300){const e=new AppError(502,'CLEARING_HTTP_REJECTED');e.upstreamStatus=res.statusCode;return reject(e);}
        const raw=Buffer.concat(chunks).toString();
        try {resolve(text?raw:raw?JSON.parse(raw):null);} catch {reject(new AppError(502,'CLEARING_RESPONSE_INVALID'));}
      });
    });
    const timer=setTimeout(()=>req.destroy(new AppError(504,'CLEARING_TIMEOUT')),timeout);
    req.on('close',()=>clearTimeout(timer));
    req.on('error',e=>reject(e instanceof AppError?e:new AppError(503,'CLEARING_CONNECTION_FAILED')));
    req.end(data);
  });
}
module.exports={request,httpsUrl,publicAddress};
