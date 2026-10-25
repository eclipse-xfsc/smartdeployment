'use strict';
const config=require('./lib/config.cjs').load();
module.exports={
 uiPort:1880,flowFile:'flows.json',userDir:'/data',credentialSecret:config.credentialSecret,
 httpAdminRoot:'/_orce-editor',httpNodeRoot:'/',
 adminAuth:{type:'credentials',users:[{username:config.editorUsername,password:config.editorHash,permissions:'*'}]},
 editorTheme:{projects:{enabled:false}},functionExternalModules:false,externalModules:{autoInstall:false},
 httpNodeMiddleware(req,res,next){
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' "+new URL(config.issuer).origin+"; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if(req.url.split('?')[0]==='/orce/auth/callback')req.url='/orce/';
  next();
 },
 apiMaxLength:'1mb',
 uibuilder:{uibRoot:'/data/uibuilder',socketOptions:{path:'/orce/socket.io',serveClient:true,maxHttpBufferSize:65536,connectionStateRecovery:{maxDisconnectionDuration:0,skipMiddlewares:false},cors:{origin:config.publicOrigin,credentials:false}}},
 logging:{console:{level:'warn',metrics:false,audit:false}}
};
