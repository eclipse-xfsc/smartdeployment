# OCM W-Stack ESB 12.0.1

This release implements the approved first phase: a fresh ESB deployer that executes the official XFSC bootstrap, installs the official tenant, and validates native OCM endpoints. The CR application UI and PCM integration belong to the next phase.

## Official source and execution

Repository: [eclipse-xfsc/deployment](https://github.com/eclipse-xfsc/deployment). The reviewed bootstrap source is commit [739606691ecff72b3a40404a19fce44d9c22b0ee](https://github.com/eclipse-xfsc/deployment/tree/739606691ecff72b3a40404a19fce44d9c22b0ee), dated 29 September 2026.

The wrapper fetches that checkout at deployment time and executes `bash ocm-wstack-init.sh` from its root. This script already calls `./basic-cluster-init.sh`; ESB must not run basic a second time. The official procedure deploys observability, OpenBao, External Secrets, Kyverno, Argo CD, the namespace provisioning chart, the Kubernetes operator, and the storage/network/core ApplicationSets before the OCM ApplicationSet. ESB then installs `XFSC/tenant/chart` with `XFSC/tenant/values/tenant-ocm-wstack-values.yaml`, using release `demotenant` and tenant `demo-tenant` by default.

`INFRA/` and `XFSC/` are used directly from that checkout. Argo CD's generated Applications still fetch the official repository's **main** branch and keep **autosync, prune and selfHeal enabled**, as requested. Freezing the reviewed shell bootstrap does not freeze the services managed by Argo. The actual Argo revisions, running image tags and image digests are reported by inspection.

No service image is rebuilt, patched or bundled. Both distribution archives contain source text only. The upstream scripts and charts download their normal dependencies when you deploy.

## Updating from 12.0.0

Version 12.0.1 fixes the rejected Kubernetes Lease timestamp. Install the new TGZ, restart ORCE, and trigger the existing node again. Keep `procedureVersion: 12`, the uploaded credentials and all node settings. For the reported Lease creation rejection, no bootstrap resources were installed and no cluster cleanup is needed.

## Installation in ORCE

Use a fresh target cluster and the configured `ecofacis/xfsc-orce:2.0.15` runtime. This package retains npm name `orce-esb-ocmwstack` and node type `OCM-W-Stack`, but requires a newly configured version-12 node. It does not migrate an existing 11.x deployment.

Install `orce-esb-ocmwstack-12.0.1.tgz` through the Node-RED palette upload facility if enabled. Alternatively, run the following **inside ORCE's configured Node-RED user directory**, with the archive available in that container, then restart ORCE:

```bash
npm install --omit=dev /path/to/orce-esb-ocmwstack-12.0.1.tgz
```

For source integration, replace the complete old `Easy Stack Builder (ESB)/OCM-WStack` directory with the directory in the source archive. Do not merge its old deployment scripts into this release.

The ORCE process needs Node.js 18.17 or newer, **Helm 3**, kubectl, git, bash, jq, curl and base64. No tool installers or compiled executables are bundled. Check the runtime from the installed package directory:

```bash
node scripts/cli.js check
```

The runtime must reach the Kubernetes API, GitHub, upstream Helm/OCI registries and the public tenant endpoint. Cluster nodes need access to the upstream container registries. Use a cluster-admin kubeconfig with embedded certificate data; paths to files on your laptop will not exist inside ORCE. Exec-based cloud kubeconfigs require their authentication CLI and credentials in ORCE as well.

## Configure the node

1. Enter an instance name, base domain and certificate contact email. Upload the kubeconfig with the file field. Kubeconfig and DNS credentials are held in Node-RED's credentials store; configure the runtime's credential encryption as usual.
2. Leave provider and StorageClass on automatic detection unless you need an override. An absent or ambiguous default StorageClass stops deployment before installation.
3. Choose whether ESB should manage DNS. Enabling the toggle reveals the DNS provider and credential fields. Disabling it leaves DNS records under your control.
4. Keep the intended defaults `demo-tenant` and `demotenant`, or enter a tenant ID/subdomain. For base domain `example.com`, the default public endpoint is **https://demo-tenant.example.com**. A custom tenant ID also updates its group and OpenBao transit path consistently.
5. Wire an Inject node into this node, and Debug nodes to both outputs. Output 1 is the final result; output 2 is progress. Set the Inject property `msg.action` to `deploy` and trigger it. Deployment is never started just by loading the flow.

You can import `examples/node-red-flow.json` for prewired Deploy, Validate and Test credential buttons. Enter the domain/email and upload kubeconfig before triggering them.

| Action | Behavior |
| --- | --- |
| `deploy` | Install the official stack and tenant, or resume the same installation configuration. |
| `inspect` | Read Argo, images/digests, pods, PVC and gateway/certificate state. |
| `validate` | Inspect the cluster and check public issuer metadata, DID and JWKS over verified HTTPS. |
| `test-credentials` | Create an Ada Lovelace SD-JWT offer, submit it to Retrieval, list and accept it, then prove exact credential read-back from Storage. Requires `msg.confirm = "CREATE TEST CREDENTIAL"`. |
| `teardown` | Remove only the tenant Helm release. Requires `msg.confirm = "REMOVE TENANT demotenant"`, substituting the configured release name. |

Removing/redeploying the ESB node cancels its local running process and retains the cluster resources. Tenant teardown also retains OCM services, Argo CD, shared infrastructure, stored credentials, OpenBao keys and signer registration. Full cluster deprovisioning remains a separate operator action.

## Provider compatibility and DNS

The wrapper uses standard Kubernetes APIs, a provisioned StorageClass and a `LoadBalancer` service. Provider IDs are recognized for Hetzner, AWS, Azure, Google Cloud, OpenStack, DigitalOcean, Oracle Cloud, Scaleway and Alibaba Cloud. Unknown or mixed provider IDs use generic Kubernetes behavior. Recognition is not a claim that every provider has been tested.

The upstream Envoy defaults contain Hetzner annotations. ESB retains them on Hetzner and removes them on other providers, then applies the optional load-balancer annotation map. The values are passed through the **ApplicationSet**, so Argo reconciles them. Editing a local copy of Envoy's chart would not affect Argo's remote source; the wrapper avoids that mistake.

A provider's cloud controller, load-balancer implementation and storage provisioner must already work. Bare-metal clusters need an existing implementation such as the operator's chosen MetalLB/Cilium setup. ESB cannot infer an address pool, cloud IAM permissions, private-network topology or provider-specific capacity. The official stack includes Cassandra, observability and security components; size the cluster from the upstream charts' resource and PVC requests. A pending LoadBalancer/PVC is reported rather than treated as success.

DNS hosting is independent of the cluster provider. Automatic DNS selection uses the upstream Hetzner profile only when the cluster is identified as Hetzner. If your zone is hosted elsewhere, explicitly select its provider. IONOS uses the upstream `ionos` profile. Both profiles expect their API credential under key `token` in Secret `infrastructure/external-dns`.

Other providers use **Other ExternalDNS provider**. Enter the subchart's values object in the visible JSON field. For example, a Cloudflare token reference is:

```json
{
  "provider": {"name": "cloudflare"},
  "env": [{
    "name": "CF_API_TOKEN",
    "valueFrom": {"secretKeyRef": {"name": "external-dns", "key": "token"}}
  }]
}
```

In the separate encrypted DNS Secret JSON field enter `{"token":"your-api-token"}`. This follows the [official ExternalDNS Cloudflare configuration](https://github.com/kubernetes-sigs/external-dns/blob/master/docs/tutorials/cloudflare.md). Keep actual secrets out of ordinary Helm values. Workload-identity providers can use their provider/serviceAccount settings and leave Secret JSON empty. The official domain filter remains the configured base domain. The upstream ExternalDNS policy remains `sync`, including record deletion within its managed ownership scope. ESB permits A, AAAA and CNAME records so IPv6 addresses and provider load-balancer hostnames can work; custom DNS values may override `extraArgs` explicitly.

With DNS management disabled, progress emits the tenant hostname and gateway addresses as soon as they appear. Create an A/AAAA record for an IP, or a CNAME for a load-balancer hostname. Public ports 80 and 443 must reach Envoy: the official certificate issuer uses ACME HTTP-01. Allow DNS/certificate propagation, then run `validate` again.

## CLI deployment and acceptance

The same implementation can be run from the extracted source directory. Copy `examples/deployment.json` to a private configuration file and edit at least its domain and email. Keep credentials in separate files.

```bash
umask 077
node scripts/cli.js check
node scripts/cli.js deploy \
  --config deployment.json --kubeconfig cluster.yaml \
  > deployment-result.json 2> deployment-progress.jsonl

# After DNS and certificate issuance:
node scripts/cli.js validate \
  --config deployment.json --kubeconfig cluster.yaml \
  > validation-result.json 2> validation-progress.jsonl

# Creates and retains test data under a unique esb-check-* account:
node scripts/cli.js test-credentials \
  --config deployment.json --kubeconfig cluster.yaml \
  --confirm "CREATE TEST CREDENTIAL" \
  > native-result.json 2> native-progress.jsonl
```

For managed DNS add `--dns-token-file token.txt` or `--dns-secret-file dns-secrets.json` to the commands. The native test automatically opens localhost-only kubectl port-forwards to Retrieval and Storage, and closes them afterward. Issuance uses the tenant's public endpoint. It does not pre-consume the offer's authorization code, copy a credential directly into Cassandra, or alter services to force a pass.

The original upstream `OCM W-Stack/Tools/scripts/issuance-test-sdjwt.sh` remains available in the deployment repository. It is interactive and writes a QR image when you run it. The current reviewed repository has no `retrieval-test.sh` or `retrieval-acceptance.sh`; this package's native test follows the current service REST contract instead.

### What a result proves

`ready` from deploy/validate means the expected ApplicationSets are synced/healthy, managed pods and PVCs are ready, the tenant certificate is ready, and issuer/DID/JWKS response fields match the tenant. It explicitly records `credentialLifecycle: "not-tested"`.

Only the separate credential test can report `status: "passed"` and `credentialLifecycle: "retrieved-and-read-back"`. A Retrieval 200 response is insufficient: the returned credential must be found through the Storage API. If Storage still returns `Region Id Missing.`, the report records the 400, while preserving the separate retrieval stage results. Reports contain HTTP statuses and correlation identifiers, not offer URIs, access tokens or credential contents.

**Storage still requires live verification.** The current [Storage middleware](https://github.com/eclipse-xfsc/credential-storage-service/blob/567201e524967d5b9c0798a866f5fb587e912017/internal/middleware/authModelMiddleware.go) reads region and country from route parameters, while its [microservice-core-go v1.1.2 router](https://github.com/eclipse-xfsc/microservice-core-go/blob/v1.1.2/pkg/server/server.go) defines the tenant base route. Those sources do not prove what the published image will do. ESB leaves the upstream image/configuration intact and records the deployed behavior; it does not claim that the earlier 400 is fixed before this test passes.

Collect additional read-only evidence with the included script:

```bash
KUBECONFIG="$PWD/cluster.yaml" bash scripts/collect-evidence.sh evidence
# Optional service logs; these can contain private request data:
KUBECONFIG="$PWD/cluster.yaml" bash scripts/collect-evidence.sh evidence-with-logs --include-logs
```

Keep `native-result.json`, `validation-result.json` and the evidence directory together. For a bootstrap failure, the progress output names the last phase; inspect the affected Helm release or Argo Application before retrying.

## Minimal local adaptations

`upstream-lock.json` verifies all adapted files before any installation. `lib/adapt.js` applies these changes to a temporary checkout:

- Add fail-fast shell behavior and phase progress. Use idempotent namespace creation and `helm upgrade --install` for this instance's interrupted runs, with bounded timeouts and prerequisite controller rollout waits.
- Use the preflight-selected StorageClass instead of assuming one unambiguous default.
- Read DNS Secret data from a private manifest rather than command-line token arguments. Suppress the Argo initial-password read/print while preserving its existence check.
- Allow a network-only ApplicationSet template patch for provider annotations/custom ExternalDNS values and A/AAAA/CNAME support. Preserve official service charts, routes, exclusions and Argo tracking/sync policy.
- Add `curl --fail-with-body` to the tenant registration hook so an HTTP error fails Helm installation instead of printing registration success.

The bootstrap commit is reviewed and fixed for this release; updating it requires reviewing the adaptations, updating the lock hashes and rerunning the tests. Argo continues following main independently. Only one operation owns the cluster lease at a time. Matching configuration may resume; changing topology/tenant/domain or adopting an existing installation is outside this fresh-deployment release. Do not delete Helm release records to clear a pending operation without first checking whether its process is still active.

## Development checks

```bash
npm install --ignore-scripts
npm test
# Requires Helm 3 and Python with PyYAML:
npm run test:helm
npm pack --dry-run --ignore-scripts
```

Tests execute the adapted official shell procedure against explicit kubectl/Helm test doubles; they verify ordering, failure propagation, exact-configuration resume, credential handling, editor behavior and removal behavior. Offline Helm tests render the real ApplicationSet, EnvoyProxy and tenant templates. Native HTTP tests include a real local HTTP server and failing Storage/acceptance responses. These checks do not substitute for a fresh-cluster deployment of the upstream images.
