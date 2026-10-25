'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '__pycache__', 'history'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename); else files.push(filename);
  }
}
walk(root);
let checked = 0;
for (const file of files) {
  if (/\.(js|cjs|mjs)$/.test(file)) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
    checked++;
  }
  if (file.endsWith('.sh')) {
    const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
    checked++;
  }
  if (file.endsWith('.jq')) {
    const name = path.basename(file, '.jq');
    const result = spawnSync('jq', ['-n', '-L', path.dirname(file), `include "${name}"; null`], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
    checked++;
  }
  if (file === path.join(root, 'ocmwstack.html')) {
    const source = fs.readFileSync(file, 'utf8');
    const script = source.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)?.[1];
    if (!script) { console.error('Missing editor script'); process.exitCode = 1; }
    else {
      const result = spawnSync(process.execPath, ['--check'], { input: script, encoding: 'utf8' });
      if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
      checked++;
    }
  }
  if (file.endsWith('.json')) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { console.error(file, error.message); process.exitCode = 1; }
  }
  if (file.endsWith('.vue')) {
    const source = fs.readFileSync(file, 'utf8');
    const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
    if (!script) { console.error('Missing SFC script: ' + file); process.exitCode = 1; continue; }
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: script, encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
    checked++;
  }
}
// This checks script syntax only. It is not a Vue compilation or type check.
const source = fs.readFileSync(path.join(root, 'ui/src/locales.js'), 'utf8');
const catalogs = JSON.parse(source.replace(/^export const locales = /, '').replace(/;\s*$/, ''));
const keys = Object.keys(catalogs.en).sort().join('\n');
for (const language of ['de', 'fr']) {
  if (Object.keys(catalogs[language]).sort().join('\n') !== keys) {
    console.error('Locale key mismatch: ' + language); process.exitCode = 1;
  }
}
const { routes } = require('../runtime/lib/runtime.cjs');
if (routes.some(route => route.path.startsWith('/pcm') || !route.module || !route.permission && !['me','preferences','setPreferences'].includes(route.action))) {
  console.error('Route scope or permission invariant failed.'); process.exitCode = 1;
}
const flow = spawnSync(process.execPath, [path.join(__dirname, 'build-flows.js'), '--check'], { encoding: 'utf8' });
if (flow.status !== 0) { process.stderr.write(flow.stderr); process.exitCode = 1; }
console.log(JSON.stringify({ scriptSyntaxChecks: checked, localeKeysPerLanguage: Object.keys(catalogs.en).length,
  generatedFlowCheck: flow.status === 0, passed: !process.exitCode }));
