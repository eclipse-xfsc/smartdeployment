'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { workspace, bash } = require('./helpers.cjs');

test('raw logs retain repeated and concurrent commands independently of work files', t => {
  const dir = workspace(t);
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  const result = bash(dir, `
phase fixture
run_capture "$WORKDIR/output" 5 bash -c 'printf first; printf first-error >&2'
run_capture "$WORKDIR/output" 5 bash -c 'printf second; printf second-error >&2'
(run_capture "$WORKDIR/parallel-a" 5 bash -c 'sleep 0.1; printf parallel-a') &
a=$!
(run_capture "$WORKDIR/parallel-b" 5 bash -c 'printf parallel-b') &
b=$!
wait "$a"; wait "$b"
rm "$WORKDIR/output"
`, { ESB_LOG_DIR: logs });
  assert.equal(result.status, 0, result.stderr);
  const commands = fs.readdirSync(logs).filter(n => n.startsWith('command.')).map(n => path.join(logs,n));
  assert.equal(commands.length, 4);
  assert.deepEqual(commands.map(p => fs.readFileSync(path.join(p,'stdout'),'utf8')).sort(), ['first','parallel-a','parallel-b','second']);
  for (const p of commands) {
    const start = JSON.parse(fs.readFileSync(path.join(p, 'start.json')));
    assert.equal(start.phase, 'fixture');
    assert.equal(JSON.parse(fs.readFileSync(path.join(p, 'end.json'))).exitCode, 0);
    assert.equal(fs.statSync(path.join(p, 'stdout')).mode & 0o777, 0o600);
  }
});

test('timeouts keep raw errors and the terminating status in the transcript', t => {
  const dir = workspace(t), logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  const result = bash(dir, `
if run_capture "$WORKDIR/output" 1 bash -c 'printf before-timeout; printf timeout-details >&2; sleep 10'; then exit 99; fi
[[ $LAST_TIMEOUT == true ]]
`, { ESB_LOG_DIR: logs });
  assert.equal(result.status, 0, result.stderr);
  const command = path.join(logs, fs.readdirSync(logs).find(n => n.startsWith('command.')));
  assert.equal(fs.readFileSync(path.join(command,'stdout'),'utf8'), 'before-timeout');
  assert.equal(fs.readFileSync(path.join(command,'stderr'),'utf8'), 'timeout-details');
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(command,'end.json'))).exitCode, 0);
});

test('unexpected shell failure records command location without changing its exit status', t => {
  const dir = workspace(t), logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  const result = bash(dir, `
source "$ROOT/deploy.sh"
bash -c 'printf unexpected-fixture-error >&2; exit 19'
`, { ESB_LOG_DIR: logs });
  assert.equal(result.status, 19, result.stderr);
  const error = fs.readdirSync(logs).find(n => n.startsWith('shell-error.'));
  assert.ok(error);
  const data = JSON.parse(fs.readFileSync(path.join(logs, error)));
  assert.equal(data.exitCode, 19);
  assert.ok(data.line > 0);
  assert.match(data.command, /unexpected-fixture-error/);
});
