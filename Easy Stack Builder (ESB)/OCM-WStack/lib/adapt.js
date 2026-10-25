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
const HETZNER_KEYS=['network-zone','location','use-private-ip','protocol','type','health-check-protocol','uses-proxyprotocol','disable-private-ingress'];
function networkOverrides(c) {
  const annotations={};
  for(const key of c.upstreamAnnotationKeys || HETZNER_KEYS.map(k=>'load-balancer.hetzner.cloud/'+k))annotations[key]=null;
  Object.assign(annotations,c.resolvedLbAnnotations || require('./providers').annotations(c));
  const overrides={'INFRA/network/envoy':{envoyProxy:{service:{annotations}}}};
  if(c.externalDns){
    const dns={extraArgs:['--txt-prefix=reg-%{record_type}.','--managed-record-types=A','--managed-record-types=AAAA','--managed-record-types=CNAME']};
    if(c.actualDns==='custom')Object.assign(dns,c.dnsValues);
    overrides['INFRA/network/external-dns']={'external-dns':dns};
  }
  return overrides;
}
function networkValues(c) {
  // A string preserves intentional Helm nulls through ApplicationSet RFC7396
  // merge-patching. valuesObject would consume these nulls before Helm.
  const esbTemplatePatch=Object.entries(networkOverrides(c)).map(([p,v],i)=>`{{ ${i?'else if':'if'} eq .path.path ${JSON.stringify(p)} }}
spec:
  source:
    helm:
      valuesObject: null
      values: {{ ${JSON.stringify(JSON.stringify(JSON.stringify(v)))} }}`+(p==='INFRA/network/envoy'?`
  ignoreDifferences:
    - group: gateway.envoyproxy.io
      kind: EnvoyProxy
      name: envoy
      namespace: infrastructure
      jsonPointers:
        - /spec/provider/kubernetes/envoyService/externalTrafficPolicy
  syncPolicy:
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
      - RespectIgnoreDifferences=true`:'' )).join('\n')+'\n{{ end }}\n';
  return {esbTemplatePatch};
}
async function adapt(dir) {
  // Check every adapted file before changing any. Only reviewed bootstrap source is executed.
  for (const [name, sha] of Object.entries(lock.sha256)) {
    const text = await fs.readFile(path.join(dir,name));
    if (crypto.createHash('sha256').update(text).digest('hex') !== sha) fail('UPSTREAM_CONTRACT', `Upstream contract differs: ${name}.`);
  }
  // The wrapper's optional monitor is separate from the enabled subchart monitor.
  // Supply its missing default rather than disabling Kyverno's native monitoring.
  await fs.appendFile(path.join(dir,'INFRA/security/kyverno/values.yaml'), '\n\nserviceMonitor:\n  enabled: false\n');
  const tempo = 'INFRA/observability/opentelemtry/values.yaml';
  let values = await fs.readFile(path.join(dir,tempo),'utf8');
  values = once(values, '          grpc:\n          http:', '          grpc:\n            endpoint: 0.0.0.0:4317\n          http:\n            endpoint: 0.0.0.0:4318', tempo);
  values = once(values, '\nmonitoring:\n', '\nmonitoring:\n  enabled: true\n  prometheus:\n    enabled: true\n', tempo);
  // One canonical datasource ConfigMap: the wrapper owns all five definitions.
  // Disable the monitoring subchart's builtin and additional duplicates.
  values = once(values, '        labelValue: "1"', '        labelValue: "1"\n        defaultDatasourceEnabled: false\n        alertmanager:\n          enabled: false', tempo);
  const dataStart = values.indexOf('    additionalDataSources:\n');
  const dataEnd = values.indexOf('\nloki:\n', dataStart);
  if(dataStart < 0 || dataEnd < 0)fail('UPSTREAM_CONTRACT','Grafana datasource values changed.');
  values = values.slice(0,dataStart) + '    additionalDataSources: []\n' + values.slice(dataEnd);
  await fs.writeFile(path.join(dir,tempo),values);
  const telemetry = 'INFRA/observability/opentelemtry/crds/telemetryconfig.yaml';
  let crd = await fs.readFile(path.join(dir,telemetry),'utf8');
  crd = once(crd, '  metrics:\n      enabled: true\n', '', telemetry);
  await fs.writeFile(path.join(dir,telemetry),crd);
  const project = 'XFSC/Applicationsets/chart/templates/approject.yaml';
  let projectText = await fs.readFile(path.join(dir,project),'utf8');
  projectText = once(projectText, '{{- if not $existingProject }}', '{{- if or (not $existingProject) (and (eq (dig "metadata" "annotations" "meta.helm.sh/release-name" "" $existingProject) $.Release.Name) (eq (dig "metadata" "annotations" "meta.helm.sh/release-namespace" "" $existingProject) $.Release.Namespace)) }}', project);
  await fs.writeFile(path.join(dir,project),projectText);
  const provision = 'INFRA/app-management/app-namespace/templates/openbao-access-provision-job.yaml';
  let provisionText = await fs.readFile(path.join(dir,provision),'utf8');
  const typeStart = provisionText.indexOf('                MOUNT_TYPE="$(\n');
  const typeEnd = provisionText.indexOf('\n                )"',typeStart);
  if(typeStart < 0 || typeEnd < 0) fail('UPSTREAM_CONTRACT','OpenBao mount check changed.');
  // The upstream sed assumes single-line JSON, but bao emits indented JSON.
  // The CLI table has stable Path/Type columns and supports an exact path match.
  provisionText = provisionText.slice(0,typeStart) + '                MOUNT_TYPE="$(\n                  bao secrets list -format=table |\n                    awk -v mount="${STORE_MOUNT}/" \'$1 == mount {print $2; exit}\'\n                )"' + provisionText.slice(typeEnd+'\n                )"'.length);
  await fs.writeFile(path.join(dir,provision),provisionText);
  for (const name of ['basic-cluster-init.sh','ocm-wstack-init.sh']) {
    let text = await fs.readFile(path.join(dir,name),'utf8');
    text = once(text, '#!/usr/bin/env bash\n', '#!/usr/bin/env bash\nset -Eeuo pipefail\ntrap \'echo "[ESB_FAILURE] bootstrap stopped at line $LINENO" >&2\' ERR\n', name);
    // prepare() already downloaded and rendered these exact local dependencies.
    // Rebuilding them here would select new versions after cluster writes begin.
    text = text.replace(/^helm (?:repo add|dependency build) .+$/gm, ': # Dependencies prepared by ESB chart preflight');
    text = text.replace(/^STORAGE_CLASS=.+$/m, 'STORAGE_CLASS="${ESB_STORAGE_CLASS:?ESB selected StorageClass is required}"');
    text = text.replace(/^helm install /gm, 'helm upgrade --install --timeout "${ESB_TIMEOUT_SECONDS}s" ');
    // Kubernetes operators need running admission endpoints before downstream charts.
    const waits = {
      // Upstream OpenBao uses OnDelete, which rollout status cannot handle.
      // Its bootstrap hook already waits for and unseals this named pod.
      observability: 'kubectl -n observability rollout status deployment -l app.kubernetes.io/name=grafana,app.kubernetes.io/instance=observability --timeout="${ESB_TIMEOUT_SECONDS}s"',
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
      if (nameMatch[2] === 'ocm-wstack') command += ' -f "$ESB_OCM_VALUES"';
      command = command.replace(/^helm /, `node "\${ESB_HELM_UPGRADE:?ESB Helm runner is required}" ${nameMatch[1]} ${nameMatch[2]} `);
      const prerequisites=nameMatch[2]==='ocm-wstack'?'node "${ESB_OCM_PREREQUISITES:?ESB OCM prerequisites are required}"\n':'';
      return `echo "[ESB_PHASE] ${nameMatch[2]}"\n${prerequisites}${command}${waits[nameMatch[2]] ? '\n'+waits[nameMatch[2]] : ''}`;
    }).join('\n');
    if (name === 'basic-cluster-init.sh') {
      text=once(text,'./check-applicationset.sh network argocd','./check-applicationset.sh network argocd\nnode "${ESB_GATEWAY_CONFIG:?ESB gateway compatibility runner is required}" policy\nnode "${ESB_GATEWAY_CONFIG:?ESB gateway compatibility runner is required}" reconcile',name);
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
  text = once(text, 'readonly ARGO_MANIFEST="https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml"', 'readonly ARGO_MANIFEST="${ESB_ARGO_MANIFEST:?ESB Argo manifest preflight is required}"', argo);
  const crdWait = ['applications','applicationsets','appprojects'].map(kind => `node "\${ESB_KUBE_READ:?ESB API reader is required}" /apis/apiextensions.k8s.io/v1/customresourcedefinitions/${kind}.argoproj.io established >/dev/null`).join('\n');
  text = once(text, 'components=(', crdWait + '\n\ncomponents=(', argo);
  text = once(text, '  "deployment/argocd-server"', '  "deployment/argocd-redis"\n  "deployment/argocd-dex-server"\n  "deployment/argocd-server"', argo);
  text = once(text, '      kubectl get pods -n "$NAMESPACE" -o wide', '      node "${ESB_ARGO_HEALTH:?ESB Argo health checker is required}" --diagnose >&2 || true', argo);
  const healthStart=text.indexOf('not_ready=$(\n');
  const healthEnd=text.indexOf('\n# =========================\n# Verify Initial Secret Exists',healthStart);
  if(healthStart<0||healthEnd<0)fail('UPSTREAM_CONTRACT','Argo pod health check changed.');
  text=text.slice(0,healthStart)+'node "${ESB_ARGO_HEALTH:?ESB Argo health checker is required}" || exit "$EXIT_POD_FAILED"\n'+text.slice(healthEnd);
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
  const appWait='check-applicationset.sh';
  let waitText=await fs.readFile(path.join(dir,appWait),'utf8');
  const query = '    kubectl get applications.argoproj.io \\\n      --namespace "$ARGOCD_NAMESPACE" \\\n      --output json';
  waitText=once(waitText, query, '    ESB_READ_TIMEOUT_SECONDS="$(( TIMEOUT_SECONDS - $(date +%s) + START_TIME > 0 ? TIMEOUT_SECONDS - $(date +%s) + START_TIME : 1 ))" node "${ESB_KUBE_READ:?ESB API reader is required}" \\\n      "/apis/argoproj.io/v1alpha1/namespaces/$ARGOCD_NAMESPACE/applications"', appWait);
  waitText=once(waitText, '  count="$(jq \'length\' <<< "$appset_applications")"', '  count="$(jq \'length\' <<< "$appset_applications")"\n  expected="$(jq -er --arg name "$APPSET_NAME" \'.[$name]\' <<< "${ESB_APPSET_COUNTS:?ESB chart plan is required}")"', appWait);
  waitText=once(waitText, '    if [[ -z "$not_ready" ]]; then', '    if [[ -z "$not_ready" && "$count" -eq "$expected" ]]; then', appWait);
  waitText=once(waitText, '    echo "Noch nicht bereit:"', '    echo "Applications: ${count}/${expected}; waiting for the complete ApplicationSet."\n    echo "Noch nicht bereit:"', appWait);
  await fs.writeFile(path.join(dir,appWait),waitText);
  await fs.chmod(path.join(dir,appWait),0o700);
}
module.exports = {adapt, networkValues, networkOverrides};
