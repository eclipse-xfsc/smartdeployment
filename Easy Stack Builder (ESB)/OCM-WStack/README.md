# OCM W-Stack 12.3.18

The ESB node deploys the XFSC native services and the OCM W-Stack UI. ORCE routes UI requests to native credential, issuance, verification, status and relationship services. MongoDB stores UI accounts, roles, sessions, preferences and operation metadata.

## Source layout

- `ocmwstack.js`, `ocmwstack.html`, `lib/`: deployer and Kubernetes helpers.
- `runtime/flows/`: domain flows; `runtime/flows.json`: generated deployment flow.
- `runtime/lib/modules/`: Auth, Credentials, ClearingCenter, Issue, Relationships and Provenance handlers.
- `ui/src/`: Vue components and EN/DE/FR catalogs.
- `runtime/uibuilder/orce/dist/`: UI runtime assets. The Vite build writes compiled assets here.
- `charts-runtime/`, `charts-gateway/`, `charts-dashboards/`: deployment charts.
- `docs/baseline/`, `docs/requirements.json`: specifications and acceptance criteria.

## Build and test

Use the Node version required by the selected ORCE base image and the package manifests. Python 3 and Helm are required for packaging and chart tests.

```sh
npm install --ignore-scripts
npm run verify:source
npm test
npm run test:bdd
npm run test:ui
npm run test:helm
```

Follow [BUILD.md](docs/BUILD.md) to generate dependency locks, compile the Vue application and build the runtime image. Supply that image to the deployer. `npm run build:flows` regenerates the domain flow aggregate; `node scripts/build-flows.js --check` checks it against the source routes. [VALIDATION.md](VALIDATION.md) describes the checks.

## Install and upgrade

Install `orce-esb-ocmwstack-12.3.18.tgz` in the deployer's ORCE/Node-RED user directory, restart the deployer and configure the OCM-W-Stack node. Provide the cluster kubeconfig, domain, TLS certificate/key, runtime image and initial UI/editor credentials.

For an installation from 12.3.17 or earlier, complete the [UI identity migration](docs/MIGRATION-12.3.18.md) before rollout. Back up MongoDB, UI identity stores, retained keys, Helm values, operator flows and volumes. The installer requires the UI bootstrap hash in a retained runtime Secret.

The configuration schema remains `procedureVersion: 12`. The package, runtime and charts use release version 12.3.18.

## Identity and data

The host-only `__Secure-ocm_session` cookie uses `Path=/orce/`, Secure, HttpOnly and SameSite=Strict. MongoDB stores token and CSRF digests. Sessions expire after 24 hours; hydration preserves the original deadline. Logout, password, account and permission changes invalidate sessions. Socket connections revalidate on handshake, packets, outbound hints and a five-second revocation timer.

The runtime Secret supplies the optional native bearer token independently of UI authentication. The operator supplies and rotates that credential. Tenant, account and group scope come from server configuration.

Native services retain credential and connection data. UI operation records contain metadata and request hashes; save a one-time offer or invitation response when it is returned. See [ARCHITECTURE.md](docs/ARCHITECTURE.md), [API.md](docs/API.md) and [CONFIGURATION.md](docs/CONFIGURATION.md).

[INTERFACES.md](docs/INTERFACES.md) describes the native integration requirements. The release verification command, `npm run verify:code`, checks the requirement register, dependency locks, build checks and release evidence. Deployment journeys are listed in [LIVE-ACCEPTANCE.md](docs/LIVE-ACCEPTANCE.md).
