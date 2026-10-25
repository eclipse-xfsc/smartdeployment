'use strict';

const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { atomic, composites } = require('./permissions.cjs');
const { password } = require('./local-auth.cjs');
const { fail, object, string } = require('./errors.cjs');

class LocalRoles {
  constructor(config, db) { this.c = config; this.db = db; }

  async init() {
    const scope = this.db.collection('ui_meta');
    try {
      await scope.insertOne({ _id: 'tenant', tenant: this.c.tenant });
    } catch (error) {
      if (error.code !== 11000) throw error;
      const stored = await scope.findOne({ _id: 'tenant' });
      if (stored?.tenant !== this.c.tenant) fail(503, 'UI_DATABASE_SCOPE_MISMATCH');
    }
    await this.db.collection('ui_users').createIndex({ username: 1 }, { unique: true });
    await this.db.collection('ui_users').createIndex({ id: 1 }, { unique: true });
    await this.db.collection('ui_roles').createIndex({ name: 1 }, { unique: true });
    await this.db.collection('ui_roles').createIndex({ id: 1 }, { unique: true });
    for (const [name, permissions] of Object.entries(composites)) {
      await this.db.collection('ui_roles').updateOne({ id: name }, {
        $setOnInsert: { id: name, name, permissions, description: '', system: true }
      }, { upsert: true });
    }
    // Bootstrap once. An upgrade never recreates users or resets passwords.
    if (!await this.db.collection('ui_users').findOne({})) {
      if (!this.c.uiAdminHash || !/^\$2[aby]\$12\$/.test(this.c.uiAdminHash)) fail(503, 'UI_BOOTSTRAP_REQUIRED');
      try {
        await this.db.collection('ui_users').insertOne({
          id: randomUUID(), username: this.c.uiAdminUsername.toLowerCase(),
          email: this.c.uiAdminEmail || '', firstName: '', lastName: '', enabled: true,
          passwordHash: this.c.uiAdminHash, passwordChangeRequired: true,
          authVersion: 1, roleIds: ['administrator'], createdAt: new Date()
        });
      } catch (error) { if (error.code !== 11000) throw error; }
    }
  }

  async lock(fn) {
    const locks = this.db.collection('coordination_locks');
    const _id = 'ui-identity';
    try { await locks.insertOne({ _id, createdAt: new Date() }); }
    catch (error) { if (error.code === 11000) fail(409, 'ROLE_CHANGE_IN_PROGRESS'); throw error; }
    // No expiring lease can release a still-running change. Crash recovery is documented.
    try { return await fn(); } finally { await locks.deleteOne({ _id }); }
  }

  async list() {
    const roles = await this.db.collection('ui_roles').find({}).sort({ name: 1 }).toArray();
    return { atomic, items: [
      ...atomic.map(name => ({ id: name, name, permissions: [name], kind: 'atomic', editable: false })),
      ...roles.map(role => ({ id: role.id, name: role.name, description: role.description,
        permissions: role.permissions, kind: 'composite', editable: !role.system }))
    ] };
  }

  async effective(uid) {
    const user = await this.db.collection('ui_users').findOne({ id: uid });
    if (!user?.enabled) return [];
    const roles = await this.db.collection('ui_roles').find({}).toArray();
    return atomic.filter(permission => roles.some(role => user.roleIds.includes(role.id) && role.permissions.includes(permission)));
  }

  async users(search = '') {
    string(search, 0, 128);
    const rows = await this.db.collection('ui_users').find({}).sort({ username: 1 }).limit(5001).toArray();
    if (rows.length > 5000) fail(503, 'UI_USER_RESULT_LIMIT');
    const roles = (await this.list()).items;
    return { items: rows.filter(row => row.username.includes(search.toLowerCase())).map(row => ({
      id: row.id, username: row.username, email: row.email, firstName: row.firstName,
      lastName: row.lastName, enabled: row.enabled,
      roles: roles.filter(role => row.roleIds.includes(role.id)).map(({ id, name }) => ({ id, name }))
    })) };
  }

  async protect({ uid, assigned, roleId, replacement } = {}) {
    const users = await this.db.collection('ui_users').find({ enabled: true }).limit(5001).toArray();
    if (users.length > 5000) fail(503, 'UI_USER_RESULT_LIMIT');
    const roles = await this.db.collection('ui_roles').find({}).toArray();
    const managerExists = users.some(user => {
      const ids = user.id === uid ? assigned : user.roleIds;
      return ids.some(id => {
        const role = roles.find(item => item.id === id);
        const permissions = id === roleId ? replacement : role?.permissions;
        return permissions?.includes('admin.users');
      });
    });
    if (!managerExists) fail(409, 'LAST_ROLE_MANAGER');
  }

  async invalidate(subject) {
    await this.db.collection('ui_users').updateOne({ id: subject }, { $inc: { authVersion: 1 } });
    await this.db.collection('ui_sessions').deleteMany({ subject });
  }

  async assign(uid, body) {
    object(body, ['roleIds']);
    if (!Array.isArray(body.roleIds) || body.roleIds.length > 50 ||
        new Set(body.roleIds).size !== body.roleIds.length) fail(400, 'VALIDATION_ERROR');
    return this.lock(async () => {
      const user = await this.db.collection('ui_users').findOne({ id: uid });
      if (!user) fail(404, 'RESOURCE_NOT_FOUND');
      const roles = await this.db.collection('ui_roles').find({}).toArray();
      if (body.roleIds.some(id => !roles.some(role => role.id === id))) fail(400, 'VALIDATION_ERROR');
      await this.protect({ uid, assigned: body.roleIds });
      await this.db.collection('ui_users').updateOne({ id: uid }, {
        $set: { roleIds: body.roleIds, updatedAt: new Date() }, $inc: { authVersion: 1 }
      });
      await this.db.collection('ui_sessions').deleteMany({ subject: uid });
      return { state: 'succeeded', resourceId: uid, loginRequired: true };
    });
  }

  async user(uid, body, remove = false) {
    if (!remove) {
      object(body, ['username', 'email', 'firstName', 'lastName', 'enabled', 'temporaryPassword']);
      string(body.username, 1, 128);
      if (!/^[A-Za-z0-9_.@-]+$/.test(body.username) || typeof body.enabled !== 'boolean') fail(400, 'VALIDATION_ERROR');
      for (const key of ['email', 'firstName', 'lastName']) if (body[key] !== undefined) string(body[key], 0, 256);
      if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) fail(400, 'VALIDATION_ERROR');
      if (!uid || body.temporaryPassword !== undefined) password(body.temporaryPassword);
    }
    return this.lock(async () => {
      const old = uid ? await this.db.collection('ui_users').findOne({ id: uid }) : null;
      if (uid && !old) fail(404, 'RESOURCE_NOT_FOUND');
      if (uid && (remove || !body.enabled)) await this.protect({ uid, assigned: [] });
      if (remove) {
        await this.db.collection('ui_users').deleteOne({ id: uid });
        await this.db.collection('ui_sessions').deleteMany({ subject: uid });
      } else {
        const username = body.username.toLowerCase();
        if (old && old.username !== username) fail(400, 'USER_NAME_IMMUTABLE');
        const value = { username, email: body.email || '', firstName: body.firstName || '',
          lastName: body.lastName || '', enabled: body.enabled, updatedAt: new Date() };
        if (body.temporaryPassword !== undefined) {
          value.passwordHash = await bcrypt.hash(body.temporaryPassword, 12);
          value.passwordChangeRequired = true;
        }
        try {
          if (old) {
            await this.db.collection('ui_users').updateOne({ id: uid }, { $set: value, $inc: { authVersion: 1 } });
            await this.db.collection('ui_sessions').deleteMany({ subject: uid });
          } else {
            uid = randomUUID();
            await this.db.collection('ui_users').insertOne({ ...value, id: uid, roleIds: [], authVersion: 1, createdAt: new Date() });
          }
        } catch (error) { if (error.code === 11000) fail(409, 'USER_EXISTS'); throw error; }
      }
      return { state: 'succeeded', resourceId: uid, refreshRequired: true };
    });
  }

  async change(roleId, body, remove = false) {
    if (!remove) {
      object(body, ['name', 'description', 'permissions']);
      string(body.name, 1, 64);
      if (!/^[a-z][a-z0-9-]*$/.test(body.name) || atomic.includes(body.name) ||
          !Array.isArray(body.permissions) || body.permissions.some(value => !atomic.includes(value)) ||
          new Set(body.permissions).size !== body.permissions.length) fail(400, 'VALIDATION_ERROR');
      if (body.description !== undefined) string(body.description, 0, 512);
    }
    return this.lock(async () => {
      const old = roleId ? await this.db.collection('ui_roles').findOne({ id: roleId }) : null;
      if (roleId && !old) fail(404, 'RESOURCE_NOT_FOUND');
      if (old?.system) fail(403, 'SYSTEM_ROLE_PROTECTED');
      if (old) await this.protect({ roleId, replacement: remove ? [] : body.permissions });
      try {
        if (remove) await this.db.collection('ui_roles').deleteOne({ id: roleId });
        else if (old) await this.db.collection('ui_roles').updateOne({ id: roleId }, {
          $set: { name: body.name, description: body.description || '', permissions: body.permissions }
        });
        else {
          roleId = randomUUID();
          await this.db.collection('ui_roles').insertOne({ id: roleId, name: body.name,
            description: body.description || '', permissions: body.permissions, system: false });
        }
      } catch (error) { if (error.code === 11000) fail(409, 'ROLE_EXISTS'); throw error; }
      // Increment every affected user's version; delayed TTL cleanup cannot preserve access.
      const users = await this.db.collection('ui_users').find({}).toArray();
      for (const user of users) if (user.roleIds.includes(roleId)) await this.invalidate(user.id);
      return { state: 'succeeded', resourceId: roleId, refreshRequired: true };
    });
  }
}

module.exports = { LocalRoles };
