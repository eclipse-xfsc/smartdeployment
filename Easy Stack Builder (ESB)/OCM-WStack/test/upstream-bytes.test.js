'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const lock = require('../upstream-lock.json');

test('all source contract fixtures match independently retrieved pinned Git blob identities', () => {
  assert.deepEqual(Object.keys(lock.gitBlobs).sort(), Object.keys(lock.sha256).sort());
  for (const [name, expected] of Object.entries(lock.gitBlobs)) {
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/upstream', name));
    const blob = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(blob, expected, `Git source bytes differ: ${name}`);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), lock.sha256[name], name);
  }
});
