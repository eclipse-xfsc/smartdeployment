# OCM W-Stack ESB 12.3.13

Version 12.3.13 discovers the Kubernetes API Service and backend addresses/ports for the guard's egress policy. Guard HTTP errors include safe connection details and a complete request deadline. The Grafana PVC/startup repair is retained. The separate DNS test/wait step remains removed. It retains persistent Redis credential reconciliation, consumer reloads after Secret rotation, Well-Known NATS startup recovery, and completion checks for the bridge and its required NATS listeners. It retains the 12.3.9 authorization recovery and earlier native integration. See docs/REPAIR-12.3.13.md and VALIDATION.md.

## Install and configure

Install `orce-esb-ocmwstack-12.3.13.tgz` in your deployer ORCE/Node-RED user directory, then restart that runtime. The deployer may run outside the target cluster; it uses the uploaded kubeconfig explicitly. It requires Node.js 18.17+, Bash, Git, Helm 3 or 4, kubectl, jq, curl and base64. The target cluster must already provide a working public LoadBalancer and a default persistent StorageClass. Bootstrap is for a fresh cluster or an installation with this deployer's matching ownership marker.

```sh
npm install --omit=dev /path/to/orce-esb-ocmwstack-12.3.13.tgz
```

Import `examples/node-red-flow.json`, or connect an Inject node to **OCM-W-Stack** and its two outputs to Debug nodes. Configure these three tabs once:

1. **Cluster:** upload a self-contained cluster-admin kubeconfig. Choose whether the deployer manages DNS and whether Argo CD/Grafana should be public. If DNS automation is enabled, provide credentials for the account hosting the domain.
2. **Domain & certificate:** base domain (`example.com` or `*.example.com`), tenant name (`demo-tenant`), public-trusted PEM fullchain certificate and matching unencrypted PEM private key. A `*.example.com` certificate covers `demo-tenant.example.com`, `argocd.example.com` and `grafana.example.com`.
3. **Access:** initial OCM context administrator and editor administrator passwords, each at least 12 characters. These are separate accounts. Their stored credentials and existing roles are retained on reruns. The OCM context requires a password change at first login.

Provider, StorageClass, image, PVC sizes and timeout overrides are under Advanced. ORCE defaults to `ecofacis/xfsc-orce:2.0.15`; `2.0.13` is selectable. There are no PCM, ACME, internal-routing, service endpoint or annotation JSON fields in the normal deployment flow.

Trigger **Deploy**. Output 2 reports the current phase, provider/topology, DNS targets and readiness; output 1 returns the result. A failed operation retains cluster data. Correct configuration and trigger Deploy again to reconcile the same installation. Do not create a different tenant to recover the existing one.

## Upgrade and dashboard recovery

Install 12.3.13, restart the deployer ORCE/Node-RED process, and run Deploy with the existing configuration to resume or upgrade the matching installation. No re-acceptance or cleanup is needed for the package upgrade. Retest LDP and SD-JWT acceptance and Verify after native services are ready. Well-Known subscription startup recovery is included; this does not claim to repair unrelated metadata/database bugs. See docs/REPAIR-12.3.8.md and VALIDATION.md.

Organizational Storage requests now use `/v1/tenants/<tenant>/storage/<region>/<country>/<account>/credentials`, as registered by the published 1.2.5 source. Region/country follow the installed Retrieval deployment (upstream defaults EU/DE). If a region/country error remains during final validation, output 2 emits `storage-diagnostics` automatically. A standalone read-only diagnostic is also available from this source directory:

```sh
node scripts/diagnose-storage.js --kubeconfig /path/to/cluster.yaml
```

It records image identities and native HTTP status/routes without displaying stored credentials or secrets. The POST it performs is the native credential filter/read operation, not an import.

## Issuance and Relationships repair

The OCM context API parses JSON request bodies once, before ORCE's HTTP-in JSON/raw parser chain, with a 1 MiB limit and JSON error responses. Existing persisted flows are retained. The browser displays HTTP status and request ID for invalid/non-JSON responses and retains the original idempotency key after uncertain failures. Deploy tests unauthenticated POST, PATCH and DELETE requests: each must reach the OCM context's JSON authentication boundary, without creating credentials or changing data. GET readiness alone is insufficient.

Relationships uses the official native DIDComm service and its persistent Cassandra database. Argo manages its chart from deployment main, with only the required configuration overrides. The native service runs its own schema migration. A startup probe allows migration to finish before liveness checks. Only POST `/api/didcomm/message/receive` is exposed publicly; `/admin` operations stay behind the OCM context's authenticated, scoped API. Existing externally configured DIDComm services remain operator-owned. See `docs/REPAIR-12.3.3.md` for the earlier DIDComm evidence and limits.

## DNS and internet access

With **Manage DNS records** enabled, ExternalDNS maintains tenant and optional dashboard records. Hetzner and IONOS are supported explicitly, with topology-based provider detection. The DNS host may differ from the cluster provider: select the actual DNS provider in that case. IONOS uses the official `external-dns-ionos-webhook:v0.14.0`; Hetzner uses its official webhook `v0.3.4`. Existing ExternalDNS TXT ownership is retained across this upgrade.

With the toggle disabled, set the tenant's A/AAAA records to the gateway targets shown in progress. If public dashboards are enabled, set `argocd.<domain>` and `grafana.<domain>` too; a matching wildcard DNS record can cover all three. Remove stale A or AAAA targets. If the cloud assigns an address only during bootstrap, manual DNS mode necessarily needs that one DNS update after the address appears. DNS automation is the mode intended for unattended provisioning after configuration.

The deployer does not run a separate DNS test or wait gate. After tenant, UI and dashboard installation, it proceeds directly to native HTTPS validation using normal system DNS and certificate verification. DNS records must still resolve correctly for those HTTPS requests to succeed. Public TCP 443 must reach the cluster's LoadBalancer; port 80 provides the tenant HTTPS redirect. It cannot reconfigure an unrelated upstream firewall without its credentials. This package does not claim to provision a Kubernetes cluster or cloud account from scratch.

The uploaded fullchain is installed as an owned Kubernetes TLS Secret. No Let's Encrypt account, Order, Challenge, ACME email, cert-manager self-check or certificate issuance wait is involved. Replace the two certificate uploads and rerun Deploy to renew. Cert-manager can remain installed for other upstream infrastructure.

The tenant hostname is mapped to the **discovered Envoy Service ClusterIP** inside the OCM context and native tenant workloads. This preserves the hostname, SNI and certificate verification while avoiding public-IP hairpin failures. A Kyverno admission policy covers new pods; reconciliation updates existing Deployments/StatefulSets. Addresses, Service hashes and NodePorts from earlier incidents are never deployment constants.

## What is deployed

The reviewed official bootstrap installs observability, OpenBao, ESO, Kyverno, the XFSC operator, Argo CD and the Storage, Network, Core and OCM ApplicationSets. Then the deployer installs tenant keys/registration/routing, uploaded TLS, the persistent ORCE OCM UI runtime, UI identity, and optional dashboard routes.

Native OCM service implementations are not forked or replaced. Compatibility changes are Helm/bootstrap configuration: provider annotations, traffic policy, chart/environment corrections, namespace/key preparation and internal routing. Storage and DIDComm remain the credential and relationship authorities. MongoDB stores UI preferences, connection settings, credential-type definitions, audit metadata, idempotency records and encrypted temporary offer results; it is not a substitute OCM context database.

| URL | Purpose |
|---|---|
| `https://demo-tenant.example.com/` | Redirect to OCM context |
| `https://demo-tenant.example.com/orce/` | OCM W-Stack UI |
| `https://demo-tenant.example.com/orce/editor/` | Authenticated ORCE editor |
| `https://demo-tenant.example.com/.well-known/did.json` | Native tenant DID |
| `https://demo-tenant.example.com/.well-known/openid-credential-issuer` | Native issuer metadata |
| `https://argocd.example.com/` | Optional authenticated Argo CD |
| `https://grafana.example.com/` | Optional authenticated Grafana |

Optional dashboards initially use username `admin` and the configured initial editor password. Initialization is recorded and reruns do not reset changed passwords. Switching the public-dashboard toggle off removes only its routing release; it retains services, certificates and data. Fresh Grafana deployments use a PVC; upgrades retain the existing observability release and storage topology.

## Upstream tracking

Argo CD's storage, network, core and OCM Git ApplicationSets follow `main`, including their directory generators and generated Applications. Automated synchronization remains enabled. Future main changes therefore reconcile automatically as requested. The corrected direct ExternalDNS Helm chart remains versioned; it is not a Git source.

Bootstrap shell adaptations use reviewed commit `5d09c7f1012d1e9bb792fda226da478ffcca27a0` with byte checks. All guarded adaptation files are unchanged from the preceding bootstrap lock. On every Deploy, chart preflight separately fetches current main and records the exact commit rendered. ApplicationSets explicitly receive the branch `main`, including when an upstream default names another branch. Planning and installation use the same current-main values. A later upstream commit may arrive after preflight; future automatic syncs are not covered by that earlier render.

The Argo CD installation manifest and bootstrap observability dependency versions remain listed in `upstream-lock.json`. Completed bootstrap releases are retained during an upgrade. No source push or native service rebuild is performed.

## OCM context and PCM

The retained 12.3.0 UI work adds the supplied SVG branding, credential-type CRUD, dedicated Users/Roles/Permissions panels, audit actor identity, visible PCM test results and post-import lifecycle checks. See `docs/BACKLOG-12.3.0.md` for its historical scope; this release retains that work and the confirmed Storage fix.

The OCM context retains the FACIS branding, navigation, credential cards/detail dialog and EN/DE/FR controls from 11.1.0. It includes native credential browsing, verification, local deletion, supported issuer revocation, offers, issuance, relationships, roles/assignments, audit, health, provenance and **Connections**.

An administrator configures an existing PCM in **OCM context → Connections**. The deployer neither installs PCM nor requests PCM parameters. PCM users sign in separately with PKCE. Organizational tokens are not forwarded to PCM; personal tokens stay in browser memory and are never stored in the settings/audit database. See `docs/PCM-INTEGRATION.md` for the remote client registration and capability-dependent native endpoints.

Clearing Houses are discovered from Gaia-X's published compliance registry through its Wizard API; lab and production entries are distinguished. Production onboarding, issuer policy and legal credentials are not generated by the deployer. See `docs/CLEARING-HOUSES.md`.

## Native acceptance limitation

The reviewed deployment uses Storage 1.3.0. The adapter, native test action and diagnostics use its geography-aware route, retaining `/v1/tenants/`. Listing/import/delete and lifecycle read-back share the same path builder. External PCM Account Service integration retains its separate contract. The new Retrieval source supports LDP and SD-JWT through Signer; validate the selected images through the native credential lifecycle.

The user confirmed Storage listing now works. This does not establish that every issuance, acceptance, verification and revocation path has passed live acceptance.

The deployer checks native Storage, Retrieval, issuer bootstrap, DIDComm relationship listing and NATS health and reports `action-required` if they fail. A native HTTP 400 is surfaced promptly instead of silently waiting or returning an empty OCM context. UI availability, internet connectivity and credential lifecycle acceptance are separate results. No Storage fork, database bypass or fake successful lifecycle was added.

The four requested business credential types depend on real issuer plugins/policies supplied by the repository or an authorized issuer. The registry supports creating and editing local type definitions and linking them to available native issuer configurations. A registry definition alone does not install an issuer plugin or authorize production issuance; demo Developer/SDJWT templates remain explicitly labeled. A second-instance exchange, real production Clearing House issuance, and complete live OCM/PCM lifecycle acceptance remain outstanding. See `docs/CR-COVERAGE.md` and `VALIDATION.md`.

## CLI and checks

A CLI uses the same implementation and file-based secret inputs:

```sh
node scripts/cli.js deploy --config examples/deployment.json \
  --kubeconfig /private/cluster.yaml \
  --tls-cert-file /private/fullchain.pem --tls-key-file /private/privkey.pem \
  --runtime-credentials-file /private/runtime-credentials.json
```

Add `--dns-token-file /private/dns-token.txt` when using automatic DNS. A custom provider uses `dnsProvider: "custom"`, standard ExternalDNS values in `dnsValues`, and `--dns-secret-file` containing Secret key/value JSON. For example, `{"provider":{"name":"cloudflare"},"env":[{"name":"CF_API_TOKEN","valueFrom":{"secretKeyRef":{"name":"external-dns","key":"api-token"}}}]}` with a private Secret file containing the corresponding `api-token`. The provider is still rendered before installation.

`preflight` validates without deploying. `inspect` and `validate` are read-only. `diagnose-api` and `diagnose-auth` verify the uploaded API path/identity. `test-credentials --confirm "CREATE TEST CREDENTIAL"` creates and accepts a test offering and checks native Storage read-back; it retains that test data. `scripts/collect-evidence.sh` exports status/digests without Secret contents. No tests run against your cluster merely by installing the package.

Explicit `teardown` requires `REMOVE TENANT <release>` and removes tenant routing only. Node deletion cancels local processes and retains cluster data. Core services, PVCs, key material, users and roles are not deleted by the normal deployment or dashboard toggles.

## Kubernetes access checks (retained from 12.3.7)

The uploaded kubeconfig determines the identity for the deployer and every helper. The account name “cluster-admin” alone does not prove its permissions. Preflight submits exact SelfSubjectAccessReview requests for cluster-wide access in all API groups and for Argo resources in argocd, without requiring those CRDs to be installed. Argo bootstrap and ApplicationSet readiness also recheck that the identity is unchanged and the permissions remain allowed.

ESB does not add a role binding to its own identity. If the API denies the uploaded identity, upload a kubeconfig with actual cluster-admin permissions. A failed preflight makes no installation changes. Resume a matching partial installation with Deploy; existing Helm releases and data are retained.
