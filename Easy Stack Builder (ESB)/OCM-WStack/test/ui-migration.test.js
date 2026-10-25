'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareMigration, applyMigration } = require('../lib/ui-migration');
const { memoryDb } = require('./helpers/memory-db.cjs');
const exported = { realm: 'ocm-ui-tenant', users: [
  { id: 'stable-actor-1', username: 'Alice', enabled: true, clientRoles: { 'ocm-ui': ['administrator'] } },
  { id: 'service', username: 'service-account', serviceAccountClientId: 'backend', enabled: true }
] };
const hashes = { 'stable-actor-1': '$2b$12$' + 'a'.repeat(53) };
test('migration preserves actor IDs, excludes service accounts and forces password reset without reusing exported hashes', () => {
  const plan = prepareMigration(exported, hashes, 'tenant');
  assert.equal(plan.users.length, 1); assert.equal(plan.users[0].id, 'stable-actor-1');
  assert.equal(plan.users[0].username, 'alice'); assert.equal(plan.users[0].passwordChangeRequired, true);
  assert.equal(plan.summary.serviceAccountsExcluded, 1);
});
test('migration rejects foreign realms, missing reset hashes, collisions and missing administrators', () => {
  assert.throws(() => prepareMigration(exported, hashes, 'foreign'), { code: 'MIGRATION_SCOPE' });
  assert.throws(() => prepareMigration(exported, {}, 'tenant'), { code: 'MIGRATION_PASSWORD_RESET_REQUIRED' });
  const duplicate = { ...exported, users: [exported.users[0], { ...exported.users[0], id: 'second' }] };
  assert.throws(() => prepareMigration(duplicate, { ...hashes, second: hashes['stable-actor-1'] }, 'tenant'), { code: 'MIGRATION_IDENTITY_COLLISION' });
  const viewer = { ...exported, users: [{ ...exported.users[0], clientRoles: { 'ocm-ui': ['viewer'] } }] };
  assert.throws(() => prepareMigration(viewer, hashes, 'tenant'), { code: 'MIGRATION_LAST_ADMIN' });
});
test('migration applies only UI records and is repeatable for the same export', async () => {
  const db = memoryDb(); const plan = prepareMigration(exported, hashes, 'tenant');
  assert.equal((await applyMigration(db, plan)).state, 'complete');
  assert.equal((await applyMigration(db, plan)).state, 'already-complete');
  assert.equal(db.tables.get('ui_users').length, 1);
  assert.ok([...db.tables.keys()].every(name => ['ui_meta', 'coordination_locks', 'ui_migrations', 'ui_users', 'ui_roles'].includes(name)));
  await assert.rejects(applyMigration(db, { ...plan, sourceSha256: 'changed' }), { code: 'MIGRATION_PLAN_CHANGED' });
});
test('migration never overwrites an existing UI identity store', async () => {
  const db = memoryDb(); await db.collection('ui_users').insertOne({ id: 'existing' });
  await assert.rejects(applyMigration(db, prepareMigration(exported, hashes, 'tenant')), { code: 'MIGRATION_TARGET_NOT_EMPTY' });
  assert.equal(db.tables.get('ui_users')[0].id, 'existing');
});
