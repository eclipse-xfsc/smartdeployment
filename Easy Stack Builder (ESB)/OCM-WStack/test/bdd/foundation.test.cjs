'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { memoryDb } = require('../helpers/memory-db.cjs');
const { LocalAuth, digest } = require('../../runtime/lib/local-auth.cjs');
const { lifecycleStatus, summarize } = require('../../runtime/lib/credentials.cjs');
const { Coordination } = require('../../runtime/lib/coordination.cjs');
const now = Date.parse('2026-10-23T12:00:00Z');
const steps = {
  async 'Given a persisted UI session whose absolute deadline is now'(s) {
    s.db = memoryDb(); s.token = 'a'.repeat(43);
    await s.db.collection('ui_sessions').insertOne({ tokenHash: digest(s.token), expiresAt: new Date(now) });
    s.auth = new LocalAuth({}, s.db, {}, () => now);
  },
  async 'When the application validates the session before TTL cleanup'(s) {
    try { await s.auth.verify(s.token); } catch (error) { s.error = error; }
  },
  'Then authentication is rejected and the stored row still exists'(s) {
    assert.equal(s.error.code, 'AUTHENTICATION_REQUIRED'); assert.equal(s.db.tables.get('ui_sessions').length, 1);
  },
  'Given a credential that expired in 2000'(s) {
    s.credential = summarize('one', { expirationDate: '2000-01-01T00:00:00Z' });
  },
  'When the native status service reports active'(s) { s.result = lifecycleStatus(s.credential, { state: 'active' }, now); },
  'Then the displayed lifecycle is expired'(s) { assert.equal(s.result.state, 'expired'); },
  async 'Given a native mutation whose response timed out'(s) {
    s.coordination = new Coordination(memoryDb()); await s.coordination.init(); s.dispatches = 0;
    s.scope = { tenant: 'tenant', account: 'org', group: 'org', subject: 'user' };
    await assert.rejects(s.coordination.run(s.scope, 'nativeMutation', 'unique-key-123456', {}, async () => {
      s.dispatches++; throw Object.assign(Error('timeout'), { status: 504, code: 'UPSTREAM_TIMEOUT' });
    }));
  },
  async 'When the same operation key is submitted again'(s) {
    s.result = await s.coordination.run(s.scope, 'nativeMutation', 'unique-key-123456', {}, () => { s.dispatches++; });
  },
  'Then the result is unknown without a second native dispatch'(s) { assert.equal(s.result.state, 'unknown'); assert.equal(s.dispatches, 1); }
};
const feature = fs.readFileSync(path.join(__dirname, '../features/code-foundation.feature'), 'utf8');
let scenario;
const scenarios = [];
for (const line of feature.split('\n').map(line => line.trim())) {
  if (line.startsWith('Scenario: ')) { scenario = { name: line.slice(10), steps: [] }; scenarios.push(scenario); }
  else if (/^(Given|When|Then|And) /.test(line)) {
    if (!scenario) throw Error('Step outside scenario');
    scenario.steps.push(line);
  }
}
if (scenarios.length !== 3) throw Error('Unexpected or missing executable scenarios');
for (const scenario of scenarios) test(scenario.name, async () => {
  const state = {};
  for (const line of scenario.steps) {
    assert.equal(typeof steps[line], 'function', 'Undefined BDD step: ' + line);
    await steps[line](state);
  }
});
