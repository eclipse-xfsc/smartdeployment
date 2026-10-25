'use strict';
module.exports=function(socket,next){
 const app=require('../../lib/runtime.cjs').instance();
 if(socket.handshake.headers.origin!==app.c.publicOrigin)return next(new Error('ORIGIN_FORBIDDEN'));
 app.auth.verify(socket.handshake.auth?.token).then(c=>{
  if(!c.permissions.length)return next(new Error('PERMISSION_DENIED'));
  socket.data.ctx=c;
  const expiry=setTimeout(()=>socket.disconnect(true),Math.max(0,c.expiresAt*1000-Date.now()));
  // This channel accepts no business mutations. All actions use the protected HTTP API.
  socket.use((packet,done)=>{if(Date.now()>=c.expiresAt*1000||packet[0]!=='ui:ack')return done(new Error('PERMISSION_DENIED'));try{app.limit(c.subject+':socket');done();}catch{done(new Error('RATE_LIMITED'));}});
  const onHint=hint=>{if(c.expiresAt*1000>Date.now())socket.emit('ui:hint',{type:hint.type,requiresRefresh:true});};
  app.events.on('hint',onHint);socket.on('disconnect',()=>{clearTimeout(expiry);app.events.off('hint',onHint);});next();
 }).catch(()=>next(new Error('AUTHENTICATION_REQUIRED')));
};
