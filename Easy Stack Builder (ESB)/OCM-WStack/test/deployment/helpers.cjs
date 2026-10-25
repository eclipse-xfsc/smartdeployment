'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');

function jq(expression, input, variables = {}) {
  const args = ['-L', path.join(ROOT, 'deployment')];
  for (const [key, value] of Object.entries(variables)) args.push('--argjson', key, JSON.stringify(value));
  args.push(`include "filters"; ${expression}`);
  const result = spawnSync('jq', args, { input: JSON.stringify(input), encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const details = [
      `jq filters: exit=${result.status}, signal=${result.signal || 'none'}`,
      result.error && `${result.error.code}: ${result.error.message}`,
      result.stderr && result.stderr.trim(),
    ].filter(Boolean).join('\n');
    throw new Error(details, { cause: result.error });
  }
  assert.ok(result.stdout.trim(), 'The transformation must return a value');
  return JSON.parse(result.stdout);
}

function workspace(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esb-bash-test-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({ 'config.json': {}, 'credentials.json': {}, ...files })) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
  }
  return dir;
}

function shellSource(code) {
  return `set -Eeuo pipefail
shopt -s inherit_errexit
DEPLOYMENT="$ROOT/deployment"
CONFIG="$WORKDIR/config.json"
CREDENTIALS="$WORKDIR/credentials.json"
TIMEOUT_SECONDS=60
exec 3>"$WORKDIR/events.jsonl"
source "$DEPLOYMENT/common.sh"
load_libraries
${code}`;
}

function bash(dir, code, extraEnv = {}) {
  return spawnSync('bash', ['-c', shellSource(code)], {
    cwd: ROOT, env: { ...process.env, ROOT, WORKDIR: dir, ...extraEnv }, encoding: 'utf8', timeout: 15000,
  });
}

function bashAsync(dir, code, extraEnv = {}) {
  const child = spawn('bash', ['-c', shellSource(code)], {
    cwd: ROOT, env: { ...process.env, ROOT, WORKDIR: dir, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  return { child, result };
}

module.exports = { ROOT, jq, workspace, bash, bashAsync };
