'use strict';

const { summarize, decode } = require('./credentials.cjs');
const { fail } = require('./errors.cjs');

function didUrl(did) {
  if (typeof did !== 'string' || !did.startsWith('did:web:')) return null;
  try {
    const parts = did.slice(8).split(':').map(decodeURIComponent);
    const host = parts.shift();
    const url = new URL('https://' + host + '/' + (parts.length
      ? parts.map(encodeURIComponent).join('/') + '/did.json' : '.well-known/did.json'));
    if (url.username || url.password || url.hash || url.search) return null;
    return url.href;
  } catch { return null; }
}

// Only explicit references connect credentials. Shared issuer/holder identities
// appear as identity nodes, but never imply a supporting credential or a proof.
function references(raw) {
  const claims = decode(raw).claims;
  const found = new Set();
  let examined = 0;
  function visit(value, depth = 0) {
    if (depth > 8 || ++examined > 1000) return;
    if (typeof value === 'string') { found.add(value); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (!value || typeof value !== 'object') return;
    for (const field of ['id', 'credentialId', 'credential', 'verifiableCredential', 'provenanceProof', 'evidence', 'credentialChain']) {
      if (value[field] !== undefined) visit(value[field], depth + 1);
    }
  }
  for (const field of ['evidence', 'provenanceProof', 'credentialChain']) visit(claims[field]);
  return [...found];
}

function graph(records, key, options = {}) {
  if (!Object.hasOwn(records, key)) fail(404, 'RESOURCE_NOT_FOUND');
  const maxDepth = options.maxDepth || 8;
  const maxCredentials = options.maxCredentials || 40;
  const summaries = new Map();
  const aliases = new Map(Object.keys(records).map(id => [id, id]));
  for (const [id, raw] of Object.entries(records)) {
    try {
      summaries.set(id, summarize(id, raw));
      const declaredId = decode(raw).claims.id;
      if (typeof declaredId === 'string' && declaredId !== id) {
        // Ambiguous duplicate credential IDs cannot select an arbitrary record.
        aliases.set(declaredId, aliases.has(declaredId) ? null : id);
      }
    } catch { /* Malformed records are reported as unresolved references. */ }
  }
  if (!summaries.has(key)) fail(422, 'UNSUPPORTED_FORMAT');
  const nodes = new Map();
  const edges = [];
  const selected = new Set();
  const active = new Set();
  const cycles = [];
  const unresolved = new Set();
  let truncated = false;
  const credentialNode = id => 'credential:' + id;

  function visit(id, depth) {
    if (active.has(id)) { cycles.push(id); return; }
    if (selected.has(id)) return;
    if (depth > maxDepth || selected.size >= maxCredentials) { truncated = true; return; }
    const credential = summaries.get(id);
    if (!credential) { unresolved.add(id); return; }
    selected.add(id);
    active.add(id);
    const node = credentialNode(id);
    nodes.set(node, { id: node, kind: 'credential', credentialId: id,
      label: credential.types.join(', ') || id, issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt, url: '/orce/#credential=' + encodeURIComponent(id) });
    for (const [role, identity] of [['issuer', credential.issuer.id], ['holder', credential.subject.id]]) {
      if (!identity) continue;
      const identityNode = 'identity:' + identity;
      nodes.set(identityNode, { id: identityNode, kind: 'identity', label: identity,
        did: identity, url: didUrl(identity), resolution: 'not-resolved' });
      edges.push({ from: role === 'issuer' ? identityNode : node,
        to: role === 'issuer' ? node : identityNode, role,
        evidence: 'credential-declaration', verified: false });
    }
    if (!credential.subject.id && credential.holder?.kind === 'key-binding') {
      const holderNode = 'holder-key:' + id;
      nodes.set(holderNode, { id: holderNode, kind: 'identity', label: credential.holder.label, url: null });
      edges.push({ from: node, to: holderNode, role: 'holder',
        evidence: 'credential-key-binding-declaration', verified: false });
    }
    for (const reference of references(records[id])) {
      const target = aliases.get(reference);
      if (!target || !summaries.has(target)) { unresolved.add(reference); continue; }
      if (depth >= maxDepth || (!selected.has(target) && selected.size >= maxCredentials)) {
        truncated = true; unresolved.add(reference); continue;
      }
      visit(target, depth + 1);
      edges.push({ from: node, to: credentialNode(target), role: 'supports',
        evidence: 'explicit-credential-reference', reference, verified: false });
    }
    active.delete(id);
  }
  visit(key, 0);
  return { root: credentialNode(key), nodes: [...nodes.values()], edges,
    source: 'explicit-credential-declarations', verified: false, truncated,
    limits: { maxDepth, maxCredentials }, cycles: [...new Set(cycles)],
    unresolvedReferences: [...unresolved], declaredEvidence: decode(records[key]).claims.evidence || null };
}

function joinConnections(graph, relationships) {
  const byDid = new Map(relationships.map(item => [item.did, item]));
  for (const node of graph.nodes) {
    if (node.kind !== 'identity' || !node.did) continue;
    const connection = byDid.get(node.did);
    if (connection) node.connection = {
      did: connection.did, label: connection.label, status: connection.status || 'unknown',
      url: '/orce/#relationship=' + encodeURIComponent(connection.did),
      source: 'native-didcomm-read'
    };
  }
  return graph;
}

module.exports = { graph, didUrl, references, joinConnections };
