#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const { prepareMigration, applyMigration } = require('../lib/ui-migration');

async function readPrivate(filename) {
  const stat = await fs.stat(filename);
  if (stat.mode & 0o077) throw Error('Input containing credentials must have mode 0600.');
  return fs.readFile(filename, 'utf8');
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '--dry-run' && args.length === 4) {
    const [exportFile, hashesFile, outputFile, tenant] = args;
    const plan = prepareMigration(JSON.parse(await readPrivate(exportFile)), JSON.parse(await readPrivate(hashesFile)), tenant);
    await fs.writeFile(outputFile, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ state: 'prepared', ...plan.summary }));
  } else if (mode === '--apply' && args.length === 2) {
    const [planFile, uriFile] = args;
    const plan = JSON.parse(await readPrivate(planFile));
    const uri = (await readPrivate(uriFile)).trim();
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    try { await client.connect(); console.log(JSON.stringify(await applyMigration(client.db('ocm_ui'), plan))); }
    finally { await client.close(); }
  } else {
    throw Error('Usage: migrate-ui.js --dry-run EXPORT HASHES PLAN TENANT | --apply PLAN MONGO_URI_FILE');
  }
}
main().catch(error => { console.error(error.code || 'MIGRATION_FAILED'); process.exitCode = 1; });
