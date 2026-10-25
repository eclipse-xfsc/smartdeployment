'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { routes } = require('../runtime/lib/runtime.cjs');
const directory = path.join(__dirname, '../runtime/flows');
const publicRoutes = [
  ['GET', '/auth/config', 'Auth'], ['POST', '/auth/login', 'Auth'],
  ['POST', '/auth/csrf', 'Auth'], ['POST', '/auth/logout', 'Auth'],
  ['POST', '/auth/password', 'Auth'], ['GET', '/health/live', 'Base'],
  ['GET', '/health/ready', 'Base']
].map(([method, path, module]) => ({ method, path, module }));
const groups = ['Base', 'Auth', 'Credentials', 'ClearingCenter', 'Issue', 'Relationships', 'Provenance'];
const all = [];
const check = process.argv.includes('--check');
function emit(filename, data) {
  if (check) {
    if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== data) {
      console.error('Generated flow differs: ' + filename); process.exitCode = 1;
    }
  } else fs.writeFileSync(filename, data);
}
fs.mkdirSync(directory, { recursive: true });
for (const name of groups) {
  const tab = 'ocm-' + name.toLowerCase();
  const router = tab + '-service';
  const nodes = [
    { id: tab, type: 'tab', label: name, disabled: false },
    { id: router, type: 'ocm-ui-runtime', z: tab, name: name + ' service',
      module: name, x: 650, y: 120, wires: [] }
  ];
  const items = [...routes, ...publicRoutes].filter(route => route.module === name);
  for (const [index, route] of items.entries()) {
    nodes.push({ id: tab + '-http-' + index, type: 'http in', z: tab,
      name: route.method + ' ' + route.path, url: '/orce/ui-api/v1' + route.path,
      method: route.method.toLowerCase(), upload: false, swaggerDoc: '',
      x: 220, y: 60 + index * 50, wires: [[router]] });
  }
  if (name === 'Base') nodes.push({
    id: 'ocm-uibuilder', type: 'uibuilder', z: tab, name: 'OCM W-Stack UI',
    url: 'orce', fwdInMessages: false, allowScripts: false, allowStyles: false,
    copyIndex: false, templateFolder: 'blank', sourceFolder: 'dist',
    deployedVersion: '7.5.0', x: 220, y: 400, wires: [[], []]
  });
  const filename = name === 'Base' ? 'base_flow.json' : 'M-' + name + '_flow.json';
  emit(path.join(directory, filename), JSON.stringify(nodes, null, 2) + '\n');
  all.push(...nodes);
}
emit(path.join(__dirname, '../runtime/flows.json'), JSON.stringify(all, null, 2) + '\n');
console.log((check ? 'Checked ' : 'Generated ')  + groups.length + ' flow modules and ' + all.length + ' nodes.');
