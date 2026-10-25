'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { LocalAuth, COOKIE_NAME, SESSION_SECONDS, digest, password } = require('../../runtime/lib/local-auth.cjs');
const { LocalRoles } = require('../../runtime/lib/local-roles.cjs');
const { Runtime, routes } = require('../../runtime/lib/runtime.cjs');
const { memoryDb } = require('../helpers/memory-db.cjs');
const config = { publicOrigin: 'https://wallet.example', tenant: 'tenant', account: 'org', group: 'org',
  uiAdminUsername: 'admin', uiAdminEmail: '', offerKey: 'ab'.repeat(32), nativeToken: 'separate-native-jwt' };
let bootstrapHash;
const initialPassword = 'initial-password-123';
async function fixture() {
  bootstrapHash ||= await bcrypt.hash(initialPassword, 12);
  const db = memoryDb();
  const roles = new LocalRoles({ ...config, uiAdminHash: bootstrapHash }, db);
  await roles.init();
  let now = Date.parse('2026-10-23T12:00:00Z');
  const auth = new LocalAuth(config, db, roles, () => now);
  // No duplicate bcrypt work for the unit test unknown-user timing hash.
  auth.dummyHash = bootstrapHash;
  return { db, auth, roles, advance(milliseconds) { now += milliseconds; } };
}
async function login(f) {
  const headers = {};
  const result = await f.auth.login({ headers: { origin: config.publicOrigin }, socket: { remoteAddress: '127.0.0.1' } },
    { setHeader(key, value) { headers[key] = value; } }, { username: 'admin', password: initialPassword });
  const cookie = headers['Set-Cookie'].split(';')[0];
  return { result, cookie, token: cookie.slice(COOKIE_NAME.length + 1), headers };
}

test('login issues an opaque secure cookie, stores digests, fixes scope and keeps native JWT separate', async () => {
  const f = await fixture();
  const session = await login(f);
  assert.match(session.headers['Set-Cookie'], /Secure; HttpOnly; SameSite=Strict; Max-Age=86400/);
  assert.equal(session.token.length, 43);
  const row = f.db.tables.get('ui_sessions')[0];
  assert.equal(row.expiresAt - row.createdAt, SESSION_SECONDS * 1000);
  assert.equal(row.tokenHash, digest(session.token));
  assert.ok(!JSON.stringify(row).includes(session.token));
  assert.ok(!JSON.stringify(row).includes(session.result.csrfToken));
  const context = await f.auth.fromRequest({ headers: { cookie: session.cookie, authorization: 'Bearer attacker-token' } });
  assert.equal(context.tenant, 'tenant');
  assert.equal(context.token, config.nativeToken);
  assert.notEqual(context.token, session.token);
  assert.equal(context.passwordChangeRequired, true);
  assert.ok(context.permissions.includes('admin.users'));
  assert.equal(f.auth.csrfToken(context.sessionHash), session.result.csrfToken);
});

test('absolute 24-hour boundary rejects a session even when Mongo TTL has not deleted it', async () => {
  const f = await fixture(); const session = await login(f);
  f.advance(SESSION_SECONDS * 1000 - 1);
  await f.auth.verify(session.token);
  f.advance(1);
  await assert.rejects(f.auth.verify(session.token), { code: 'AUTHENTICATION_REQUIRED' });
  assert.equal(f.db.tables.get('ui_sessions').length, 1);
});

test('CSRF rejects absent/wrong tokens and foreign origins; logout invalidates the session', async () => {
  const f = await fixture(); const session = await login(f); const context = await f.auth.verify(session.token);
  assert.throws(() => f.auth.csrf({ headers: { origin: config.publicOrigin } }, context), { code: 'CSRF_INVALID' });
  assert.throws(() => f.auth.csrf({ headers: { origin: 'https://evil.example', 'x-csrf-token': session.result.csrfToken } }, context), { code: 'ORIGIN_FORBIDDEN' });
  assert.throws(() => f.auth.csrf({ headers: { origin: config.publicOrigin, 'x-csrf-token': 'a'.repeat(43) } }, context), { code: 'CSRF_INVALID' });
  let expiredCookie;
  await f.auth.logout({ headers: { origin: config.publicOrigin, 'x-csrf-token': session.result.csrfToken } },
    { setHeader(key, value) { expiredCookie = value; } }, context);
  assert.match(expiredCookie, /Max-Age=0/);
  await assert.rejects(f.auth.verify(session.token), { code: 'AUTHENTICATION_REQUIRED' });
});

test('disabled users and changed identity versions fail even when old session rows remain', async () => {
  const f = await fixture(); const session = await login(f); const row = f.db.tables.get('ui_users')[0];
  row.enabled = false;
  await assert.rejects(f.auth.verify(session.token), { code: 'AUTHENTICATION_REQUIRED' });
  row.enabled = true; row.authVersion++;
  await assert.rejects(f.auth.verify(session.token), { code: 'AUTHENTICATION_REQUIRED' });
});

test('password change uses bcrypt cost 12, forces re-login, and rejects a stale current password', async () => {
  const f = await fixture(); const first = await login(f); await login(f);
  const context = await f.auth.verify(first.token);
  await assert.rejects(f.auth.changePassword(context, { currentPassword: 'wrong-password', newPassword: 'new-password-1234' }), { code: 'PASSWORD_INCORRECT' });
  await f.auth.changePassword(context, { currentPassword: initialPassword, newPassword: 'new-password-1234' });
  assert.equal(f.db.tables.get('ui_sessions').length, 0);
  const user = f.db.tables.get('ui_users')[0];
  assert.match(user.passwordHash, /^\$2[aby]\$12\$/);
  assert.equal(await bcrypt.compare('new-password-1234', user.passwordHash), true);
  assert.equal(user.passwordChangeRequired, false);
});

test('password policy counts UTF-8 bytes and rejects bcrypt truncation', () => {
  assert.equal(password('a'.repeat(72)).length, 72);
  for (const value of ['a'.repeat(73), '🔐'.repeat(19), 'short']) assert.throws(() => password(value), { code: 'PASSWORD_POLICY' });
});

test('login limiter is shared through Mongo counters and generic credentials errors do not expose usernames', async () => {
  const f = await fixture();
  await f.db.collection('ui_login_limits').insertOne({ _id: 'account:' + digest('missing') + ':' + Math.floor(Date.parse('2026-10-23T12:00:00Z') / 900000), attempts: 10 });
  const request = { headers: { origin: config.publicOrigin }, socket: { remoteAddress: '127.0.0.1' } };
  await assert.rejects(f.auth.login(request, { setHeader() {} }, { username: 'missing', password: 'bad-password' }), { code: 'LOGIN_RATE_LIMITED' });
  await assert.rejects(f.auth.login({ ...request, headers: { origin: 'https://evil.example' } }, {}, { username: 'admin', password: initialPassword }), { code: 'ORIGIN_FORBIDDEN' });
});

test('last administrator protection survives disable, delete and assignment attempts', async () => {
  const f = await fixture(); const user = f.db.tables.get('ui_users')[0];
  await assert.rejects(f.roles.assign(user.id, { roleIds: [] }), { code: 'LAST_ROLE_MANAGER' });
  await assert.rejects(f.roles.user(user.id, { username: 'admin', enabled: false }), { code: 'LAST_ROLE_MANAGER' });
  await assert.rejects(f.roles.user(user.id, {}, true), { code: 'LAST_ROLE_MANAGER' });
  await assert.rejects(f.roles.change('administrator', {}, true), { code: 'SYSTEM_ROLE_PROTECTED' });
});

test('permission changes invalidate sessions and cannot inject unrecognized permissions', async () => {
  const f = await fixture();
  const operator = await f.roles.user(null, { username: 'operator', enabled: true, temporaryPassword: 'operator-password-123' });
  await f.roles.assign(operator.resourceId, { roleIds: ['viewer'] });
  assert.ok((await f.roles.effective(operator.resourceId)).includes('credentials.read'));
  await assert.rejects(f.roles.change(null, { name: 'bad', permissions: ['native.root'] }), { code: 'VALIDATION_ERROR' });
  assert.ok(!JSON.stringify(await f.roles.users()).includes('passwordHash'));
});

test('forced password change blocks business calls and PCM has no active route', async () => {
  const f = await fixture(); const session = await login(f);
  const app = new Runtime(config); app.ready = true; app.auth = f.auth; app.coordination = { audit: async () => {} };
  let status = 200, result;
  const response = { setHeader() {}, status(value) { status = value; return this; }, json(value) { result = value; } };
  await app.handle({ method: 'GET', url: '/credentials', headers: { cookie: session.cookie } }, response);
  assert.equal(status, 403); assert.equal(result.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.ok(routes.every(route => !route.path.startsWith('/pcm')));
  assert.ok(routes.every(route => route.module));
});
