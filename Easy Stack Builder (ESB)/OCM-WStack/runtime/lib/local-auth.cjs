'use strict';

const { randomBytes, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { fail, object, string } = require('./errors.cjs');

const SESSION_SECONDS = 24 * 60 * 60;
const COOKIE_NAME = '__Secure-ocm_session';
const digest = value => createHash('sha256').update(value).digest('hex');

function password(value) {
  if (typeof value !== 'string' || [...value].length < 12 || Buffer.byteLength(value, 'utf8') > 72 || /[\x00-\x1f\x7f]/.test(value)) {
    fail(400, 'PASSWORD_POLICY');
  }
  return value;
}

function cookieToken(req) {
  const values = (req.headers.cookie || '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(COOKIE_NAME + '='));
  if (values.length !== 1) fail(401, 'AUTHENTICATION_REQUIRED');
  const token = values[0].slice(COOKIE_NAME.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'AUTHENTICATION_REQUIRED');
  return token;
}

class LocalAuth {
  constructor(config, db, roles, now = Date.now) {
    this.c = config;
    this.db = db;
    this.roles = roles;
    this.now = now;
  }

  async init() {
    await this.db.collection('ui_sessions').createIndex({ tokenHash: 1 }, { unique: true });
    await this.db.collection('ui_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.db.collection('ui_sessions').createIndex({ subject: 1 });
    await this.db.collection('ui_login_limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // A real cost-12 hash makes unknown-user and incorrect-password paths comparable.
    this.dummyHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
  }

  sameOrigin(req) {
    if (req.headers.origin !== this.c.publicOrigin) fail(403, 'ORIGIN_FORBIDDEN');
    if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') {
      fail(403, 'ORIGIN_FORBIDDEN');
    }
  }

  async login(req, res, body) {
    this.sameOrigin(req);
    object(body, ['username', 'password']);
    string(body.username, 1, 128);
    string(body.password, 1, 1024);
    const username = body.username.toLowerCase();
    // Shared Mongo counters apply across processes. Expired windows are never reused.
    const window = Math.floor(this.now() / 900000);
    const keys = ['account:' + digest(username), 'peer:' + digest(req.socket?.remoteAddress || 'unknown')];
    for (const key of keys) {
      const counter = await this.db.collection('ui_login_limits').findOneAndUpdate(
        { _id: key + ':' + window },
        { $inc: { attempts: 1 }, $set: { expiresAt: new Date((window + 1) * 900000) } },
        { upsert: true, returnDocument: 'after', includeResultMetadata: false }
      );
      if (counter.attempts > (key.startsWith('account:') ? 10 : 50)) fail(429, 'LOGIN_RATE_LIMITED');
    }
    const user = await this.db.collection('ui_users').findOne({ username });
    const valid = await bcrypt.compare(body.password, user?.passwordHash || this.dummyHash);
    if (!user?.enabled || !valid || Buffer.byteLength(body.password, 'utf8') > 72) {
      await this.audit('login', 'denied', user?.id || null);
      fail(401, 'AUTHENTICATION_REQUIRED');
    }
    const token = randomBytes(32).toString('base64url');
    const csrfToken = this.csrfToken(digest(token));
    const createdAt = new Date(this.now());
    const expiresAt = new Date(createdAt.getTime() + SESSION_SECONDS * 1000);
    await this.audit('login', 'succeeded', user.id);
    await this.db.collection('ui_sessions').insertOne({
      tokenHash: digest(token), csrfHash: digest(csrfToken), subject: user.id,
      authVersion: user.authVersion, createdAt, expiresAt
    });
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/orce/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`);
    return { csrfToken, expiresAt: expiresAt.toISOString(), passwordChangeRequired: Boolean(user.passwordChangeRequired) };
  }

  async verify(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'AUTHENTICATION_REQUIRED');
    const session = await this.db.collection('ui_sessions').findOne({ tokenHash: digest(token) });
    // TTL deletion is housekeeping. Every request enforces the absolute deadline.
    if (!session || !(session.expiresAt instanceof Date) || session.expiresAt.getTime() <= this.now()) {
      fail(401, 'AUTHENTICATION_REQUIRED');
    }
    const user = await this.db.collection('ui_users').findOne({ id: session.subject });
    if (!user?.enabled || user.authVersion !== session.authVersion) fail(401, 'AUTHENTICATION_REQUIRED');
    return {
      subject: user.id, username: user.username, tenant: this.c.tenant,
      account: this.c.account, group: this.c.group,
      permissions: await this.roles.effective(user.id),
      expiresAt: session.expiresAt.getTime() / 1000,
      passwordChangeRequired: Boolean(user.passwordChangeRequired),
      sessionHash: session.tokenHash, csrfHash: session.csrfHash,
      // UI session secrets are never forwarded to native services.
      token: this.c.nativeToken || ''
    };
  }

  fromRequest(req) { return this.verify(cookieToken(req)); }

  csrfToken(sessionHash) {
    return createHmac('sha256', Buffer.from(this.c.offerKey, 'hex'))
      .update('ocm-ui-csrf-v1:' + sessionHash).digest('base64url');
  }

  require(ctx, permission) {
    if (permission && !ctx.permissions.includes(permission)) fail(403, 'PERMISSION_DENIED');
  }

  csrf(req, ctx) {
    this.sameOrigin(req);
    const value = req.headers['x-csrf-token'];
    if (typeof value !== 'string' || value.length !== 43 ||
        !timingSafeEqual(Buffer.from(digest(value)), Buffer.from(ctx.csrfHash))) {
      fail(403, 'CSRF_INVALID');
    }
  }

  async logout(req, res, ctx) {
    this.csrf(req, ctx);
    await this.db.collection('ui_sessions').deleteOne({ tokenHash: ctx.sessionHash });
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/orce/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
    await this.audit('logout', 'succeeded', ctx.subject);
    return { state: 'succeeded' };
  }

  async changePassword(ctx, body) {
    object(body, ['currentPassword', 'newPassword']);
    string(body.currentPassword, 1, 1024);
    password(body.newPassword);
    const user = await this.db.collection('ui_users').findOne({ id: ctx.subject });
    if (!user || !await bcrypt.compare(body.currentPassword, user.passwordHash)) fail(401, 'PASSWORD_INCORRECT');
    const passwordHash = await bcrypt.hash(body.newPassword, 12);
    await this.audit('password.change', 'started', ctx.subject);
    const changed = await this.db.collection('ui_users').updateOne(
      { id: user.id, authVersion: user.authVersion, passwordHash: user.passwordHash },
      { $set: { passwordHash, passwordChangeRequired: false, updatedAt: new Date(this.now()) }, $inc: { authVersion: 1 } }
    );
    if (changed.modifiedCount !== 1) fail(409, 'USER_CHANGED');
    await this.db.collection('ui_sessions').deleteMany({ subject: ctx.subject });
    await this.audit('password.change', 'succeeded', ctx.subject);
    return { state: 'succeeded', loginRequired: true };
  }

  async audit(action, outcome, subject) {
    const timestamp = new Date(this.now());
    await this.db.collection('ui_audit_log').insertOne({
      action, outcome, subject, tenant: this.c.tenant, timestamp,
      expiresAt: new Date(timestamp.getTime() + 90 * 86400000), schemaVersion: 3
    });
  }
}

module.exports = { LocalAuth, SESSION_SECONDS, COOKIE_NAME, cookieToken, password, digest };
