# OCM W-Stack

This package installs the native XFSC OCM W-Stack services and a dedicated ORCE instance for their application backend and uibuilder UI.

## Architecture

There are two ORCE instances:

1. **Deployer ORCE:** an existing instance with the configurable `OCM-W-Stack` node installed from the npm archive. An Inject node triggers deployment.
2. **Application ORCE:** installed alongside the OCM services in namespace `ocm-wstack`. It hosts the application flows, uibuilder and Vue UI, and connects to MongoDB and the native OCM services.

The native OCM services remain the credential and connection system of record. MongoDB stores application accounts, roles, sessions, preferences, audit and operation metadata. Clearing recovery temporarily retains an AES-256-GCM encrypted credential until native storage is confirmed; this is not a second credential inventory.

The deployed application uses Vue 3.5.13, uibuilder 7.5.0, the MongoDB driver 6.13.0 and NATS client 2.29.2. Embedded MongoDB defaults to `mongo:6.0.20`; the ORCE base image defaults to `ecofacis/xfsc-orce:2.0.15`.

## Source layout

| Path | Purpose |
| --- | --- |
| `ocmwstack.js`, `ocmwstack.html`, `package.json` | Configurable deployer node, editor and npm registration |
| `deploy.sh`, `deployment/` | Deployment, diagnostics and recovery Bash scripts and configuration |
| `charts-runtime/files/flows.json` | Application initialization, auth, adapters, APIs and uibuilder |
| `charts-runtime/files/ui/` | `index.html`, `index.js`, `index.css`, `facis-logo.svg` |
| `charts-runtime`, `charts-gateway`, `charts-dashboards` | Runtime, gateway and dashboard Helm resources |
| `upstream-lock.json` | Upstream deployment revision and checksums |
| `test/bdd/` | Gherkin scenarios, Behave bindings and acceptance runner |

Edit Function nodes in `flows.json` and the UI source files directly. No compiled Vue application or Docker build is required.

## Build and install the deployer

From this OCM-WStack directory:

```bash
npm pack
```

This creates `orce-esb-ocmwstack-12.6.3.tgz`. To keep the archive outside the source directory:

```bash
mkdir -p /absolute/path/releases
npm pack --pack-destination /absolute/path/releases
```

Restart that ORCE after command-line installation. Repacking changed code without changing `package.json` still produces version `12.6.3`; a displayed version alone does not identify the installed bytes.

## Configure and trigger deployment

Add the **OCM W-Stack** node from **Easy Stack Builder**. Configure the target kubeconfig, base domain, tenant, TLS fullchain/private key and initial application/editor administrator credentials. Configure provider, storage and DNS settings for the target cluster.

Passwords require at least 12 characters and at most 72 UTF-8 bytes, with no control characters. Credentials are held in ORCE's credential store. Complete the initial application password change before using the BDD test operator. Subsequent deployments retain existing accounts and encryption keys.

Connect an Inject node. The default action is `deploy`; use `msg.action` for another action. Configuration and credentials come from the configured node, not arbitrary incoming message fields.

| Output | Content |
| --- | --- |
| 1 | Result, diagnostics and public access/DNS details |
| 2 | Progress and heartbeat events |
| 3 | Complete deployment log and its private local filename |

Full logs can contain credentials or Kubernetes Secret data. Keep logs outside Git. A local deployment failure does not undo resources already submitted: Kubernetes and Argo CD may continue reconciling them. Inspect output 3 before retrying. Closing the node cancels its local process group; teardown is a separate confirmed action.

Other actions include `install-ui`, `repair-ocm`, `repair-network`, `inspect`, `validate`, `diagnose-auth`, `diagnose-api`, `diagnose-storage`, `test-credentials` and `teardown`. `test-credentials` and `teardown` require explicit confirmation. Consult `bash deploy.sh --help` for CLI options.

For CLI deployment, first run `npm install --omit=dev --ignore-scripts --no-audit --no-fund` in this directory, then use private configuration files:

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

A minimal deployment configuration is:

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

Initial credential JSON contains `editorPassword` and `uiAdminPassword`. Never commit credential files, kubeconfigs, TLS keys, test inputs, deployment logs or confidential reference documents.

## Application installation and API

The chart's initialization container installs `/data/flows.json` and `/data/uibuilder/orce/src/`, generates ORCE settings/socket middleware, and installs runtime dependencies. Prepared releases are published through `/data/current`. Existing Secrets, MongoDB/PVC data and prior release directories are retained. Independently managed flow volumes are refused.

For the configured tenant origin:

- Application: `/orce/`
- Application editor: `/orce/editor/`
- Application API: `/orce/ui-api/v1/`

`OCM initialization` loads shared libraries in dependency order, starts MongoDB/NATS integration and supplies the Auth, Credentials, ClearingCenter, Issue, Relationships, Provenance and Base flow tabs. Use a full flow deploy after editing initialization functions.

Normal domain responses contain `{type, auth, data, requestId}`. Authentication and health routes have their own response shapes. Failures expose structured error codes, not arbitrary upstream error bodies. NATS lifecycle notifications prompt authenticated clients to refresh their API data.

MongoDB database `ocm_ui` includes `ui_users`, `ui_roles`, `ui_sessions`, `ui_login_limits`, `ui_preferences`, `ui_audit_log`, `verification_events`, `credential_types`, `operation_jobs`, `clearing_jobs`, `ui_meta` and `coordination_locks`. Session expiry is enforced during authentication; MongoDB TTL deletion is housekeeping. Operation and clearing jobs expire after 72 hours, and audit/verification records after 90 days. Offers/results retained for recovery use the application AES-256-GCM key. Session cookie values are stored as hashes.

Manual identity migration is an editor-only operation. Keep its inputs, exports and hashes away from public HTTP and Debug nodes; the apply step requires `msg.confirm="apply-identity-migration"`.

## Clearing and credential refresh

Clearing acquisition implements the configured Gaia-X Dispatcher OID4VP/OID4VCI exchange, then verifies the received credential and confirms native storage. It requires three existing signed Gaia-X credentials: `gaiax-legal-person`, `gaiax-vat-id`, and `gaiax-terms-and-conditions`. Provider/network availability, metadata and credential suitability affect the result. Interrupted or uncertain exchanges must not be blindly repeated. The clearing Function explicitly imports `setImmediate` from `platform.timers`.

`POST /credentials/:id/refresh` delegates to a configurable upstream JSON POST. Set `OCM_CREDENTIAL_REFRESH_URL` on the **OCM initialization** flow tab or application ORCE environment, or set `credentialRefreshUrl` in private runtime configuration. The URL must contain `{credentialId}`; optional scope placeholders are `{tenantId}`, `{accountId}` and `{groupId}`. Values are URL-encoded and the selected credential is looked up in the authenticated scope before dispatch. The upstream URL is administrator configuration, never a request field or an untrusted credential-supplied URL.

The request body is forwarded unchanged with native authorization/scope headers. Successful forwarding returns `state="submitted"` and `upstreamResult`; it does not establish reissuance or storage. Missing configuration returns `503 REFRESH_ENDPOINT_NOT_CONFIGURED` for that request and does not stop the application. No working native refresh contract has been established for the pinned issuer service. Configure this only after verifying the actual upstream method, URL, body and authentication requirements.

## BDD acceptance tests

The tests use standard Gherkin and Behave 1.3.3 with pinned Python dependencies. Run them against the **application ORCE tenant origin**, not the deployer ORCE or its editor. Use Python 3.11+ and Git. TLS certificate validation stays enabled; the tests do not provide an insecure-TLS switch. For a private CA, set `SSL_CERT_FILE` to the trusted CA bundle.

| Suite | Scenarios | Coverage and prerequisites |
| --- | ---: | --- |
| `core` | 15 | UI asset delivery, live/native readiness, anonymous denial, session flags/expiry, operator permissions, credential/relationship/offer/type browsing, clearing configuration, CSRF/scope denial, logout invalidation |
| `credential` | 3 | Detail, successful native verification and declared provenance for an existing known-valid JSON-LD or SD-JWT credential with issuer/holder identities |
| `clearing` | 1 | Real acquisition using three signed inputs, terminal success and native storage readback; creates a credential |
| `refresh` | 1 | Configured upstream forwarding and idempotent replay for an existing credential; requires a verified upstream endpoint and may cause reissuance |

### Recorded live core result

The operator-run **core API suite passed on 29 October 2026** against the FACIS IONOS application ORCE. The terminal output records:

| Item | Result |
| --- | --- |
| Suite | `core` |
| Feature | 1 passed, 0 failed |
| Selected scenarios | **15 passed, 0 failed** |
| Selected steps | **55 passed, 0 failed** |
| Execution time | 7.936 seconds |
| Runner result | **`Live suite: PASS`** |
