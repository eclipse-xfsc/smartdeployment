'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const lock = require('../upstream-lock.json');
const {fail} = require('./config');

function once(text, from, to, filename) {
  if (text.split(from).length !== 2) fail('UPSTREAM_CONTRACT', `Expected one adaptation point in ${filename}. No deployment was started.`);
  return text.replace(from, to);
}
function networkValues(c) {
  const annotations = {};
  if (c.actualProvider !== 'hetzner') for (const key of ['network-zone','use-private-ip','protocol','type','health-check-protocol','uses-proxyprotocol','disable-private-ingress']) annotations[`load-balancer.hetzner.cloud/${key}`] = null;
  Object.assign(annotations, c.lbAnnotations);
  const overrides = {'INFRA/network/envoy': {envoyProxy:{service:{annotations}}}};
  if (c.externalDns) {
    // Public LBs may expose IPv4, IPv6 or a hostname; the upstream A-only
    // restriction prevents automatic DNS for common non-Hetzner controllers.
    const dns = {extraArgs:['--txt-prefix=reg-%{record_type}.','--managed-record-types=A','--managed-record-types=AAAA','--managed-record-types=CNAME']};
    if(c.actualDns==='custom')Object.assign(dns,c.dnsValues);
    overrides['INFRA/network/external-dns'] = {'external-dns': dns};
  }
  // The JSON is a Go-template string literal; embedded {{...}} in values remains data.
  const esbTemplatePatch = Object.entries(overrides).map(([p,v],i) => `{{ ${i ? 'else if' : 'if'} eq .path.path ${JSON.stringify(p)} }}\nspec:\n  source:\n    helm:\n      valuesObject: {{ ${JSON.stringify(JSON.stringify(v))} }}`).join('\n') + '\n{{ end }}\n';
  return {esbTemplatePatch};
}
async function adapt(dir) {
  // Check every adapted file before changing any. Only reviewed bootstrap source is executed.
  for (const [name, sha] of Object.entries(lock.sha256)) {
    const text = await fs.readFile(path.join(dir,name));
    if (crypto.createHash('sha256').update(text).digest('hex') !== sha) fail('UPSTREAM_CONTRACT', `Upstream contract differs: ${name}.`);
  }
  for (const name of ['basic-cluster-init.sh','ocm-wstack-init.sh']) {
    let text = await fs.readFile(path.join(dir,name),'utf8');
    text = once(text, '#!/usr/bin/env bash\n', '#!/usr/bin/env bash\nset -Eeuo pipefail\ntrap \'echo "[ESB_FAILURE] bootstrap stopped at line $LINENO" >&2\' ERR\n', name);
    text = text.replace(/^STORAGE_CLASS=.+$/m, 'STORAGE_CLASS="${ESB_STORAGE_CLASS:?ESB selected StorageClass is required}"');
    text = text.replace(/^helm install /gm, 'helm upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" ');
    // Kubernetes operators need running admission endpoints before downstream charts.
    const waits = {
      // Upstream OpenBao uses OnDelete, which rollout status cannot handle.
      // Its bootstrap hook already waits for and unseals this named pod.
      openbao: 'kubectl -n security wait --for=condition=Ready pod/openbao-0 --timeout="${ESB_TIMEOUT_SECONDS}s"',
      eso: 'kubectl -n security rollout status deployment -l app.kubernetes.io/instance=eso --timeout="${ESB_TIMEOUT_SECONDS}s"',
      kyverno: 'kubectl -n security rollout status deployment -l app.kubernetes.io/instance=kyverno --timeout="${ESB_TIMEOUT_SECONDS}s"',
      'kubernetes-operator': 'kubectl -n security rollout status deployment -l app.kubernetes.io/instance=kubernetes-operator --timeout="${ESB_TIMEOUT_SECONDS}s"'
    };
    text = text.split('\n').map(line => {
      if (!line.startsWith('helm upgrade --install ')) return line;
      const nameMatch = line.match(/-n ([\w-]+) ([\w-]+) /);
      if (!nameMatch) fail('UPSTREAM_CONTRACT','Unrecognized official Helm install.');
      let command = line;
      if (nameMatch[2] === 'network') command += ' -f "$ESB_NETWORK_VALUES"';
      return `echo "[ESB_PHASE] ${nameMatch[2]}"\n${command}${waits[nameMatch[2]] ? '\n'+waits[nameMatch[2]] : ''}`;
    }).join('\n');
    if (name === 'basic-cluster-init.sh') {
      text = once(text, 'DNSTOKEN=""', 'DNSTOKEN="${ESB_DNS_SECRET_FILE:+provided-through-file}"', name);
      for (const ns of ['observability','security']) text = once(text, `kubectl create namespace ${ns}\n`, `kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -\n`, name);
      text = once(text, 'kubectl create secret generic external-dns \\\n    -n infrastructure \\\n    --from-literal=token="$DNSTOKEN"', 'kubectl apply -f "$ESB_DNS_SECRET_FILE"', name);
    }
    await fs.writeFile(path.join(dir,name),text);
    await fs.chmod(path.join(dir,name),0o700);
  }
  const argo = 'argocd-bootstrap.sh';
  let text = await fs.readFile(path.join(dir,argo),'utf8');
  text = once(text, 'readonly TIMEOUT="300s"', 'readonly TIMEOUT="${ESB_TIMEOUT_SECONDS:-300}s"', argo);
  text = once(text, 'echo "Admin Password: $password"', 'echo "Admin password remains in the argocd-initial-admin-secret Secret."', argo);
  // Do not read the password at all; leave the official existence check intact.
  const start = text.indexOf('password=$(\n');
  if (start < 0) fail('UPSTREAM_CONTRACT','Argo password block changed.');
  const end = text.indexOf('\n)\n',start);
  if (end < 0) fail('UPSTREAM_CONTRACT','Argo password block terminator changed.');
  text = text.slice(0,start)+text.slice(end+3);
  await fs.writeFile(path.join(dir,argo),text);
  await fs.chmod(path.join(dir,argo),0o700);
  const appset = 'XFSC/Applicationsets/chart/templates/applicationset-template.yaml';
  await fs.appendFile(path.join(dir,appset), '\n{{- with .Values.esbTemplatePatch }}\n  templatePatch: {{ . | quote }}\n{{- end }}\n');
  const registration = 'XFSC/tenant/chart/templates/tenant-registration.yaml';
  text = await fs.readFile(path.join(dir,registration),'utf8');
  text = once(text, '                --show-error \\', '                --fail-with-body \\\n                --show-error \\', registration);
  await fs.writeFile(path.join(dir,registration),text);
  await fs.chmod(path.join(dir,'check-applicationset.sh'),0o700);
}
module.exports = {adapt, networkValues};
