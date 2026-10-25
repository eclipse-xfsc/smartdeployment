'use strict';

const { createHash } = require('node:crypto');
const { atomic, composites } = require('../lib/permissions.cjs');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const permissionAliases = { 'roles.manage': 'admin.users', 'relationships.manage': 'relationships.write' };
const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Prepare a UI-only identity migration. Never import a Keycloak credential hash. */
function prepareMigration(exported, passwordHashes, tenant) {
  if (exported.realm !== 'ocm-ui-' + tenant || !Array.isArray(exported.users)) {
    fail('MIGRATION_SCOPE', 'Export the dedicated UI realm for the configured tenant.');
  }
  const definitions = exported.roles?.client?.['ocm-ui'] || [];
  const roleMap = new Map(definitions.map(role => [role.name, role]));
  function permissions(name, path = new Set()) {
    const canonical = permissionAliases[name] || name;
    if (atomic.includes(canonical)) return [canonical];
    if (composites[name]) return composites[name];
    if (path.has(name)) fail('MIGRATION_ROLE_CYCLE', 'A custom role contains a composite cycle.');
    const definition = roleMap.get(name);
    if (!definition || !Array.isArray(definition.composites?.client?.['ocm-ui'])) {
      fail('MIGRATION_ROLE_UNMAPPED', 'Every assigned custom UI role needs an explicit client permission mapping.');
    }
    if (definition.composites.realm?.length || Object.keys(definition.composites.client).some(key => key !== 'ocm-ui')) {
      fail('MIGRATION_ROLE_UNMAPPED', 'Cross-client or realm role inheritance needs manual mapping.');
    }
    const next = new Set(path); next.add(name);
    return [...new Set(definition.composites.client['ocm-ui'].flatMap(child => permissions(child, next)))];
  }
  const users = [];
  const roles = Object.entries(composites).map(([name, permissions]) => ({
    id: name, name, permissions, description: '', system: true
  }));
  const usernames = new Set();
  const ids = new Set();
  for (const user of exported.users) {
    if (user.serviceAccountClientId) continue;
    if (typeof user.id !== 'string' || !user.id || typeof user.username !== 'string' ||
        !/^[A-Za-z0-9_.@-]{1,128}$/.test(user.username) || typeof user.enabled !== 'boolean') {
      fail('MIGRATION_IDENTITY_INVALID', 'Every human user requires a stable ID, valid username and enabled flag.');
    }
    const username = user.username.toLowerCase();
    if (usernames.has(username) || ids.has(user.id)) fail('MIGRATION_IDENTITY_COLLISION', 'Usernames and actor IDs must be unique after normalization.');
    usernames.add(username); ids.add(user.id);
    const passwordHash = passwordHashes[user.id];
    if (typeof passwordHash !== 'string' || !/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
      fail('MIGRATION_PASSWORD_RESET_REQUIRED', 'Provide a new cost-12 bcrypt reset hash for every human user.');
    }
    const assigned = user.clientRoles?.['ocm-ui'] || [];
    if (!Array.isArray(assigned) || assigned.some(value => typeof value !== 'string')) fail('MIGRATION_ROLE_UNMAPPED', 'Invalid UI role assignment.');
    const inherited = [...new Set(assigned.flatMap(name => permissions(name)))];
    const roleId = 'migrated-' + sha256(user.id).slice(0, 24);
    roles.push({ id: roleId, name: roleId, description: 'Reviewed legacy UI access', permissions: inherited, system: false });
    users.push({ id: user.id, legacySubject: user.id, username, email: user.email || '',
      firstName: user.firstName || '', lastName: user.lastName || '', enabled: user.enabled,
      passwordHash, passwordChangeRequired: true, authVersion: 1, roleIds: [roleId] });
  }
  if (!users.some(user => user.enabled && roles.find(role => role.id === user.roleIds[0]).permissions.includes('admin.users'))) {
    fail('MIGRATION_LAST_ADMIN', 'The migration must retain an enabled UI administrator.');
  }
  const plan = { schemaVersion: 3, tenant, sourceSha256: sha256(JSON.stringify(exported)),
    users, roles, summary: { humanUsers: users.length, serviceAccountsExcluded: exported.users.length - users.length,
      passwordResetRequired: users.length, stableActorIdsPreserved: true } };
  return { ...plan, planSha256: sha256(JSON.stringify(plan)) };
}

/** Apply only to an empty dedicated UI identity store. A stopped application is required. */
async function applyMigration(db, plan) {
  if (plan.schemaVersion !== 3 || !Array.isArray(plan.users) || !Array.isArray(plan.roles)) fail('MIGRATION_PLAN_INVALID', 'Unsupported migration plan.');
  const { planSha256, ...content } = plan;
  if (!planSha256 || planSha256 !== sha256(JSON.stringify(content))) fail('MIGRATION_PLAN_CHANGED', 'Regenerate and review the changed migration plan.');
  const storedScope = await db.collection('ui_meta').findOne({ _id: 'tenant' });
  if (storedScope && storedScope.tenant !== plan.tenant) fail('MIGRATION_SCOPE', 'The target UI database belongs to another tenant.');
  const locks = db.collection('coordination_locks');
  const _id = 'ui-identity';
  try { await locks.insertOne({ _id, purpose: 'migration', createdAt: new Date() }); }
  catch (error) { if (error.code === 11000) fail('MIGRATION_LOCKED', 'Inspect the existing UI identity lock before retrying.'); throw error; }
  try {
    const marker = await db.collection('ui_migrations').findOne({ _id: 'identity-v3' });
    if (marker && (marker.sourceSha256 !== plan.sourceSha256 || marker.planSha256 !== plan.planSha256)) fail('MIGRATION_SOURCE_CHANGED', 'A different export has already started migration.');
    if (marker?.state === 'complete') return { state: 'already-complete', ...plan.summary };
    if (!marker && (await db.collection('ui_users').findOne({}) || await db.collection('ui_roles').findOne({}))) {
      fail('MIGRATION_TARGET_NOT_EMPTY', 'Use the documented migration target; existing identities will not be overwritten.');
    }
    await db.collection('ui_migrations').updateOne({ _id: 'identity-v3' }, {
      $setOnInsert: { sourceSha256: plan.sourceSha256, planSha256: plan.planSha256, tenant: plan.tenant, state: 'started', startedAt: new Date() }
    }, { upsert: true });
    await db.collection('ui_meta').updateOne({ _id: 'tenant' }, { $setOnInsert: { tenant: plan.tenant } }, { upsert: true });
    for (const [collection, records] of [['ui_roles', plan.roles], ['ui_users', plan.users]]) {
      await db.collection(collection).createIndex({ id: 1 }, { unique: true });
      for (const record of records) {
        const old = await db.collection(collection).findOne({ id: record.id });
        if (old) {
          if (JSON.stringify(old) !== JSON.stringify({ ...record, _id: old._id })) {
            // Real Mongo injects _id. Compare its removal without trusting arbitrary fields.
            const { _id: ignored, ...value } = old;
            if (JSON.stringify(value) !== JSON.stringify(record)) fail('MIGRATION_TARGET_CHANGED', 'A partially migrated identity differs from the reviewed plan.');
          }
        } else await db.collection(collection).insertOne(record);
      }
    }
    await db.collection('ui_migrations').updateOne({ _id: 'identity-v3' }, { $set: { state: 'complete', completedAt: new Date() } });
    return { state: 'complete', ...plan.summary };
  } finally { await locks.deleteOne({ _id }); }
}

module.exports = { prepareMigration, applyMigration, permissionAliases };
