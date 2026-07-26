#!/usr/bin/env node

'use strict';

const fs = require('fs');

const input = fs.readFileSync(0, 'utf8');
const probeBlock = /(^[ \t]*)livenessProbe:\r?\n\1  httpGet:\r?\n\1    path: \/health\r?\n\1    port: ([^\r\n]+)\r?\n\1readinessProbe:\r?\n\1  httpGet:\r?\n\1    path: \/health\r?\n\1    port: \2/m;
const match = input.match(probeBlock);

if (!match) {
  console.error('DIDComm post-renderer: expected health probe block was not found.');
  process.exit(1);
}

const indent = match[1];
const port = match[2];
const replacement = [
  `${indent}startupProbe:`,
  `${indent}  httpGet:`,
  `${indent}    path: /health`,
  `${indent}    port: ${port}`,
  `${indent}  periodSeconds: 5`,
  `${indent}  timeoutSeconds: 2`,
  `${indent}  failureThreshold: 120`,
  `${indent}livenessProbe:`,
  `${indent}  httpGet:`,
  `${indent}    path: /health`,
  `${indent}    port: ${port}`,
  `${indent}readinessProbe:`,
  `${indent}  httpGet:`,
  `${indent}    path: /health`,
  `${indent}    port: ${port}`,
].join('\n');

const output = input.replace(probeBlock, replacement);
process.stdout.write(output);
