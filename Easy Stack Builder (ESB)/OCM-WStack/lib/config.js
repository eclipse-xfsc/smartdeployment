'use strict';
const crypto = require('node:crypto');

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function object(value, name) {
  if (!value) return {};
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { fail('CONFIG', `${name} must be a JSON object.`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail('CONFIG', `${name} must be a JSON object.`);
  return parsed;
}
function dnsName(value) {
  return typeof value === 'string' && value.length <= 253 && value.split('.').every(x => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x));
}
function config(input = {}) {
  const c = {
    procedureVersion: Number(input.procedureVersion),
    instanceName: input.instanceName || 'ocm-wstack',
    domain: (input.domainAddress || input.domain || '').trim().toLowerCase().replace(/^\*\./,''),
    email: (input.emailAddress || input.email || '').trim(),
    tenantId: (input.tenantId || 'demo-tenant').trim(),
    tenantRelease: (input.tenantRelease || 'demotenant').trim(),
    tenantSubdomain: (input.tenantSubdomain || input.tenantId || 'demo-tenant').trim().toLowerCase().replace(/_/g, '-'),
    provider: input.provider || 'auto', storageClass: (input.storageClass || '').trim(),
    externalDns: input.externalDns === true || input.externalDns === 'true',
    dnsProvider: input.dnsProvider || 'auto',
    dnsValues: object(input.dnsValues, 'ExternalDNS values'),
    lbAnnotations: object(input.lbAnnotations, 'Load-balancer annotations'),
    timeoutSeconds: Number(input.timeoutSeconds || 1800),
    externalTrafficPolicy: input.externalTrafficPolicy || 'Cluster',
    gatewayRouting: 'internal', tlsMode: 'uploaded', publicDashboards: input.publicDashboards===true || input.publicDashboards==='true',
    lbLocation: (input.lbLocation || '').trim(), lbNetworkZone: (input.lbNetworkZone || '').trim(), lbType: (input.lbType || '').trim(), lbPrivate: input.lbPrivate===true || input.lbPrivate==='true',
    runtimeEnabled: true,
    runtimeImage: input.runtimeImage || 'ecofacis/xfsc-orce:2.0.15',
    orceStorageSize: input.orceStorageSize || '3Gi', mongoStorageSize: input.mongoStorageSize || '5Gi',
    useExternalMongo: input.useExternalMongo===true || input.useExternalMongo==='true',
    editorUsername: input.editorUsername || 'admin', uiAdminUsername: input.uiAdminUsername || 'admin', uiAdminEmail: input.uiAdminEmail || input.emailAddress || input.email || '',
    runtimeServices: object(input.runtimeServices, 'Runtime service overrides'),
    pcm: {enabled:false}
  };
  if (c.procedureVersion !== 12) fail('RECONFIGURE', 'Create a new version 12 OCM-W-Stack node. Previous deployment configuration is not migrated.');
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(c.instanceName)) fail('CONFIG', 'Instance name must be 2–40 lowercase letters, digits or hyphens.');
  if (!dnsName(c.domain) || !c.domain.includes('.')) fail('CONFIG', 'Domain must be a bare, public DNS domain, without scheme or path.');
  if (c.email && !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(c.email)) fail('CONFIG', 'The optional email address is invalid.');
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(c.tenantId)) fail('CONFIG', 'Tenant ID must start with a lowercase letter and contain at most 40 lowercase letters, digits, underscores or hyphens.');
  if (!dnsName(c.tenantSubdomain) || c.tenantSubdomain.includes('.') || !dnsName(`${c.tenantSubdomain}.${c.domain}`)) fail('CONFIG', 'Tenant subdomain must be one DNS label; the complete hostname must fit DNS limits.');
  if (!dnsName(c.tenantRelease) || c.tenantRelease.includes('.') || c.tenantRelease.length > 35) fail('CONFIG', 'Tenant release must be a DNS label of at most 35 characters.');
  if (!require('./providers').PROVIDERS.includes(c.provider)) fail('CONFIG', 'Unknown cluster provider; use generic for a standard Kubernetes cluster.');
  if (!['auto','hetzner','ionos','custom'].includes(c.dnsProvider)) fail('CONFIG', 'Select an upstream DNS profile or custom ExternalDNS values.');
  if (c.storageClass && !dnsName(c.storageClass)) fail('CONFIG', 'Invalid StorageClass name.');
  if (!Number.isInteger(c.timeoutSeconds) || c.timeoutSeconds < 60 || c.timeoutSeconds > 7200) fail('CONFIG', 'Stage timeout must be 60–7200 seconds.');
  if(!['auto','internal','public'].includes(c.gatewayRouting))fail('CONFIG','Tenant routing must be auto, internal or public.');
  if(!['Cluster','Local'].includes(c.externalTrafficPolicy))fail('CONFIG','Traffic policy must be Cluster or Local.');
  if(c.provider==='ionos'&&c.externalTrafficPolicy!=='Cluster')fail('CONFIG','IONOS requires Cluster traffic policy for this deployment.');
  for(const value of [c.lbLocation,c.lbNetworkZone,c.lbType])if(value&&!/^[a-z0-9/-]{1,64}$/.test(value))fail('CONFIG','Invalid load-balancer location, zone or type.');
  for(const value of [c.orceStorageSize,c.mongoStorageSize])if(!/^[1-9][0-9]*(?:Gi|Mi)$/.test(value))fail('CONFIG','Runtime PVC sizes must be positive Gi or Mi quantities.');
  if(!/^[a-zA-Z0-9_./:@-]+$/.test(c.runtimeImage)||c.runtimeImage.endsWith(':latest'))fail('CONFIG','Select a tagged ORCE runtime image.');
  for(const value of [c.editorUsername,c.uiAdminUsername])if(!/^[A-Za-z0-9_.@-]{1,64}$/.test(value))fail('CONFIG','Invalid initial administrator username.');
  for(const [name,url] of Object.entries(c.runtimeServices)){if(!['storage','retrieval','signer','status','didcomm','issuerBootstrap'].includes(name))fail('CONFIG','Unknown runtime service override.');try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error();}catch{fail('CONFIG','Service overrides must be HTTP(S) URLs without credentials.');}}
  for (const [k,v] of Object.entries(c.lbAnnotations)) if (!/^[a-zA-Z0-9./_-]+$/.test(k) || (v !== null && typeof v !== 'string')) fail('CONFIG', 'Load-balancer annotations must map annotation names to strings or null.');
  if (c.externalDns && c.dnsProvider === 'custom' && typeof c.dnsValues.provider?.name !== 'string') fail('CONFIG', 'Custom DNS requires provider.name in its ExternalDNS values.');
  c.tenantHost = `${c.tenantSubdomain}.${c.domain}`;
  c.tenantUrl = `https://${c.tenantHost}`;
  return c;
}
function provider(nodes,classes) {return require('./providers').detect(nodes,classes).provider;}
function storageClass(list, requested) {
  const items = list.items || [];
  if (requested) {
    if (!items.some(x => x.metadata.name === requested)) fail('STORAGE_CLASS', `StorageClass ${requested} does not exist.`);
    return requested;
  }
  const defaults = items.filter(x => ['storageclass.kubernetes.io/is-default-class','storageclass.beta.kubernetes.io/is-default-class'].some(k => x.metadata.annotations?.[k] === 'true'));
  if (defaults.length !== 1) fail('STORAGE_CLASS', `Found ${defaults.length} default StorageClasses. Select an existing class explicitly in the ESB editor.`);
  return defaults[0].metadata.name;
}
function resolve(c, nodes, classes, credentials) {
  const evidence=require('./providers').detect(nodes,classes);
  const detectedProvider=evidence.provider;
  const actualProvider = c.provider === 'auto' ? detectedProvider : c.provider;
  const actualDns = !c.externalDns ? 'disabled' : c.dnsProvider === 'auto' ? (['hetzner','ionos'].includes(actualProvider) ? actualProvider : '') : c.dnsProvider;
  if (!actualDns) fail('DNS_PROVIDER', 'The DNS hosting provider cannot be inferred from this cluster. Select Hetzner, IONOS or custom ExternalDNS values.');
  if (c.externalDns && ['hetzner','ionos'].includes(actualDns) && !credentials.dnsToken) fail('DNS_CREDENTIALS', `A DNS API token is required for ${actualDns}.`);
  const secret = c.externalDns && actualDns === 'custom' ? object(credentials.dnsSecretData, 'DNS Secret data') : {token: credentials.dnsToken || ''};
  if (c.externalDns && actualDns === 'custom') for (const [k,v] of Object.entries(secret)) if (!/^[A-Za-z0-9._-]+$/.test(k) || typeof v !== 'string') fail('DNS_CREDENTIALS', 'DNS Secret data must map valid Secret keys to strings.');
  if(actualProvider==='ionos'&&c.externalTrafficPolicy!=='Cluster')fail('CONFIG','IONOS requires Cluster traffic policy.');
  const resolved={...c, providerLocations:evidence.locations,providerZones:evidence.zones,providerEvidence:evidence.evidence, detectedProvider, actualProvider, actualDns, profile: ['hetzner','ionos'].includes(actualDns) ? actualDns : !c.externalDns && actualProvider === 'hetzner' ? 'hetzner' : 'generic', actualStorageClass: storageClass(classes, c.storageClass), dnsSecret: secret};
  // Cluster-to-public connectivity is independent of provider classification.
  // Uploaded-TLS deployments always use the managed internal tenant route.
  resolved.internalGatewayRouting=c.gatewayRouting!=='public';
  resolved.resolvedLbAnnotations=require('./providers').annotations(resolved);
  return resolved;
}
function fingerprint(c) {
  const clean = {...c}; delete clean.dnsSecret; delete clean.timeoutSeconds; delete clean.detectedProvider; delete clean.providerEvidence;delete clean.legacyFingerprint;delete clean.upstreamAnnotationKeys;delete clean.providerLocations;delete clean.providerZones;delete clean.resolvedLbAnnotations;
  for(const key of ['dnsOwnerId','tlsMode','publicDashboards','gatewayRouting','internalGatewayRouting','gatewayClusterIP','runtimeEnabled','runtimeImage','orceStorageSize','mongoStorageSize','useExternalMongo','editorUsername','uiAdminUsername','uiAdminEmail','runtimeServices','pcm'])delete clean[key];
  return crypto.createHash('sha256').update(JSON.stringify(clean)).digest('hex');
}
function kubeconfigText(value) {
  if(typeof value!=='string'||!value||value==='__PWRD__')fail('KUBECONFIG','Upload a usable kubeconfig in the node editor.');
  // Password inputs strip line breaks. The editor transports the file as base64
  // inside Node-RED's encrypted credentials store; CLI callers supply raw text.
  if(value.startsWith('base64:')) {
    const encoded=value.slice(7);
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))fail('KUBECONFIG','Invalid uploaded kubeconfig encoding.');
    return Buffer.from(encoded,'base64').toString('utf8');
  }
  return value;
}
module.exports = {config, resolve, provider, storageClass, fingerprint, fail, object, kubeconfigText};
