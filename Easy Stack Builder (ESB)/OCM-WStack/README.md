# OCM-WStack ESB 11.1.0

Source-only deployment candidate based on the approved **11.0.7** upload. Fresh deployments only. This integrates the official September Retrieval updates and the requested OCM/PCM UI work. It contains no compiled executables, OCI image archives, or upstream service patches. The uploaded FACIS logo is included as a UI asset.

**Storage 1.2.4 requires an upstream route correction.** The deployer reports `deployed: Storage blocked` for that exact defect and leaves Retrieval available for testing. Other dependency failures stop deployment. See [readiness](docs/READINESS.md), [meeting brief](docs/MEETING-BRIEF.md), and the [CR coverage matrix](docs/CR-COVERAGE.md).

## Install and deploy

1. Install `orce-esb-ocmwstack-11.1.0.tgz` using the existing ORCE/Node-RED palette upload. Alternatively, inside the existing deployer container:

   ```sh
   cd /data
   npm install /path/to/orce-esb-ocmwstack-11.1.0.tgz
   ```

2. Restart that deployer, reopen/add **OCM-W-Stack**, and enter the existing Kubernetes, domain, email and TLS inputs. The **domain is the bare parent domain**, for example `leanea.com`; the OCM context becomes `https://cloud-wallet.leanea.com/orce/`. Supply separate editor and UI administrator credentials under **ORCE Initial Credentials**. Passwords must be 12–72 bytes. The UI administrator changes its initial password on first login.
3. Use a fresh namespace. The existing shared ingress controller must already be compatible; cluster-wide management options remain opt-in. The deployer needs Node.js 18+, bash, kubectl, Helm, jq, curl and openssl; runtime dependency installation needs online registry access.
4. If using ESB PCM Cloud in the same cluster, enable **PCM Cloud**, set its namespace, Keycloak realm and OCM tenant. Defaults are `pcm`, `master`, `tenant_space`. PCM must use this installation's Keycloak server and Storage. Install PCM separately; this package does not deploy a second PCM or migrate its data. Each UI user connects with their own PCM login.
5. Configure approved external issuer/offer hosts and remote OCM hosts. Use the actual bare DNS names returned by the selected provider; the OCM context's own host is included automatically. Lab defaults are `compliance.lab.gaia-x.eu`, `registration.lab.gaia-x.eu`, and `wizard.lab.gaia-x.eu`.
6. Trigger the ESB node. It installs official service versions, bootstraps Vault/issuer/Keycloak, and seeds the UI on the approved ORCE image `ecofacis/xfsc-orce:2.0.13`. No service image is rebuilt or substituted. MongoDB defaults to its own 5Gi PVC, ORCE to 3Gi.
7. Open `https://cloud-wallet.<domain>/orce/`. The UI follows the FAP DCM navigation/card style, uses the supplied FACIS logo, and supports English, German and French.

`ready` means the deployment's native diagnostics passed; it is not CR sign-off. `degraded` with Storage HTTP 400 is the known blocked condition. The output includes `clientSecretRef`, never a plaintext client secret. Deleting the ESB node retains its original namespace-uninstall behavior; do not delete the node merely to restart it.

## Test immediately after deployment

Extract the full-source ZIP and open a terminal in `Easy Stack Builder (ESB)/OCM-WStack` on a machine with kubectl access and Node.js:

```sh
# Read-only: image digests, pod state, native responses, geography-header comparison.
node scripts/collect-meeting-evidence.cjs ocm-wstack

# Creates one DEMO SD-JWT offer, imports it and accepts it.
node scripts/retrieval-smoke.cjs ocm-wstack --accept > retrieval-smoke.json
```

The second command prints only stage metadata and request IDs. It never prints the offering link, credential or token. Exit **0** means the checks run succeeded, **2** means Retrieval passed but Storage could not be read, **1** means another failure. A Storage read count does not establish that the new credential was persisted; correlate it in the UI. Do not repeatedly rerun an interrupted mutation: first inspect pending offers.

UI alternative: **Issue credential → SDJWTCredential → enter demo names → create/copy the offer → Receive credential → Import offer → Accept**. Record the request ID. Then refresh **Local credentials**. Offer import, acceptance, and persistence are distinct steps. Use a newly issued offer once; an already-redeemed pre-authorized code is not a valid test. Read [cluster acceptance](docs/CLUSTER-ACCEPTANCE.md) for PCM, roles, relationships and cross-instance checks.

## What is included

- Official Retrieval 1.1.5, Issuance 1.9.2, Signer 2.3.5 and matching reference chart updates; unchanged official Storage 1.2.4. The Cassandra `HOSTS` compatibility alias remains explicit.
- Native Storage empty-filter request and credential-envelope fixes, exact raw import, Signer SD-JWT disclosure-frame handling, list sorting/filtering/pagination and managed status counts.
- Separate OCM and PCM identities; PCM reads through Account Service, native lifecycle actions scoped to the authenticated PCM subject, and owned holder-key selection. PCM's no-op delete/revoke handlers are not used.
- Offer import/list/accept/reject, transaction codes, issuance/QR, native credential import/download/verify/delete, owned local revocation, dynamic issuer catalog, refresh-through-new-offer, relationship administration, role/assignment management, audit and health export.
- Read-side declared provenance graph, native Retrieval event hints and polling, Gaia-X lab request adapter and provider onboarding links.

Support depends on the native service and credential format. Remote issuer revocation, arbitrary renewal, production issuer templates and business trust decisions cannot be manufactured by the UI. [PCM internals](docs/PCM-INTEGRATION.md), [API/DB architecture](docs/ARCHITECTURE.md), [Clearing Houses](docs/CLEARING-HOUSES.md), [helper-service effort report](docs/HELPER-CANDIDATES.md).

## Build and validation

```sh
npm test
npm run test:legacy
python3 test/config-regression.py
python3 scripts/build-runtime.py
helm lint 'ORCE Runtime' --set host=cloud-wallet.example.test
npm pack --ignore-scripts
# Optional real Vue DOM checks (no browser layout assertions):
cd test/ui && npm install --ignore-scripts && npm test
```

The runtime archive contains source and assets only; Helm's `binaryData` transports the compressed source. Native images and charts are downloaded at deployment. No full offline bundle is supplied. Exact local results are in `docs/validation-report.txt`.

The private runtime editor is available through `kubectl -n <namespace> port-forward service/ocm-orce 1880:80`, then `http://127.0.0.1:1880/_orce-editor/`. Keep the existing deployer editor protected by its normal administration settings.
