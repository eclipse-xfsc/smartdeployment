'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { workspace, bash, bashAsync } = require('./helpers.cjs');

async function server(t, handler) {
  const sockets = new Set();
  const peer = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); handler(socket);
  });
  await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); peer.close(); });
  return peer.address().port;
}

function command(buffer) {
  const header = buffer.indexOf('\r\n');
  if (header < 0) return;
  assert.equal(buffer[0], 42);
  const size = Number(buffer.subarray(1, header));
  let position = header + 2;
  const result = [];
  for (let i = 0; i < size; i++) {
    const end = buffer.indexOf('\r\n', position);
    if (end < 0) return;
    assert.equal(buffer[position], 36);
    const length = Number(buffer.subarray(position + 1, end));
    position = end + 2;
    if (buffer.length < position + length + 2) return;
    result.push(buffer.subarray(position, position + length).toString());
    assert.equal(buffer.subarray(position + length, position + length + 2).toString(), '\r\n');
    position += length + 2;
  }
  return { result, position };
}
const encode = value => value === null ? '$-1\r\n' : Array.isArray(value)
  ? `*${value.length}\r\n${value.map(encode).join('')}`
  : `$${Buffer.byteLength(String(value))}\r\n${value}\r\n`;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('Bash RESP exchange repairs a scoped account and authenticates a separate consumer connection', async t => {
  let acl, repairs = 0, logins = 0;
  const port = await server(t, socket => {
    let buffer = Buffer.alloc(0), authenticated = false;
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      let parsed;
      while ((parsed = command(buffer))) {
        buffer = buffer.subarray(parsed.position);
        const args = parsed.result;
        let response;
        if (args[0] === 'AUTH') {
          logins++;
          const [user, password] = args.length === 3 ? args.slice(1) : ['default', args[1]];
          authenticated = user === 'default' ? password === 'root-test-password' : user === 'bridge' && acl?.on && acl.password === hash(password);
          response = authenticated ? '+OK\r\n' : '-WRONGPASS private-response\r\n';
        } else if (!authenticated) response = '-NOAUTH private-response\r\n';
        else if (args[0] === 'PING') response = '+PONG\r\n';
        else if (args[1] === 'GETUSER') response = encode(acl ? ['flags', [acl.on ? 'on' : 'off'], 'passwords', [acl.password], 'keys', '~auth:*', 'commands', '+@all', 'selectors', []] : null);
        else if (args[1] === 'SETUSER') {
          assert.deepEqual(args.slice(0, 5), ['ACL', 'SETUSER', 'bridge', 'reset', 'on']);
          assert.deepEqual(args.slice(6), ['~auth:*', '+@all']);
          acl = { on: true, password: args[5].slice(1) }; repairs++; response = '+OK\r\n';
        } else { assert.equal(args[0], 'SELECT'); response = '+OK\r\n'; }
        socket.write(response.slice(0, 2)); setTimeout(() => socket.write(response.slice(2)), 2);
      }
    });
  });
  const config = { endpoint: { host: '127.0.0.1', port }, username: 'bridge', password: 'chosen-ü-private-password', admin: { password: 'root-test-password' }, database: 1 };
  const dir = workspace(t, { 'redis.json': config });
  const code = 'source "$DEPLOYMENT/reconcile.sh"; STATE_DIR="$WORKDIR"; ensure_redis "$WORKDIR/redis.json"; cat "$WORKDIR/redis-status.json"';
  let result = await bashAsync(dir, code).result;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { authenticated: true, changed: true });
  assert.equal(repairs, 1); assert.equal(logins, 2);
  result = await bashAsync(dir, code).result;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { authenticated: true, changed: false });
  assert.equal(repairs, 1);
  acl.on = false;
  result = await bashAsync(dir, code).result;
  assert.equal(result.status, 0, result.stderr); assert.equal(repairs, 2);
  config.admin.password = 'wrong'; fs.writeFileSync(path.join(dir, 'redis.json'), JSON.stringify(config));
  result = await bashAsync(dir, code).result;
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes('private-response') && !result.stderr.includes('private-response'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'failure.json'))).code, 'REDIS_COMMAND');
});

test('Bash NATS check requires PONG and uses only the configured native credentials', async t => {
  let seen, denied = false, connections = 0;
  const port = await server(t, socket => {
    connections++; socket.write('INFO {"auth_required":true}\r\n');
    let text = '';
    socket.on('data', data => {
      text += data; let index;
      while ((index = text.indexOf('\r\n')) >= 0) {
        const line = text.slice(0, index); text = text.slice(index + 2);
        if (line.startsWith('CONNECT ')) {
          seen = JSON.parse(line.slice(8));
          if (denied) socket.write('-ERR private-response\r\n');
        } else if (line === 'PING') { if (!denied) socket.write('PONG\r\n'); }
        else assert.fail(`Unexpected NATS command ${line}`);
      }
    });
  });
  const dir = workspace(t, { 'nats.json': { url: 'nats://native:private%40password@nats.infrastructure.svc.cluster.local:4222' } });
  const code = 'source "$DEPLOYMENT/reconcile.sh"; STATE_DIR="$WORKDIR"; nats_connect() { exec {NATS_FD}<>/dev/tcp/127.0.0.1/"$TEST_PORT"; }; nats_ping "$WORKDIR/nats.json"';
  let result = await bashAsync(dir, code, { TEST_PORT: String(port) }).result;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(seen.user, 'native'); assert.equal(seen.pass, 'private@password');
  assert.equal(seen.jwt, undefined);
  denied = true;
  result = await bashAsync(dir, code, { TEST_PORT: String(port) }).result;
  assert.notEqual(result.status, 0); assert.ok(!result.stderr.includes('private-response'));
  const before = connections;
  for (const url of ['nats://foreign:4222', 'nats://bad%GG@nats.infrastructure.svc.cluster.local:4222']) {
    fs.writeFileSync(path.join(dir, 'nats.json'), JSON.stringify({ url }));
    result = await bashAsync(dir, code, { TEST_PORT: String(port) }).result;
    assert.notEqual(result.status, 0);
  }
  assert.equal(connections, before);
});

test('reconciler HTTP endpoints expose bounded public status and readiness', t => {
  const dir = workspace(t, { 'status.json': { ready: false, code: 'OCM_WORKLOADS_PENDING' } });
  for (const [request, status, content] of [
    ['GET /health HTTP/1.1\r\n\r\n', 200, '"active":true'],
    ['GET /status HTTP/1.1\r\n\r\n', 200, 'OCM_WORKLOADS_PENDING'],
    ['GET /ready HTTP/1.1\r\n\r\n', 503, 'OCM_WORKLOADS_PENDING'],
    ['POST /status HTTP/1.1\r\n\r\n', 405, 'METHOD_NOT_ALLOWED'],
    ['GET /unknown HTTP/1.1\r\n\r\n', 404, 'NOT_FOUND'],
  ]) {
    const result = bash(dir, 'source "$DEPLOYMENT/reconcile.sh"; STATE_DIR="$WORKDIR"; printf \'%s\' "$REQUEST" | http_response', { REQUEST: request });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^HTTP/1.1 ${status} `)); assert.ok(result.stdout.includes(content));
    const [headers, body] = result.stdout.split('\r\n\r\n');
    assert.equal(Number(/Content-Length: (\d+)/.exec(headers)[1]), Buffer.byteLength(body));
  }
});
