'use strict';

module.exports = function sessionSocket(socket, next) {
  const app = require('../../lib/runtime.cjs').instance();
  const request = { headers: { ...socket.handshake.headers,
    'x-csrf-token': socket.handshake.auth?.csrfToken } };
  let closed = false;
  let expiry;
  let revocation;
  const check = async () => {
    const context = await app.auth.fromRequest(request);
    app.auth.csrf(request, context);
    if (!context.permissions.length || context.passwordChangeRequired) throw Error('PERMISSION_DENIED');
    socket.data.ctx = context;
    return context;
  };
  const disconnect = () => { if (!closed) socket.disconnect(true); };
  const hint = async value => {
    try { await check(); if (!closed) socket.emit('ui:hint', { type: value.type, requiresRefresh: true }); }
    catch { disconnect(); }
  };
  check().then(context => {
    expiry = setTimeout(disconnect, Math.max(0, context.expiresAt * 1000 - Date.now()));
    revocation = setInterval(() => check().catch(disconnect), 5000);
    revocation.unref?.();
    socket.use((packet, done) => {
      check().then(context => {
        if (packet[0] !== 'ui:ack') throw Error('PERMISSION_DENIED');
        app.limit(context.subject + ':socket');
        done();
      }).catch(() => done(Error('PERMISSION_DENIED')));
    });
    app.events.on('hint', hint);
    socket.on('disconnect', () => {
      closed = true; clearTimeout(expiry); clearInterval(revocation);
      app.events.off('hint', hint);
    });
    next();
  }).catch(() => next(Error('AUTHENTICATION_REQUIRED')));
};
