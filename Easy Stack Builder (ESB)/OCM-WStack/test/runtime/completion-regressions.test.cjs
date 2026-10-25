'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lifecycleStatus, summarize } = require('../../runtime/lib/credentials.cjs');
const { Adapters } = require('../../runtime/lib/adapters.cjs');
const { graph, joinConnections } = require('../../runtime/lib/provenance.cjs');
const { Coordination } = require('../../runtime/lib/coordination.cjs');
const { Runtime } = require('../../runtime/lib/runtime.cjs');
const { memoryDb } = require('../helpers/memory-db.cjs');
const now = Date.parse('2026-10-23T12:00:00Z');
const active = { state: 'active', source: 'XFSC Status' };
const vc = { type: ['VerifiableCredential', 'ParticipantCredential'], issuer: 'did:web:issuer.example',
  credentialSubject: { id: 'did:web:holder.example' } };
const scope = { tenant: 'tenant', account: 'org', group: 'org', subject: 'operator' };

for (const [name, expiry, expected] of [
  ['past', '2000-01-01T00:00:00Z', 'expired'],
  ['exact boundary', '2026-10-23T12:00:00Z', 'expired'],
  ['future', '2026-10-23T12:00:01Z', 'active'],
  ['malformed', 'not-a-date', 'not_checked']
]) test('declared expiration ' + name + ' cannot be hidden by a native active status', () => {
  assert.equal(lifecycleStatus(summarize('one', { ...vc, expirationDate: expiry }), active, now).state, expected);
});

test('future validity and revoked/suspended precedence remain distinct from cryptographic verification', () => {
  const summary = summarize('one', { ...vc, validFrom: '2027-01-01T00:00:00Z' });
  assert.equal(lifecycleStatus(summary, active, now).state, 'not_yet_valid');
  assert.equal(lifecycleStatus(summary, { state: 'revoked' }, now).state, 'revoked');
  assert.equal(lifecycleStatus(summary, { state: 'suspended' }, now).state, 'suspended');
});

test('expired credential regression: list counts expired 1 and active 0 with native false/false flags', async () => {
  const config = { publicOrigin: 'https://ocm.example', issuerDids: ['did:web:ocm.example'] };
  const raw = { ...vc, issuer: config.issuerDids[0], expirationDate: '2000-01-01T00:00:00Z',
    credentialStatus: { type: 'StatusList2021Entry', statusPurpose: 'revocation',
      statusListCredential: 'https://ocm.example/api/status/1', statusListIndex: '0' } };
  const adapter = new Adapters(config, { call: async () => ({ credentials: { expired: raw } }) });
  adapter.statusTransport = { checkStatus: async () => ({ revocated: false, suspended: false }) };
  const result = await adapter.list(scope, { status: 'expired' });
  assert.equal(result.counts.active, 0); assert.equal(result.counts.expired, 1);
  assert.equal(result.items[0].status.state, 'expired');
});

test('JWT NumericDate zero is preserved and invalid extreme NumericDates fail visibly', () => {
  const token = claims => 'e30.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
  assert.equal(summarize('zero', token({ exp: 0 })).expiresAt, '1970-01-01T00:00:00.000Z');
  assert.equal(lifecycleStatus(summarize('large', token({ exp: 1e100 })), active, now).reason, 'INVALID_VALIDITY_PERIOD');
});

test('shared issuer/holder identities alone do not manufacture supporting credentials', () => {
  const result = graph({ one: vc, unrelated: { ...vc, issuer: vc.credentialSubject.id } }, 'one');
  assert.equal(result.nodes.filter(node => node.kind === 'credential').length, 1);
  assert.equal(result.edges.some(edge => edge.role === 'supports'), false);
});

test('explicit multi-hop references, cycles and missing records have honest graph evidence', () => {
  const result = graph({ one: { ...vc, evidence: [{ id: 'two' }] },
    two: { ...vc, evidence: [{ id: 'three' }, { id: 'missing' }] },
    three: { ...vc, evidence: [{ id: 'one' }] } }, 'one');
  assert.equal(result.nodes.filter(node => node.kind === 'credential').length, 3);
  assert.deepEqual(result.cycles, ['one']); assert.deepEqual(result.unresolvedReferences, ['missing']);
  assert.ok(result.edges.every(edge => edge.verified === false));
  assert.equal(result.truncated, false);
});

test('graph limits report truncation and never emit an edge to a missing node', () => {
  const result = graph({ one: { ...vc, evidence: [{ id: 'two' }] },
    two: { ...vc, evidence: [{ id: 'three' }] }, three: vc }, 'one', { maxDepth: 1 });
  assert.equal(result.truncated, true);
  const ids = new Set(result.nodes.map(node => node.id));
  assert.ok(result.edges.every(edge => ids.has(edge.from) && ids.has(edge.to)));
});

test('ambiguous declared IDs remain unresolved instead of choosing the last record', () => {
  const result = graph({ one: { ...vc, evidence: [{ id: 'urn:duplicate' }] },
    two: { ...vc, id: 'urn:duplicate' }, three: { ...vc, id: 'urn:duplicate' } }, 'one');
  assert.deepEqual(result.unresolvedReferences, ['urn:duplicate']);
});

test('provenance joins native connections read-only and marks DID documents unresolved', () => {
  const result = joinConnections(graph({ one: vc }, 'one'), [{ did: vc.issuer, label: 'Issuer', status: 'blocked' }]);
  const issuer = result.nodes.find(node => node.did === vc.issuer);
  assert.equal(issuer.connection.status, 'blocked');
  assert.equal(issuer.connection.source, 'native-didcomm-read');
  assert.equal(issuer.resolution, 'not-resolved');
});

test('operation records persist metadata only; replay never recovers an offer or redispatches', async () => {
  const db = memoryDb(); const coordination = new Coordination(db, 'aa'.repeat(32));
  await coordination.init();
  const first = await coordination.run(scope, 'issue', 'operation-key-123456', { secretClaim: 'private-claim' }, async () => ({
    state: 'succeeded', offer: { credential_offer: 'private-offer-code' }, invitation: 'private-invitation'
  }));
  assert.ok(first.offer);
  const serialized = JSON.stringify([...db.tables]);
  for (const value of ['private-claim', 'private-offer-code', 'private-invitation', 'encryptedOffer', 'encryptedResult']) assert.ok(!serialized.includes(value), value);
  const replay = await coordination.run(scope, 'issue', 'operation-key-123456', { secretClaim: 'private-claim' }, () => assert.fail('duplicate dispatch'));
  assert.equal(replay.offer, undefined); assert.equal(replay.responseAvailable, false);
  assert.equal(replay.replayed, true);
});

test('unknown native refresh contract blocks without replacing it with another issuance operation', async () => {
  const app = { adapters: { raw: () => assert.fail('must not invent native refresh') },
    registry: { issue: () => assert.fail('must not substitute issuance') } };
  await assert.rejects(Runtime.prototype.execute.call(app, 'refresh', scope, 'one', {}, {}, 'request'), { code: 'NATIVE_REFRESH_CONTRACT_UNVERIFIED' });
});
