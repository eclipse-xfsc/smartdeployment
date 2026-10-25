# OCM W-Stack 12.4.0

The ESB node deploys the XFSC native services and the OCM W-Stack UI. ORCE routes UI requests to native credential, issuance, verification, status and relationship services. MongoDB stores UI accounts, roles, sessions, preferences and operation metadata.

## Source layout

- `ocmwstack.html`: node fields, credential uploads and help.
- `ocmwstack.js`: Node-RED registration, private input files, process cancellation and the two outputs.
- `deploy.sh`: deployment procedure and standalone command.
- `deployment/`: Bash helpers, JSON transformations, templates and the continuous native-service reconciler.
- `runtime/flows/`: domain flows; `runtime/flows.json`: generated deployment flow.
- `runtime/lib/modules/`: Auth, Credentials, ClearingCenter, Issue, Relationships and Provenance handlers.
- `ui/src/`: Vue components and EN/DE/FR catalogs.
- `runtime/uibuilder/orce/dist/`: UI runtime assets. The Vite build writes compiled assets here.
- `charts-runtime/`, `charts-gateway/`, `charts-dashboards/`: deployment charts.
- `docs/baseline/`, `docs/requirements.json`: specifications and acceptance criteria.

## Build and test

The deployment container needs Bash 5, Node.js, jq, curl, git, Helm 3 or 4, kubectl, OpenSSL and the BusyBox utilities supplied by `ecofacis/xfsc-orce:2.0.15`. Run `bash deploy.sh check` to inspect the available tools. Python 3 with PyYAML and Helm are needed on the development host for recovery and chart tests.

```sh
npm install --ignore-scripts
npm run verify:source
npm test
npm run test:bdd
npm run test:recovery
npm run test:ui
npm run test:helm
```

Follow [BUILD.md](docs/BUILD.md) to generate dependency locks, compile the Vue application and build the runtime image. Supply that image to the deployer. `npm run build:flows` regenerates the domain flow aggregate; `node scripts/build-flows.js --check` checks it against the source routes. [VALIDATION.md](VALIDATION.md) describes the checks.

## Install the deployment node

Install `orce-esb-ocmwstack-12.4.0.tgz` in the deployer's ORCE/Node-RED user directory, restart the deployer and configure the OCM-W-Stack node. Provide the cluster kubeconfig, domain, TLS certificate/key, runtime image and initial UI/editor credentials.

The configuration schema remains `procedureVersion: 12`. Existing node fields, encrypted credentials, action names and output topics are preserved. The package, runtime and charts use version 12.4.0.

## Standalone deployment

The terminal command runs the same procedure as the node:

```sh
bash deploy.sh preflight \
  --config deployment.json \
  --kubeconfig cluster.yaml \
  --tls-cert-file fullchain.pem \
  --tls-key-file private-key.pem \
  --runtime-credentials-file credentials.json
```

Use `deploy` in place of `preflight` to install. See [DEPLOYMENT.md](docs/DEPLOYMENT.md) for configuration, actions, outputs and the source map.

## Identity and data

The host-only `__Secure-ocm_session` cookie uses `Path=/orce/`, Secure, HttpOnly and SameSite=Strict. MongoDB stores token and CSRF digests. Sessions expire after 24 hours; hydration preserves the original deadline. Logout, password, account and permission changes invalidate sessions. Socket connections revalidate on handshake, packets, outbound hints and a five-second revocation timer.

The runtime Secret supplies the optional native bearer token independently of UI authentication. The operator supplies and rotates that credential. Tenant, account and group scope come from server configuration.

Native services retain credential and connection data. UI operation records contain metadata and request hashes; save a one-time offer or invitation response when it is returned. See [ARCHITECTURE.md](docs/ARCHITECTURE.md), [API.md](docs/API.md) and [CONFIGURATION.md](docs/CONFIGURATION.md).

[INTERFACES.md](docs/INTERFACES.md) describes the native integration requirements. The release verification command, `npm run verify:code`, checks the requirement register, dependency locks, build checks and release evidence. Deployment journeys are listed in [LIVE-ACCEPTANCE.md](docs/LIVE-ACCEPTANCE.md).
