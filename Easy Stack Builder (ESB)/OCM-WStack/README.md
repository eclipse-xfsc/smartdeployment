# OCM W-Stack ESB 12.1.0

12.1.0 updates the 12.0.9 official-bootstrap wrapper, persists the IONOS gateway fix and restores the OCM-CR runtime/UI from the recovered 11.1.0 source. It is a locally checked release candidate. A fresh-cluster deployment, real Helm rendering and browser/login acceptance have not been executed in this environment; see VALIDATION.md.

## Install and update the existing 12.0.9 deployment

Install `orce-esb-ocmwstack-12.1.0.tgz` in ORCE's Node-RED user directory, then restart ORCE:

```bash
npm install --omit=dev /path/to/orce-esb-ocmwstack-12.1.0.tgz
```

Keep the existing version-12 node, uploaded administrator kubeconfig, instance, tenant, domain, StorageClass, ownership marker, Helm history and PVCs. Open the node and save the new fields. Provider can remain automatic; IONOS can also be selected explicitly. Leave traffic policy at Cluster. On the ORCE credentials tab, enter the initial editor administrator and UI administrator credentials. Passwords must contain at least 12 characters. These are separate accounts; UI login requires an initial password change.

1. Run `msg.action = "preflight"`. This renders the entire selected plan, including the two new compatibility/runtime charts, before installation writes.
2. Run `msg.action = "repair-network"` to update the network ApplicationSet, install the scoped persistent traffic policy and reconcile the existing proxy. It retains OCM, the tenant certificate and shared data. This action can run before the UI is installed; the final status may remain action-required until the UI is present.
3. Run `msg.action = "install-ui"` to add the recovered runtime, MongoDB and persistent identity components to the matching existing installation.
4. Run `msg.action = "validate"` after DNS/TLS and the UI are ready. For `demo-tenant.leanea.com`, the application URL is `https://demo-tenant.leanea.com/orce/` and the editor is `https://demo-tenant.leanea.com/orce/editor/`.

For a fresh cluster, configure the credentials and run preflight, then deploy. Deploy performs the official bootstrap, gateway compatibility, tenant setup and UI installation automatically. Removing/redeploying the Node-RED node only cancels its local process and retains cluster resources.

A narrowly checked migration accepts a matching 12.0.9 ownership marker from `739606691ecff72b3a40404a19fce44d9c22b0ee`. The current commit changes only the two reviewed Retrieval scripts. Other clusters, tenants and configurations are not adopted. This does not migrate an 11.x cluster installation; only its UI source is carried forward.

## Upstream alignment

The source of truth remains [eclipse-xfsc/deployment/main](https://github.com/eclipse-xfsc/deployment/tree/main). Reviewed commit: [8485621574abdee08b8ca24c2f0f60136ba0dad7](https://github.com/eclipse-xfsc/deployment/tree/8485621574abdee08b8ca24c2f0f60136ba0dad7), inspected on 1 October 2026. It adds `OCM W-Stack/Tools/scripts/retrieval-test.sh` and `retrieval-acceptance.sh` to the previous baseline. Bootstrap files are checked byte-for-byte against the lock before adaptation.

The official bootstrap order, tenant Helm chart, native OCM routes and service implementations are retained. Argo continues tracking main with autosync, prune and selfHeal. The wrapper checks the currently resolved main revision and all selected chart dependencies at deployment time, and stops if main moves during preflight. Future upstream changes still require acceptance; tracking a moving branch cannot provide a permanently frozen release guarantee.

Existing 12.0.9 fixes remain: uploaded kubeconfig/context enforcement; bounded API transport recovery and lease checks; registry Bearer-challenge handling; policy/verification compatibility values; OpenBao readiness/mount handling; Grafana datasource correction; Argo Redis mirror and dependency/chart preflight.

## Provider detection and persistent networking

IONOS and Hetzner are selectable. Detection checks recognized node provider IDs, provider-specific node labels and, when node evidence is absent, CSI provisioners. It reports regions, zones and detection evidence. Mixed provider evidence uses generic behavior and requires explicit configuration where necessary. DNS hosting remains independent of compute-provider detection.

Hetzner annotations are generated only for Hetzner. Location/network zone comes from explicit settings or recognized node topology. Private networking is opt-in and requires an existing private network; LB type is not forced to lb11. Unknown topology requires an explicit location/zone. User annotations are preserved; foreign Hetzner annotations on IONOS are rejected.

The exact current Envoy template omits externalTrafficPolicy. The wrapper therefore uses both:

- Helm values **strings** in ApplicationSet templatePatch, preserving null deletions through ApplicationSet merge-patching. Default annotation keys are read from the currently validated upstream values, then replaced with resolved provider/user annotations. The same representation also preserves the OCM policy NAMESPACE deletion.
- A Helm-managed, narrowly scoped Kyverno ClusterPolicy for `infrastructure/envoy`. It sets the configured traffic policy on CREATE/UPDATE. On a fresh bootstrap it is installed after Envoy CRDs exist and before tenant/certificate creation. Existing proxies and generated public Services are reconciled explicitly. Recreated proxies are covered by admission. The Envoy Application preserves this field with RespectIgnoreDifferences; all existing sync options and other override branches remain.

IONOS requires Cluster. Generic/provider-neutral deployment defaults to Cluster. Local is an explicit option for a deliberately designed topology on other providers. Proxy Services are discovered using Envoy ownership labels; observed Service hashes, IPs and NodePorts are not deployment constants. Validation checks proxy and public-Service policies, foreign annotations, TCP 80/443, admission policy readiness, the tenant certificate and public issuer/DID/JWKS endpoints.

## Recovered OCM-CR runtime

The runtime uses the existing tenant host and Gateway ListenerSet, adding only `/orce` and the more specific `/orce/identity` path. Native OCM routes are not rewritten. The UI retains the FAP DCM/FACIS layout and logo, English/German/French labels, credentials/detail/verification/status views, issuance/receive flows, relationship adapters, provenance views, Clearing House adapter, role management, audit, encrypted operation offers and idempotency.

The current upstream stack does not deploy the legacy Keycloak assumed by 11.x. The runtime chart adds its own Keycloak and PostgreSQL under OCM's namespace, with a PVC for identity data. These support UI authentication; they do not replace any OCM service. Keycloak uses a tenant-specific realm, Authorization Code + PKCE, atomic permissions and a scoped backend service account. The editor uses a separate bcrypt administrator. Initial credentials and encryption keys are created once, retained across upgrades, and never placed in ordinary Helm values.

ORCE, MongoDB and identity PVCs are retained. MongoDB contains UI preferences, audit and operation coordination, not copies of the OCM credential store. Embedded MongoDB is the default; an external URI is stored in encrypted node credentials. Changing an existing MongoDB topology is refused, requiring a separate data migration. Runtime dependency installation occurs in the init container; registry access is required. Existing flows and data are preserved.

Runtime connections use the configured tenant, the current `/api/credential` endpoint and NATS in `infrastructure`. Native Service names and exposed ports are discovered before installation. The runtime reads the upstream-managed issuer registration instead of silently registering a competing tenant. Missing optional backend Services are reported explicitly.

PCM support from 11.1.0 is retained **opt-in**, using its existing issuer/client and Account Service. The deployer does not install or modify PCM. Set PCM configuration JSON with enabled, issuer, userInfo, accountUrl, clientId, realm, tenant, namespace and cryptoNamespace after configuring that existing client's `/orce/pcm/callback` redirect. See docs/PCM-INTEGRATION.md for the inherited adapter constraints; its legacy host/Keycloak deployment examples are historical.

## Acceptance boundaries

The current OCM ApplicationSet excludes Didcomm; relationship adapters require a deployed supported service or an explicit runtimeServices override. Storage had a documented upstream Region/Country route-middleware mismatch; no service binary is patched or replaced here. Production credential templates, real Clearing House issuance, native graph lineage, some lifecycle/connection event contracts, two-instance journeys and cross-browser acceptance remain in the coverage record.

`ready` requires infrastructure/PVC/pod readiness, correct gateway configuration, verified tenant TLS/native metadata, and public UI readiness/auth/issuer checks when enabled. It still reports `credentialLifecycle: "not-tested"`. Only the separate native credential test proves Retrieval acceptance and exact Storage read-back. UI or DID publication alone is insufficient.

## Actions and CLI

| Action | Purpose |
| --- | --- |
| preflight | Validate source, dependencies, selected Helm charts and policy image before writes |
| deploy | Fresh/resumable official bootstrap, tenant and runtime |
| repair-network | Reconcile network ApplicationSet and persistent gateway compatibility |
| install-ui | Provision the runtime on a matching existing version-12 installation |
| repair-ocm | Retain shared infrastructure, repair OCM compatibility and continue tenant/runtime setup |
| inspect / validate | Inspect resources; validate also checks verified public HTTP endpoints |
| diagnose-api / diagnose-auth | Read-only connectivity or uploaded-identity diagnostics |
| test-credentials | Native credential journey; requires CREATE TEST CREDENTIAL confirmation |
| teardown | Remove only the tenant Helm release; requires REMOVE TENANT <release> confirmation |

CLI example, with passwords/URI kept in a private JSON file:

```bash
node scripts/cli.js preflight --config deployment.json --kubeconfig cluster.yaml \
  --runtime-credentials-file runtime-credentials.json
node scripts/cli.js deploy --config deployment.json --kubeconfig cluster.yaml \
  --runtime-credentials-file runtime-credentials.json
```

Runtime credentials JSON keys: editorPassword, uiAdminPassword, mongoUri (external Mongo only). DNS credentials use the existing dns-token-file/dns-secret-file options. Required runtime tools: Node.js >=18.17, Helm 3, kubectl, git, bash, jq, curl and base64. All deployment calls use the uploaded kubeconfig, never the ORCE ServiceAccount identity.

## Source integration and checks

The source archive contains `Easy Stack Builder (ESB)/OCM-WStack`, preserving the established integration directory. It contains tests, exact reviewed adaptation fixtures, current runtime source and chart source. The installable TGZ excludes development tests. No node_modules or compiled service/tool executables are distributed. The chart's nested runtime.tgz contains source and the supplied FACIS logo only.

```bash
npm install --ignore-scripts
npm test
npm run test:helm       # Helm 3 + Python/PyYAML
npm run test:ui         # Real Vue + jsdom DOM interactions
npm pack --dry-run --ignore-scripts
```

 The validation record distinguishes checks actually executed here from runnable acceptance checks that remain pending.
