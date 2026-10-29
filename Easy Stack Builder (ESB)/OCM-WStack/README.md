# OCM W-Stack 12.6.3

A configurable Node-RED deployment node installs the XFSC OCM W-Stack services and a dedicated ORCE instance that hosts their wallet backend and UI.

## Two ORCE instances

1. **Deployer ORCE:** install this package on an existing ORCE instance. Configure the `OCM-W-Stack` node in its editor and trigger it with an Inject node.
2. **Wallet ORCE:** the deployment scripts install another ORCE alongside the OCM W-Stack services in the tenant namespace, plus MongoDB for UI state. The chart injects `flows.json` and the uibuilder UI into that ORCE. This instance serves the wallet and communicates with the native OCM services.

The deployer node does not host the wallet backend. The native OCM services remain the credential/connection system of record; MongoDB holds UI state, accounts, sessions and audit data.

## Install the deployer node

Upload `orce-esb-ocmwstack-12.6.3.tgz` through the existing ORCE editor's palette upload facility, or install it from the ORCE user directory:

```bash
# Run inside the host/container that runs the deployer ORCE.
cd /data
npm install /absolute/path/orce-esb-ocmwstack-12.6.3.tgz
```

`/data` is the usual container user directory; use the actual Node-RED user directory if different. Restart ORCE after command-line installation. Existing nodes retain the type `OCM-W-Stack`, configuration properties, credential fields and output order.

Add the **OCM W-Stack** node from **Easy Stack Builder**. In its editor, supply the target kubeconfig, base domain, tenant, TLS fullchain and private key, and initial wallet/editor administrator credentials. Choose provider, storage and DNS options as needed. Credentials use Node-RED's credential store. Initial passwords require at least 12 characters and at most 72 UTF-8 bytes, without control characters. Existing application accounts and encryption keys are retained on subsequent deployments.

Connect an Inject node to its input. The default action is `deploy`; set `msg.action` for another action. Configuration and credentials come from the configured node, not incoming message fields.

| Output | Content |
| --- | --- |
| 1 | JSON result, status and public access/DNS details |
| 2 | Progress events and heartbeat updates |
| 3 | Complete raw deployment log and its private local filename |

Full logs can contain credentials and Kubernetes Secret data. Keep them private. Closing the node cancels its local process group; teardown is a separate, explicitly confirmed action. Interrupted runs retain logs and cluster resources for reconciliation on the next trigger.

The deployer host/container needs Bash, Node.js, npm, jq, curl, Git, Helm, kubectl, OpenSSL, coreutils, setsid, nc and busybox, with network access to the cluster and required registries/repositories. Installing the npm node does not install these system tools. The package requires Node.js 18.17+ and Node-RED 3+. The deployed wallet runtime requires Node.js 20.19+ or 22.12+ and defaults to `ecofacis/xfsc-orce:2.0.15`.

## Source and packaging

- `ocmwstack.js`, `ocmwstack.html`, `package.json`: deployer runtime, editor and npm registration.
- `deploy.sh`, `deployment/`: Bash deployment, diagnostics, recovery and required configuration templates.
- `charts-runtime/files/flows.json`: wallet HTTP routes, authentication, service adapters and uibuilder node.
- `charts-runtime/files/ui/`: `index.html`, `index.js`, `index.css`, `facis-logo.svg`.
- `charts-runtime`, `charts-gateway`, `charts-dashboards`, `upstream-lock.json`: deployment resources and pinned upstream source/checksums.
- `pack.sh`: produces the palette-installable archive with all required deployment and runtime assets.

Build from this directory, writing the archive outside the source tree:

```bash
bash pack.sh /absolute/path/releases
```

The package has no `.cjs` files, custom wallet backend module, Docker build or Vue compilation step. It uses the installed Vue runtime through `/orce/vendor/vue.js`; editable UI code is in `index.js`. Third-party dependency internals are not project source files.

The runtime chart's initialization container installs the flow at `/data/flows.json` and UI assets at `/data/uibuilder/orce/src/`, and generates the required Node-RED settings and uibuilder socket middleware hook. Runtime dependencies are installed with npm. Prepared releases are published through `/data/current`; existing MongoDB/PVC data and retained Secrets are preserved. The installer refuses an independently managed flow volume.

## Command-line deployment

For CLI use from the source directory, first install the deployer's dependency with `npm install --omit=dev --ignore-scripts --no-audit --no-fund`. Use the existing private deployment configuration, kubeconfig and TLS files:

```bash
bash deploy.sh check
bash deploy.sh preflight --config /private/deployment.json \
  --kubeconfig /private/cluster.yaml \
  --runtime-credentials-file /private/credentials.json \
  --tls-cert-file /private/fullchain.pem --tls-key-file /private/key.pem
bash deploy.sh deploy --config /private/deployment.json \
  --kubeconfig /private/cluster.yaml \
  --runtime-credentials-file /private/credentials.json \
  --tls-cert-file /private/fullchain.pem --tls-key-file /private/key.pem
```

Minimal configuration (replace domain and tenant):

```json
{
  "procedureVersion": 12,
  "domainAddress": "example.com",
  "tenantId": "demo-tenant",
  "externalDns": false,
  "publicDashboards": false,
  "provider": "auto",
  "runtimeImage": "ecofacis/xfsc-orce:2.0.15"
}
```

Private initial credentials contain `editorPassword` and `uiAdminPassword`. Do not commit credentials, kubeconfigs, certificates, exports or logs.

Other actions are `install-ui`, `repair-ocm`, `repair-network`, `inspect`, `validate`, `diagnose-auth`, `diagnose-api`, `diagnose-storage`, `test-credentials` and `teardown`. The last two require explicit confirmation (`msg.confirm` on the node or `--confirm` on the CLI). See `bash deploy.sh --help`. CLI stdout contains the JSON result; stderr carries progress.

## Wallet flows

`OCM initialization` loads the named services in dependency order and connects MongoDB and NATS. Separate tabs cover authentication, credentials, issuance, relationships, provenance and clearing. Use a full flow deploy after changing initialization functions.

The manual identity-migration Function accepts `msg.mode="prepare"`, `msg.payload={export,hashes}` and `msg.tenant`. Applying its output requires `msg.mode="apply"` and `msg.confirm="apply-identity-migration"`. Do not connect migration inputs or credential exports to public HTTP or Debug nodes.

## Validation

The deployer runtime and editor are restored from the pre-refactor implementation in the retained branch history. The editor's UI-installation wording is updated. Wallet flows/UI and native-service charts retain their current branch content. Version metadata and password hashing integration are updated for the restored npm package.

Preparation checks passed: all 46 packed files match source; offline npm installation using a locally available bcryptjs 2.4.3 archive; 17 packaged-node regression tests (including editor configuration compatibility); 123 selected backend regression tests; 11 flow/UI integration checks with test doubles; deployment regression checks and runtime seed installation simulations. Relocated fixtures were restored before rerunning affected legacy tests. Tests of removed compiled-UI/module entry points are not counted as backend validation. Seed simulations replace npm and do not establish real dependency installation or runtime readiness.

Real ORCE/uibuilder startup, browser integration, Helm rendering and Kubernetes deployment remain to be validated. npm registry access was denied in the preparation environment and Helm was unavailable. Before replacing a working deployment, validate startup/readiness, login/logout/password change, users/roles, credential list/import/issue/accept/verify/revoke/delete, relationships, provenance, clearing, socket reconnection, process restart and repeated installation.
