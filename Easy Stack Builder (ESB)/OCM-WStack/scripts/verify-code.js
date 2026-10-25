'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const register = JSON.parse(fs.readFileSync(path.join(root, 'docs/requirements.json')));
const open = register.requirements.filter(item => item.codeStatus !== 'Done');
const missingLocks = ['package-lock.json', 'runtime/package-lock.json', 'ui/package-lock.json']
  .filter(file => !fs.existsSync(path.join(root, file)));
if (open.length || missingLocks.length) {
  console.error(JSON.stringify({ codeDone: false,
    openRequirements: open.map(item => ({ id: item.id, status: item.codeStatus, remaining: item.remaining })),
    missingDependencyLocks: missingLocks }, null, 2));
  process.exitCode = 1;
} else {
  for (const script of ['verify:source', 'format:check', 'lint', 'typecheck', 'test', 'test:bdd', 'build:ui', 'test:ui', 'test:helm']) {
    const result = spawnSync('npm', ['run', script], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) { process.exitCode = 1; break; }
  }
  // These attestations must identify the exact release; source unit tests alone cannot replace them.
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'BUILD-STATUS.json')));
  for (const key of ['controlledStackIntegration', 'browserAccessibility', 'containerBuild', 'sbomAndLicenseReview', 'migrationRollback']) {
    if (evidence.gates[key]?.status !== 'passed' || !evidence.gates[key]?.evidence) {
      console.error('Required executed evidence missing: ' + key); process.exitCode = 1;
    }
  }
}
