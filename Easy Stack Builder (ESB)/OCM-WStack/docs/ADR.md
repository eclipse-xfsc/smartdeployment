<!-- SPDX-License-Identifier: Apache-2.0 -->

# OCM-WStack: Architecture Decision Records

Module: FACIS Easy Stack Builder (ESB), `OCM-WStack`. Context: ESB ICAM Change Request CR01.

## How to read this document

- **Code basis.** The branch of the follow-up pull request, based on `main` commit `e5c7b44` (the merge of pull request #7). Compared with that commit, the branch sets the version strings to `12.6.4` in `package.json`, `charts-runtime/Chart.yaml`, `charts-runtime/files/seed.sh`, `charts-runtime/files/flows.json` (two hard-coded runtime version strings, previously `12.5.11`), `charts-runtime/files/ui/index.js`, `deployment/cluster.sh` and `ocmwstack.html`, and makes the small corrections listed in the pull request description. It does not change the behaviour of the flows or the UI. The deployer changes in one respect: `deployment/assets.sh` no longer renders the public offering test route, and `deployment/checks.sh › test_credentials` reaches that service through a port-forward.
- **Paths** are relative to the module directory `Easy Stack Builder (ESB)/OCM-WStack/`. Function nodes in `charts-runtime/files/flows.json` are cited as `flows.json › <node name>` (with node id where useful).
- **External documents.** The CR01 change procedure form (29 April 2026) and the CR01 activity breakdown and timeline v5.0 (26 June 2026) were consulted for this document. They are not contained in this repository. Where an ADR cites them, it cites them as the agreement record; everything else in each ADR is taken from the code.
- **Status.** Each ADR states what the code implements. ADR-002 cites the realization offer in CR01, which the principal accepted, as its agreement record and is marked *Accepted*. The other ADRs are marked **"Proposed – to be confirmed by the principal"**, because no written agreement on them is contained in this repository. A reviewer who holds such a record should change the status to *Accepted* and cite the record.
- **"Alternatives considered"** lists alternatives that are visible in the code base, the repository or the CR context. No written evaluation of these alternatives is recorded in the repository. They are not claims that a formal comparison took place.

## Index

| ADR | Title |
| --- | --- |
| [ADR-001](#adr-001-application-runtime-on-a-dedicated-orce-node-red-instance-with-uibuilder) | Application runtime on a dedicated ORCE (Node-RED) instance with uibuilder |
| [ADR-002](#adr-002-vue-3-without-a-build-step-instead-of-react) | Vue 3 without a build step instead of React |
| [ADR-003](#adr-003-no-dedicated-container-image-dependencies-installed-by-an-init-container) | No dedicated container image; dependencies installed by an init container |
| [ADR-004](#adr-004-mongodb-for-ui-state-sessions-audit-and-verification-history) | MongoDB for UI state, sessions, audit and verification history |
| [ADR-005](#adr-005-local-accounts-with-bcrypt-server-side-sessions-and-csrf-tokens) | Local accounts with bcrypt, server-side sessions and CSRF tokens |
| [ADR-006](#adr-006-deployment-through-an-orce-deployer-node-helm-and-argo-cd) | Deployment through an ORCE deployer node, Helm and Argo CD |
| [ADR-007](#adr-007-delegate-credential-operations-to-the-native-xfsc-ocm-w-stack-services) | Delegate credential operations to the native XFSC OCM W-Stack services |
| [ADR-008](#adr-008-pcm-integration-excluded) | PCM integration excluded |
| [ADR-009](#adr-009-gaia-x-clearing-center-loire-through-the-lab-compliance-dispatcher) | Gaia-X Clearing Center (Loire) through the lab compliance dispatcher |
| [ADR-010](#adr-010-cluster-scoped-prerequisites-and-a-dedicated-cluster) | Cluster-scoped prerequisites and a dedicated cluster |
| [ADR-011](#adr-011-argo-cd-serverinsecure-behind-the-envoy-gateway) | Argo CD `server.insecure` behind the Envoy gateway |

---

## ADR-001: Application runtime on a dedicated ORCE (Node-RED) instance with uibuilder

### Context

The module must provide an application backend and a web UI in front of the native OCM W-Stack services. It covers credentials, offers, relationships, issuance, clearing, users and roles. ESB modules are delivered as ORCE (Node-RED) nodes, and FACIS provides an ORCE distribution as the container image `ecofacis/xfsc-orce`. The backend must run in the cluster next to the native services. It reaches them through ClusterIP Services in namespace `ocm-wstack` and through NATS in namespace `infrastructure`.

### Decision

- The module uses two ORCE instances (`README.md`, section "Architecture"):
  - The **deployer ORCE** hosts the `OCM-W-Stack` node (ADR-006).
  - The **application ORCE** is Deployment `ocm-orce` in namespace `ocm-wstack`. It runs 1 replica with strategy `Recreate` and PVC `ocm-orce-data` (`charts-runtime/templates/runtime.yaml`).
- The application is a Node-RED flow file, `charts-runtime/files/flows.json`. Parsing it shows:
  - 8 tabs: `OCM initialization`, `Base`, `Auth`, `Credentials`, `ClearingCenter`, `Issue`, `Relationships`, `Provenance`.
  - 43 `function` nodes.
  - 59 `http in` nodes: 57 under `/orce/ui-api/v1`, one for `/orce/vendor/vue.js` and one for `/_ocm/storage-diagnostics`.
  - 1 `uibuilder` node (`url: orce`, `deployedVersion: 7.5.0`), 1 `inject` node and 1 `http response` node.
  - No link nodes, no NATS nodes and no MongoDB nodes.
- MongoDB and NATS are used through npm client libraries (`mongodb`, `nats`). These are exposed to function nodes via `functionGlobalContext.ocmPlatform` in the generated `settings.js` (`charts-runtime/templates/config.yaml`).
- **Initialization.** The inject node `Initialize on deploy` (once) feeds a single chain:
  - `Prepare shared services` runs first.
  - It is followed by 30 library function nodes, in this order: `errors`, `coordination`, `accepted-storage`, `http`, `offers`, `credentials`, `storage-path`, `provenance`, `adapters`, `api-body`, `clearing-transport`, `clearing-jwt`, `clearing`, `config`, `events`, `issuer-bootstrap`, `lifecycle`, `local-auth`, `permissions`, `local-roles`, `registry`, `modules/Auth` … `modules/Base`, `runtime`, `identity-migration`.
  - Each library registers itself in the global context object `ocmLibraries`.
  - `Authenticate live UI connections` installs the Socket.IO middleware.
  - `Start MongoDB and NATS services` creates the `Runtime` singleton (`flows.json › runtime`, `instance()`) and publishes it as `ocmBridge.app`.
- **Request handling.**
  - Each tab has one service function node (for example `Auth service`). It calls `app.handle(msg.req, response, "<Module>")`.
  - Route matching, permission checks, CSRF, rate limiting and idempotency are implemented centrally in `flows.json › runtime` (`definitions`, `Runtime.handle`).
  - JSON bodies for `/orce/ui-api/v1` are parsed by `flows.json › api-body` (`parseApiBody`), which is invoked from `httpNodeMiddleware` in `settings.js`.
- **Runtime settings** (`charts-runtime/templates/config.yaml`):
  - The editor is at `httpAdminRoot: '/orce/editor'` with `adminAuth`: one user, bcrypt hash, `permissions: '*'`.
  - `functionExternalModules: false`, `externalModules.autoInstall: false`, projects disabled, `contextStorage` memory.
  - Security headers (CSP `script-src 'self'`, `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`) are set in `httpNodeMiddleware`.

### Alternatives considered

- A separately packaged backend service (for example Node.js or Go) behind the UI, with its own container image.
- Running the application flows inside the deployer ORCE instead of a dedicated instance.
- Building the flows from standard or community Node-RED nodes (MongoDB, NATS, link nodes) instead of code libraries in function nodes. The code does not do this.

### Consequences

**Positive**
- Uses the FACIS ORCE distribution. Flows and UI ship as files inside the Helm chart, with no compiled front-end and no Docker build (ADR-002, ADR-003).
- Business rules sit in named function nodes and can be read in the ORCE editor. The `OCM initialization` tab note reads "Edit business rules in the named Function nodes". Persistent changes must still be made in `charts-runtime/files/flows.json` (see the negative consequences below).

**Negative / risks**
- About 200 KB of JavaScript lives as JSON-escaped strings inside `flows.json` (217,545 bytes in total). Code review, diffs, linting and static analysis are harder than for plain source files.
- The repository contains no unit tests for the function code. `test/bdd/` only exercises a live deployment.
- Libraries depend on the order of the initialization chain and share state through the global context. A changed library takes effect only when the whole chain runs again: `Prepare shared services` closes the running `Runtime` and resets `ocmLibraries` before the libraries are reloaded.
- `charts-runtime/files/seed.sh` copies the chart's `flows.json` over `/data/flows.json` on every pod start. Changes made in the deployed editor are therefore overwritten at the next restart or rollout unless they are also committed to the chart.
- The editor is reachable on the public tenant host. The HTTPRoute `ocm-orce-ui` forwards the whole `PathPrefix /orce`, so `/orce/editor/` is exposed, protected only by Node-RED `adminAuth`.
  - Editor access is equivalent to full control of the runtime. Function nodes can read the runtime secrets file through `ocmPlatform.fs`.
- Single replica only. Per-process state includes:
  - API rate-limit counters (`Runtime.limit`), held in memory;
  - running clearing exchanges (`Clearing.running`);
  - the NATS client.

  Horizontal scaling is not supported as implemented.

### Status

Implemented. **Proposed – to be confirmed by the principal.**

---

## ADR-002: Vue 3 without a build step instead of React

### Context

- The OCM W-Stack specification (IDM.OCM.W-STACK.00075) names React for the UI. The CR01 activity breakdown and timeline v5.0 of 26 June 2026 chose Vue, with the note that this is to be aligned with the principal. Neither document is in this repository.
- The UI is served by uibuilder from static files in the ORCE data volume. The module deliberately has no image build (ADR-003).
- The runtime CSP allows scripts only from `'self'`. It contains neither `'unsafe-eval'` nor `'unsafe-inline'` for scripts (`charts-runtime/templates/config.yaml`).

### Decision

- The UI uses Vue 3.5.13. The dependency is pinned in the `package.json` generated by `charts-runtime/files/seed.sh`.
- Only the runtime-only browser ESM build `vue/dist/vue.runtime.esm-browser.prod.js` is used, without a template compiler.
  - The flow `flows.json › Serve installed Vue runtime` serves it at `GET /orce/vendor/vue.js`.
  - `settings.js` resolves the path as `ocmPlatform.vueRuntime`.
- `charts-runtime/files/ui/index.js` is a native ES module. It imports `createApp, h, reactive, onMounted, onUnmounted` from `/orce/vendor/vue.js` and mounts with `createApp(App).mount('#app')`.
- Components are written as render functions with `h()`. The file contains no `template:` options and no single-file components, and there is no bundler or transpiler.
- **UI sources:**
  - `index.html` (16 lines);
  - `index.js` (2,581 lines, about 112 KB, unminified, with English, German and French strings inline);
  - `index.css`;
  - `facis-logo.svg`.
- The Socket.IO client is loaded from uibuilder at `/orce/socket.io/socket.io.js`.
- `seed.sh` checks the UI at install time with `node --check uibuilder/orce/src/index.js` and verifies that the Vue runtime file exists.

### Alternatives considered

- **React with a build pipeline.** This is the variant mentioned in the CR01 specification. It produces a static bundle and needs a Node toolchain in CI or in an image build. A precedent for a built web UI exists in the same repository: `Easy Stack Builder (ESB)/PCM/web-ui_image_build/cloud-wallet-web-ui` is a Next.js application with its own `package-lock.json` and image build.
- **React without a build step.** This means writing `React.createElement` calls by hand, or transforming JSX in the browser. In-browser transformation would typically require relaxing the current CSP.
- **Vue with in-browser template compilation (full build).** Vue's runtime template compilation relies on `new Function`, which the current CSP blocks.

### Consequences

**Positive**
- No UI build toolchain, no build artefact and no image build. The UI files are edited directly and delivered through the runtime chart's ConfigMap `ocm-orce-seed`.
- Compatible with the strict CSP, because no runtime template compilation is used.

**Negative / risks**
- The choice differs from the React named in the OCM W-Stack specification; the realization offer accepted by the principal names Vue 3 (see Status).
- Render-function code is more verbose and less familiar than templates or JSX.
- The UI is a single large file without type checking, component tests, minification or tree-shaking.
- Browsers must support ES modules.
- The Socket.IO client is configured for the WebSocket transport only (`transports: ['websocket']` in `index.js`). Networks that block WebSockets lose live refresh hints. The REST API is unaffected.

### Status

Implemented. **Accepted.** The realization offer in the CR01 change procedure form, which the principal accepted, names "ORCE, uibuilder, Vue 3, MongoDB, Helm/Docker packaging" as the stack of the UI bundle. Plan v5.0 (section 4) adds that the React-versus-Vue choice is to be aligned at kick-off; no separate kick-off record is contained in this repository.

---

## ADR-003: No dedicated container image; dependencies installed by an init container

### Context

CR01 ("Helm/Docker packaging") and plan v5.0 (phase 8: "Helm chart and Docker image for the UI bundle") name a container image for the UI bundle. The implementation deviates from this; the deviation is stated under Status.

The application ORCE needs npm packages that the deployment installs itself:
- `node-red-contrib-uibuilder`
- `vue`
- `mongodb`
- `nats`
- `bcryptjs`
- `qrcode`

The ORCE base image is configurable (`runtimeImage`). It defaults to `ecofacis/xfsc-orce:2.0.15` (`deployment/assets.sh › normalize_config`, `charts-runtime/values.yaml`).

`normalize_config` rejects only references that end in `:latest`. An untagged reference passes the check, even though the error message reads "Select a tagged runtime image".

### Decision

- No module-specific container image is built.
- The runtime chart runs the base image twice:
  - as init container `seed-orce-runtime`, which runs `/bin/sh /seed/seed.sh`;
  - as main container `orce` (`charts-runtime/templates/runtime.yaml`).
- `charts-runtime/files/seed.sh`:
  1. Refuses unmanaged volumes. It stops if `flows.json` exists without the marker file `OCM-UI-V3-MANAGED`, or if `current`, `node_modules` or `uibuilder` are not symbolic links.
  2. Requires Node 20.19+ or 22.12+.
  3. Computes a release hash: the SHA-256 over the seed files (`flows.json`, `index.html`, `index.js`, `index.css`, `facis-logo.svg`, `settings.js`, `seed.sh`), the Node version, platform and architecture, and the `OCM_BASE_IMAGE` string.
  4. If `/data/releases/<hash>/.ready` does not exist, it stages a new release:
     - copies the flows, settings and UI files;
     - generates `package.json` with exact direct versions: `bcryptjs 2.4.3`, `mongodb 6.13.0`, `nats 2.29.2`, `node-red-contrib-uibuilder 7.5.0`, `vue 3.5.13`, `qrcode 1.5.4`;
     - generates `uibuilder/.config/sioMiddleware.js`;
     - runs `npm install --omit=dev --ignore-scripts --no-audit --no-fund`;
     - verifies the result with `require.resolve` for each package, checks that `flows.json` contains a `uibuilder` node, runs `node --check` on `settings.js` and `index.js`, and checks that the Vue runtime file exists.
  5. Publishes the release atomically through the `/data/current`, `/data/node_modules` and `/data/uibuilder` symbolic links. Earlier releases are kept.
- The same base image also runs the in-cluster guard `esb-ocm-guard` (`deployment/templates/reconciler.json`, `bash /guard/reconcile.sh`). The guard requires `bash`, `jq`, `curl`, `openssl`, `nc`, `timeout` and `sha256sum` in that image (`deployment/reconcile.sh › guard_main`).

### Alternatives considered

- **Dedicated image** with dependencies baked in, published with a digest. The repository's PCM module builds its own web UI image (see ADR-002).
- **Committed lockfile.** A pinned `package-lock.json` or `npm-shrinkwrap.json` in the seed ConfigMap, installed with `npm ci`.
- **Vendoring** `node_modules` into the chart. This is limited by the 1 MiB ConfigMap size and by binary content.

### Consequences

**Positive**
- No image build, registry or image-signing pipeline is needed for the module.
- An unchanged seed on the same PVC reuses the cached release. Pod restarts do not reinstall.
- `--ignore-scripts` blocks npm lifecycle scripts.

**Reproducibility trade-off (stated explicitly)**
- Only the six direct dependencies are pinned. No lockfile is used, so **transitive dependencies are resolved from the npm registry at install time**. Two installs of the same chart at different times, for example on a new PVC, a new cluster, or after any seed change, can produce different `node_modules` trees.
- The release hash covers the seed files, the Node runtime and the image *string*. It does not cover the resolved dependency tree. The hash therefore does not identify the installed bytes.
- The base image is referenced by tag (`ecofacis/xfsc-orce:2.0.15`), not by digest. A re-pushed tag changes the runtime without changing any value in this repository.
- A first start, and every start after a seed change, needs outbound HTTPS to the npm registry. The runtime NetworkPolicy allows TCP 443 to `0.0.0.0/0` except `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8` and `169.254.0.0/16` (`charts-runtime/templates/networkpolicy.yaml`).
  - If the registry is unavailable or slow, the init container fails and the rollout stalls.
  - No npm registry is configured in `seed.sh`. Whether the base image overrides npm's default registry has not been verified.
- Supply-chain exposure at install time is not covered by an integrity record (no `integrity` hashes, no SBOM).
- Old releases accumulate under `/data/releases/` on the 3Gi default PVC. No pruning is implemented.
- The guard depends on command-line tools that the ORCE base image happens to contain. This contract is implicit.
- The seed ConfigMap currently holds about 350 KB of files (`flows.json` 218 KB, `index.js` 112 KB). Kubernetes limits a ConfigMap to 1 MiB, which bounds future growth of flows and UI.

**Mitigation options (not implemented)**
1. Commit a lockfile (`package-lock.json` or `npm-shrinkwrap.json`) generated for the pinned direct versions. Ship it in `ocm-orce-seed`, switch `seed.sh` to `npm ci --omit=dev --ignore-scripts`, and include the lockfile in the release hash.
2. Pin the base image by digest (`image@sha256:…`) in `normalize_config` defaults and chart values.
3. Use a controlled npm mirror or proxy and configure it explicitly in `seed.sh`.
4. As a follow-up, build a dedicated image containing ORCE, the dependencies, flows and UI. Publish and sign it with an SBOM, which removes runtime installs entirely.
5. Prune releases other than `current` and the previous one.

### Status

Implemented. **Proposed – to be confirmed by the principal.** This decision deviates from the Docker image named in CR01 and plan v5.0. The deviation is raised with the principal in the handover; mitigation option 4 (a dedicated, signed image with an SBOM, published to a registry agreed with the principal) is the proposed follow-up.

---

## ADR-004: MongoDB for UI state, sessions, audit and verification history

### Context

- The native OCM services remain the system of record for credentials and connections (`README.md`).
- The UI also needs state of its own:
  - accounts, roles, sessions and login rate-limit counters;
  - preferences;
  - an audit trail and verification history;
  - idempotent operation records;
  - clearing exchange jobs;
  - a credential-type registry.
- Node-RED context storage is configured as memory-only (`settings.js` › `contextStorage`).

### Decision

- **Database.** MongoDB database `ocm_ui`, accessed through the `mongodb` 6.13.0 driver (`flows.json › runtime`, `Runtime.connect`). Runtime start retries the connection every 5 seconds until it succeeds.
- **Embedded instance** (default, `charts-runtime/templates/mongo.yaml`):
  - Deployment `ocm-ui-mongodb` with image `mongo:6.0.20`, 1 replica and strategy `Recreate`.
  - PVC `ocm-ui-mongo-data` (default 5Gi) with `helm.sh/resource-policy: keep`.
  - Root user `ocm_ui`. Its password is a random 32-byte hex value generated by `deployment/runtime.sh › runtime_install` and stored in Secret `ocm-orce-runtime`.
  - NetworkPolicy: ingress only from `app: ocm-orce`; no egress.
- **External instance.** Set `useExternalMongo: true` and supply the `mongoUri` credential. `deployment/runtime.sh › mongo_ports` derives the egress ports from the URI.
- **Collections** (created in `coordination`, `local-auth`, `local-roles`, `registry` and `clearing`):
  - `ui_users`, `ui_roles`, `ui_sessions` (TTL on `expiresAt`), `ui_login_limits` (TTL), `ui_preferences`;
  - `ui_audit_log` (TTL, 90 days);
  - `verification_events` (TTL, 90 days);
  - `credential_types`;
  - `operation_jobs` (TTL, 72 hours; unique per tenant, subject, account, group, operation and idempotency key);
  - `clearing_jobs` (TTL, 72 hours);
  - `ui_meta` (tenant scope guard; a mismatch raises `UI_DATABASE_SCOPE_MISMATCH`);
  - `coordination_locks`;
  - `ui_migrations` (written only by the manual identity migration, `flows.json › identity-migration`).
- **Idempotency.** Mutating API routes require `X-Idempotency-Key` and are recorded in `operation_jobs` (`flows.json › coordination`, `Coordination.run`).
  - Only selected metadata is persisted, never payloads, tokens or claims.
  - Ambiguous upstream failures are recorded as state `unknown` instead of being retried.
- **Encryption.** A clearing credential received from the dispatcher is stored AES-256-GCM-encrypted (`Coordination.seal`, key `offerKey`) in `clearing_jobs.encryptedCredential`. It stays there until native Storage confirms the credential, and is then removed (`flows.json › clearing`, `Clearing.store`).

### Alternatives considered

- **Node-RED context storage** (file-based). It provides no indexes, TTL or atomic counters.
- **Reusing native infrastructure databases** (Cassandra or Postgres in `infrastructure`). This would couple the UI to native schemas and credentials.
- **Postgres alongside an identity provider.** The repository shows traces of an earlier design: the Kyverno policy `charts-gateway/templates/tenant-routing.yaml` excludes pods labelled `ocm-ui-keycloak` and `ocm-ui-postgres`, which this module no longer deploys.

### Consequences

**Positive**
- TTL indexes handle housekeeping. Unique indexes and conditional updates give idempotency and optimistic concurrency without multi-document transactions.
- Data survives redeployments: the PVC is kept, and the Secret is created once by `create_retained` and never overwritten.

**Negative / risks**
- One more stateful component to operate. The module implements no backup or restore for MongoDB.
- The embedded instance is a single node without a replica set. The code does not use transactions.
- The application connects with the root user (`authSource=admin`).
- The image is referenced by tag, not digest. The support status of the MongoDB 6.0 series should be checked by the reviewer.
- Session expiry is enforced on every request. TTL deletion is housekeeping only (`README.md`, `flows.json › local-auth`, `verify`).
- The key `offerKey` serves two purposes: AES-256-GCM encryption here and the CSRF HMAC (ADR-005).
- A stale `coordination_locks` document `ui-identity`, left by a crash during a user or role change, blocks further identity changes with `409 ROLE_CHANGE_IN_PROGRESS`. The code comment in `flows.json › local-roles` (`lock`) says "Crash recovery is documented", but no such procedure is documented in `README.md`.

### Status

Implemented. **Proposed – to be confirmed by the principal.**

---

## ADR-005: Local accounts with bcrypt, server-side sessions and CSRF tokens

### Context

- The UI needs authentication and role-based authorization.
- PCM is out of scope (ADR-008).
- The code contains a migration path from an earlier Keycloak-based design. `flows.json › identity-migration` (`prepareMigration`) maps users and roles from a Keycloak realm export named `ocm-ui-<tenant>` to local accounts, and explicitly never imports Keycloak password hashes.

### Decision

**Accounts**
- Accounts are stored in `ui_users` (`flows.json › local-roles`, `local-auth`).
- **Bootstrap.**
  - At first deployment the deployer hashes the initial UI administrator password with bcrypt cost 12: `node ocmwstack.js --hash-password`, reading the password from stdin (`deployment/runtime.sh › password_hash`).
  - The hash is stored in Secret `ocm-orce-runtime`.
  - The runtime creates that user once, with `passwordChangeRequired: true` and role `administrator` (`LocalRoles.init`). Later deployments never recreate users or reset passwords.
- **Password policy:** at least 12 characters, at most 72 UTF-8 bytes, no control characters. Enforced in `local-auth` (`password`), `ocmwstack.js` and `runtime.sh`.
- **Hashing:** `bcryptjs` with cost 12.
- **Password changes.**
  - Administrators set temporary passwords (`temporaryPassword`, which forces a change at next login).
  - Users change their own password via `POST /auth/password`. This increments `authVersion` and deletes all sessions of that user.

**Login**
- `POST /auth/login` requires `Origin` equal to `publicOrigin`, and `Sec-Fetch-Site: same-origin` if that header is sent.
- Rate limits are counted in MongoDB per 15-minute window: 10 attempts per username and 50 per peer address.
- A dummy bcrypt hash equalizes timing for unknown users.

**Sessions**
- A random 32-byte token is set in cookie `__Secure-ocm_session` with `Path=/orce/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400`.
- Only the SHA-256 of the token is stored.
- Sessions have an absolute 24-hour expiry, checked on every request.

**CSRF**
- The token is `HMAC-SHA256(offerKey, "ocm-ui-csrf-v1:" + sessionHash)`, encoded as base64url and returned by login and `POST /auth/csrf`.
- It is required as `X-CSRF-Token` on every non-GET API request except `POST /auth/login` and `POST /auth/csrf`, together with a matching `Origin` header (`LocalAuth.csrf`, `Runtime.handle`).
- The Socket.IO handshake uses the same session, CSRF and origin checks and re-checks them every 5 seconds (`flows.json › Authenticate live UI connections`).

**Authorization**
- There are 13 atomic permissions and 5 system roles: `viewer`, `operator`, `issuer`, `auditor`, `administrator` (`flows.json › permissions`). Custom roles are possible.
- The last role manager cannot be removed (`LAST_ROLE_MANAGER`).
- While `passwordChangeRequired` is set, every route except `GET /auth/me`, the password change, `/auth/csrf`, `/auth/logout` and the health routes is rejected.
- Login, logout, password changes, denials and all mutations are written to `ui_audit_log`.

**Editor and dashboards**
- The application editor uses Node-RED `adminAuth` with a separate bcrypt hash of the editor password.
- If public dashboards are enabled, the Argo CD and Grafana `admin` accounts are initialized once with the same editor password (`deployment/runtime.sh › dashboard_admins`).

### Alternatives considered

- **Keycloak / OpenID Connect.** This was the earlier design, as the migration code shows. The sibling PCM module in this repository also uses Keycloak.
- **Federation** with an existing FACIS or principal identity provider.
- **PCM-based authentication.** Excluded by ADR-008.

### Consequences

**Positive**
- No additional identity provider has to be deployed or operated.
- Cookie flags, CSRF binding to the session, absolute expiry and origin checks are applied uniformly to REST and Socket.IO.

**Negative / risks**
- No MFA, SSO, federation or self-service password reset. Recovery depends on an administrator.
- **Per-peer login limit (to be verified on a live system).** The limit keys on `req.socket.remoteAddress`. Behind the Envoy gateway this is likely the Envoy pod address. If so, the 50-attempt window, which counts successful logins too, is shared by all users behind the same Envoy instance.
- One key (`offerKey`) is used for both the CSRF HMAC and AES-256-GCM encryption (ADR-004). Separate keys would follow common key-separation practice.
- All UI users act on **one** wallet scope. `tenant`, `account` and `group` come from runtime configuration (`deployment/templates/runtime-config.json`: account and group `ocm-wstack`), not from the user. Roles restrict operations; they do not partition data.
- The editor password is reused as the initial password for the dashboards. Later dashboard password changes are kept (`esb-dashboard-access` marker).

### Status

Implemented. **Proposed – to be confirmed by the principal.**

---

## ADR-006: Deployment through an ORCE deployer node, Helm and Argo CD

### Context

- ESB modules are installed from an ORCE instance.
- The upstream repository `https://github.com/eclipse-xfsc/deployment.git` provides:
  - the bootstrap scripts `basic-cluster-init.sh`, `ocm-wstack-init.sh`, `argocd-bootstrap.sh` and `check-applicationset.sh`;
  - Argo CD ApplicationSets (`03_storage`, `04_network`, `05_core`, `06_ocm_wstack`);
  - a tenant chart (`XFSC/tenant/chart`).

### Decision

**Deployer node** (`ocmwstack.js`, `ocmwstack.html`)
- Node type `OCM-W-Stack` in palette category "Easy Stack Builder", with 3 outputs: result, progress and full log.
- An incoming message selects only `msg.action` (default `deploy`) and `msg.confirm`.
  - Configuration comes from the node.
  - Credentials come from the Node-RED credential store: `kubeconfig`, `tlsCertificate`, `tlsPrivateKey`, `dnsToken`, `dnsSecretData`, `editorPassword`, `uiAdminPassword`, `mongoUri`.
  - Both are written to private temporary files (mode 0600) for each run.
- The node spawns `bash deploy.sh <action> --config … --credentials …` as its own process group. It reconstructs interrupted runs from `run.json` (`interruptedLogs`).

**Bash deployer** (`deploy.sh`, `deployment/*.sh`)
- `checkout_source` fetches commit `c1ba65c23ffdd891b6edec3bd277fad32b097378`. It verifies the SHA-256 of 56 upstream files listed in `upstream-lock.json`, then applies the ESB patch from `deployment/assets.sh upstream-patch`.
  - The patch routes the upstream `helm` and `kubectl` calls through `deploy.sh --internal …`, which binds the uploaded kubeconfig and context and refuses credential or context override flags (`cluster.sh › kube_command`).
  - It also replaces the upstream Argo CD `stable` manifest with a manifest pinned to commit `c9c369efcc5b2a0bd720803f8d14a1c3eaddf579` (`argoCdCommit`).
- `prepare_charts` renders every chart with `helm template` against the cluster's Kubernetes version. It checks rendered contracts (`validate_chart_manifests`), verifies the policy image manifest (`policy_image_preflight`) and records the Argo CD manifest hash.
- Upstream ApplicationSets are installed with `tag` set to the pinned commit and with ESB template patches (`esbTemplatePatch` from `deployment/templates/routing-patch.yaml` and `native-overrides.json`). Argo CD then synchronizes the native services from the same pinned commit.
- The deployer installs these Helm releases directly (not through Argo CD):
  - the tenant chart (release `tenantRelease`, default `demotenant`);
  - `esb-ocm-gateway` (`charts-gateway`, namespace `security`);
  - `ocm-orce-ui` (`charts-runtime`, namespace `ocm-wstack`);
  - `esb-dashboard-routes` (`charts-dashboards`, namespace `infrastructure`).
- **Safety.**
  - A Lease and an ownership-marker ConfigMap `esb-ocmwstack-v12` in `kube-system`.
  - Labels `app.kubernetes.io/managed-by: esb-ocmwstack` on owned resources.
  - `create_retained` for Secrets.
  - A Helm journal and recovery (`deployment/recovery.sh`).
  - Explicit confirmation strings for `test-credentials` (`CREATE TEST CREDENTIAL`) and `teardown` (`REMOVE TENANT <tenantRelease>`).
- **Certificates.** TLS uses an uploaded certificate (`tlsMode: "uploaded"`). The upstream `INFRA/network/cluster-issuer` and `INFRA/network/bind9` are excluded. ExternalDNS is used only if `externalDns` is true (`assets.sh › network_values`, `cluster.sh › chart_plan`).

### Alternatives considered

- **GitOps only:** an Argo CD app-of-apps from a FACIS-controlled repository, without a Bash deployer.
- **A single umbrella Helm chart** for all components.
- **Running the upstream bootstrap scripts unmodified.**
- **A Kubernetes operator** for the module.

### Consequences

**Positive**
- The upstream revision and file contents are pinned and integrity-checked.
- Operations are resumable and guarded by ownership checks.
- Configuration is validated before any cluster write (`normalize_config`, `preflight`).

**Negative / risks**
- **Deployer requirements.**
  - The deployer environment needs `bash node npm jq curl git helm kubectl openssl base64 sha256sum timeout setsid nc busybox` (`common.sh › check_tools`) and Helm 3.13 or newer, or Helm 4.
  - It needs a cluster-admin kubeconfig: `cluster_preflight` requires `*/*/*` in a SelfSubjectAccessReview.
  - It needs Internet access (see `docs/API-INVENTORY.md`, section 3).
- **Upstream dependency at runtime.** Argo CD keeps pulling from `github.com/eclipse-xfsc/deployment` at the pinned commit.
- **Divergence from upstream.** The ESB template patches make the in-cluster ApplicationSet templates differ from upstream.
- **Upgrade cost.** Any upstream bump invalidates the file hashes and the patch. It requires a new review; `upstream-lock.json › reviewedAt` is `2026-10-26`.
- **Maintainability.** The deployer is about 5,500 lines of Bash and embedded jq (`deploy.sh` and `deployment/*.sh`).
- **Fresh cluster required.** `ensure_marker` fails with `NOT_FRESH` if the namespaces `observability`, `security`, `argocd`, `infrastructure` or `ocm-wstack` exist without the marker (ADR-010).
- **Partial teardown.** `teardown` removes only the tenant Helm release. The OCM services, Argo CD, shared infrastructure, credential data, OpenBao tenant keys and signer registration are retained (`deploy.sh`).
- **Logs and failures.** Full deployment logs on output 3 can contain credentials or Secret data (`README.md`, `ocmwstack.html`). A failed local run does not roll back submitted cluster changes.

### Status

Implemented. **Proposed – to be confirmed by the principal.**

---

## ADR-007: Delegate credential operations to the native XFSC OCM W-Stack services

### Context

The OCM W-Stack provides services for storage, retrieval, signing and verification, status lists, DIDComm, well-known metadata and issuance. Implementing these functions a second time in the UI backend would create a second system of record and additional security-critical code.

### Decision

The UI backend calls the native services and does not re-implement them (`flows.json › adapters`, `events`, `issuer-bootstrap`, `accepted-storage`). The endpoints are listed in `docs/API-INVENTORY.md`, section 2.

| Operation | Native service |
| --- | --- |
| List, read, import and delete credentials | Storage |
| Verify a credential | Signer (`POST /v1/credential/verify`); its verdict is passed through. No local signature verification for this route. |
| Revoke a credential | Status List (`POST /status/{tenant}/{listId}/revoke/{index}`) |
| Read revocation/suspension status | NATS request on `status.data` |
| List, import, accept and reject offers | Retrieval |
| After accept | Read-back from Storage; persisted with an idempotent PUT only if the Retrieval response is not already stored |
| Relationships | DIDComm connector admin API |
| Credential types | NATS request on `wellknown.issuer.metadata` |
| Issuance | NATS request on the topic advertised in issuer metadata (`<topic>.request`) |
| Issuer tenant registration check | Dummy Content Signer `GET /internal/tenants/{tenant}` |

- **Readiness.** `Runtime.probeNative` probes Storage, Retrieval, the issuer bootstrap and DIDComm every 20 seconds, plus the NATS connection. The result is exposed through `GET /orce/ui-api/v1/health/ready`.
- **Scope of local processing.** It is limited to:
  - decoding credentials for display (`credentials`);
  - declared-validity display (`lifecycleStatus`);
  - a provenance graph built from declarations (`provenance`);
  - offer normalization (`offers`).
- **Exception: the clearing exchange (ADR-009).** It verifies the dispatcher's request-object JWT and the received ComplianceCredential locally (`flows.json › clearing-jwt`) before storing the credential in native Storage.

### Alternatives considered

- Implementing verification, status or storage in the UI backend with JavaScript libraries.
- Calling native services through the public tenant routes instead of ClusterIP Services.

### Consequences

**Positive**
- A single system of record. Behaviour stays consistent with the native W-Stack, and the module carries less security-critical code.

**Negative / risks**
- **Features are bounded by the native APIs.**
  - **Verify.**
    - Only `ldp_vc` and `dc+sd-jwt` are verified. Other formats, including `jwt_vc_json` (for example a stored Gaia-X `vc+jwt` ComplianceCredential), return `overall: "unsupported"` with code `UNSUPPORTED_FORMAT`.
    - The Signer returns a single verdict, so the cryptographic and status parts are reported as `not_separately_reported`.
  - **Refresh.** No native refresh contract has been established (`README.md`). `POST /credentials/:id/refresh` returns `503 REFRESH_ENDPOINT_NOT_CONFIGURED` unless an operator configures a URL.
  - **Retrieval.** Formats other than JWT and SD-JWT are rejected (`RETRIEVAL_CREDENTIAL_FORMAT_UNSUPPORTED`).
  - **Chains.** Native chain resolution is only attempted when all selected credentials are JSON objects.
- **Coupling to internal contracts.** The code depends on native contracts that are internal or undocumented in this repository:
  - Dummy Content Signer `/internal/tenants/{id}`;
  - Storage path layout `/v1/tenants/{tenant}/storage/{region}/{country}/{account}/credentials`;
  - CloudEvent payload shapes on NATS.

  These are stable only as long as the upstream pin is kept.
- **Trust boundary is the network.** By default no `Authorization` header is sent to native services: `nativeToken` is not set by the deployer. Requests carry scope headers (`x-tenantid`, `x-groupid`, `x-group`, `x-namespace`, `x-origin`). Protection relies on NetworkPolicies and in-cluster reachability.
- **Resilience.** Native calls use timeouts of 5 s for GET and 15 s for mutations, plus a per-service circuit breaker (3 consecutive failures of 5xx or transport type open the circuit for 30 s; `flows.json › adapters` and `flows.json › http`, `Client.call`). Mutations are never retried automatically.
- **Version hints are comments only.** Code comments refer to specific native versions, but these are not enforced pins:
  - "Storage 1.2.5" (`storage-path`);
  - "Storage 1.3.0" (`adapters`, `records`);
  - "Crypto 2.3.7" (`adapters`, `verify`).

  The two Storage versions are inconsistent with each other.

### Status

Implemented. **Proposed – to be confirmed by the principal.**

---

## ADR-008: PCM integration excluded

### Context

The CR01 activity breakdown and timeline v5.0 of 26 June 2026, section 2.2, excludes integration with PCM (Personal Credential Manager) from the CR01 scope. `README.md` states the exclusion under "Scope and exclusions" with reference to the same section. The plan is not in this repository. The repository contains a separate ESB module `Easy Stack Builder (ESB)/PCM`, which this module does not use.

### Decision

- `flows.json › config` (`load`) throws `PCM is outside the approved scope` if the runtime configuration contains `pcm.enabled` with a truthy value.
- `GET /orce/ui-api/v1/auth/config` always reports `features.pcm: false` (`flows.json › runtime`, `Runtime.handle`).
- The deployer's validation requires `.data.features.pcm == false` (`deployment/checks.sh › validate_stack`, check `ui-auth`).
- The deployer has no PCM option. `normalize_config` builds the configuration from an explicit field list, so a `pcm` field can only reach the runtime by editing ConfigMap `ocm-orce-config` by hand.
  - In that case `Runtime` cannot be created, the API answers `503 COORDINATION_UNAVAILABLE`, and the liveness and readiness probes fail.

### Alternatives considered

- PCM integration behind a feature flag.
- Integration with the separate ESB PCM module.

### Consequences

- The UI and backend contain no PCM code paths. Holder-side operations exist only through the OCM W-Stack (Retrieval and Storage).
- Including PCM later requires a scope change and new design work. There is no dormant implementation.

### Status

Implemented. **Proposed – to be confirmed by the principal.** Plan v5.0, section 2.2, states the exclusion; the CR01 form itself lists "access to PCM credentials via ORCE for listing" and refers to the April activity breakdown. The principal's written confirmation of the exclusion is requested in the handover.

---

## ADR-009: Gaia-X Clearing Center (Loire) through the lab compliance dispatcher

### Context

The UI offers acquisition of a Gaia-X compliance credential (`gx:ComplianceCredential`) from a clearing service (`flows.json › modules/ClearingCenter`, `clearing`). The input credentials must already exist in native Storage:
- `gaiax-legal-person` (`gx:LegalPerson`);
- `gaiax-vat-id` (`gx:VatID`);
- `gaiax-terms-and-conditions` (`gx:Issuer`).

### Decision

**Endpoint**
- The endpoint is **hard-coded**: `ENDPOINT = 'https://compliance-dispatcher.lab.gaia-x.eu/v3'` in `flows.json › clearing` (id `ocm-library-12`).
- The `Clearing` constructor would accept `config.clearingCenter.url`. However, the deployer never sets it: `deployment/templates/runtime-config.json` has no such key, and `normalize_config` drops unknown fields. In practice the endpoint can only be changed by editing `flows.json` or the ConfigMap by hand.

**Provider and inputs**
- There is a single provider, `gaia-x` ("Gaia-X Clearing Center"), with `trustScope: GX_LOIRE_COMPLIANCE` and `complianceLevel: standard-compliance`.
- Each input must be a `vc+jwt` with the W3C VCDM 2.0 context, and must be neither expired nor not yet valid (`inputClaims`).
- The caller needs `clearing.request`, `credentials.read` and `credentials.receive` (`requirePermissions`).

**Protocol** (`Clearing.exchange`; the job is persisted before any network mutation)
1. **Metadata validation.** The issuer and authorization-server metadata must match the base URL exactly. They must support the pre-authorized-code grant, format `jwt_vc_json` with ES256 proofs, and type `gx:ComplianceCredential`.
2. **Authorization request.** `GET /oid4vp/authorize?trustScope=…&vcid=<LegalPerson id>&complianceLevel=standard-compliance` returns an `openid4vp:` link. Its `client_id` must be `decentralized_identifier:did:web:compliance-dispatcher.lab.gaia-x.eu:v3`.
3. **Request object.** The request object from `/oid4vp/request.jwt` is verified against `/.well-known/jwks.json`. It must use `response_mode: direct_post` to `/oid4vp/callback`, carry `aud: https://self-issued.me/v2`, and have a lifetime of at most 600 s. The DCQL query must request exactly the three inputs as `jwt_vc_json` without cryptographic holder binding.
4. **Presentation.** `POST /oid4vp/callback` sends `vp_token`, a JSON object of the three raw JWTs. The response must contain a by-value `openid-credential-offer:` redirect for `ComplianceCredential` with a pre-authorized code and no transaction code.
5. **Token and nonce.** `POST /oid4vci/token`, then the nonce endpoint.
6. **Credential.** `POST /oid4vci/credentials` with a JWT proof signed by a **per-request ephemeral P-256 key** (`clearing-jwt › proof`).
7. **Verification and storage.**
   - The received `vc+jwt` is verified with the issuer key, resolved from `did:web` (DID document over HTTPS) or `did:jwk`. Its type must include `gx:ComplianceCredential`.
   - The credential is stored encrypted in `clearing_jobs` and then written to native Storage with the job id as credential id.
   - The credential is read back from Storage and the encrypted copy is removed.
   - The notification endpoint is called if it is advertised.

**Transport** (`flows.json › clearing-transport`)
- HTTPS only; no explicit port; no IP-literal hosts; no URL credentials.
- Resolved addresses must be public: private, loopback, link-local, CGNAT, documentation and multicast ranges are blocked.
- No redirects, 2 MiB response limit, 20 s default timeout (90 s for the callback).

**Failure handling**
- A failure before the presentation is dispatched marks the job `failed`.
- A failure after dispatch marks it `unknown`.
- A failure after the credential was received marks it `received`. Storage can then be retried with `POST /clearing/requests/:id/store`.
- A job that is still non-terminal after its 5-minute deadline, for example after a process restart, becomes `unknown` with code `CLEARING_INTERRUPTED` (`Clearing.find`).
- Exchanges are never replayed automatically. The code comment in `Clearing.find` reads "An interrupted exchange must never silently replay a consumed code or nonce".

### Alternatives considered

- A deployer-configurable endpoint (node field and runtime-config key).
- The Gaia-X production dispatcher or other clearing house instances instead of the lab endpoint.
- Several clearing providers with a selection in the UI.

### Consequences

- **Test endpoint only.** The integration targets the Gaia-X **lab** environment. The UI text states that lab credentials are for testing only (`index.js`, `clearingIntro`).
  - Switching to a production or other dispatcher requires a code change and a new review.
  - The dispatcher DID, endpoint paths and metadata checks are tied to the `/v3` base.
- **Availability.** It depends on an external service outside the control of the principal and the contractor.
- **Holder binding.**
  - The presentation is not holder-bound: the DCQL query must say `require_cryptographic_holder_binding: false`, and the vp_token is not a signed VP.
  - The OID4VCI proof key is generated per request and not retained. Any key binding in the issued credential therefore refers to a key the wallet does not keep.
- **Verification route.** The stored ComplianceCredential is a JWT (`jwt_vc_json`). It cannot be verified through `POST /credentials/:id/verify` (ADR-007).
- **Egress.** The application ORCE needs outbound HTTPS to public addresses. The runtime NetworkPolicy allows TCP 443 to `0.0.0.0/0` except the RFC 1918, loopback and link-local ranges. The rule is pod-wide, not limited to the dispatcher host.

### Status

Implemented. **Proposed – to be confirmed by the principal.**

---

## ADR-010: Cluster-scoped prerequisites and a dedicated cluster

### Context

- The upstream OCM W-Stack bootstrap installs platform components cluster-wide.
- The native services need further cluster-level adjustments:
  - probe timeouts;
  - rollout strategy;
  - tenant hostname routing to the Envoy gateway;
  - credential reconciliation.

### Decision

**Installed or required by the deployer**

Platform components (Helm releases created through the patched upstream bootstrap):

| Component | Helm release | Notes |
| --- | --- | --- |
| Observability | `observability` (namespace `observability`) | |
| OpenBao | `openbao` (namespace `security`) | ESB patch to `templates/init-job.yaml` |
| External Secrets Operator | `eso` (namespace `security`) | |
| Kyverno | `kyverno` (namespace `security`) | Recovery of an interrupted install in `deployment/kyverno.sh` |
| XFSC `kubernetes-operator` | `kubernetes-operator` (namespace `security`) | Installed from `INFRA/kubernetes-operator` at the pinned deployment commit. Provides the `resources.xfsc.io` resource claims and providers. `upstream-lock.json › operatorReview` (commit `25536da670e3ed5a9b300378b8880a6ce8dd6c48`, image tag `2.4.2`, chart `2.4.2-helm`) is an informational review record and is not read by the scripts. |
| Namespace releases | `infrastructure-namespace`, `ocm-wstack-namespace` | |

Further prerequisites:
- **Argo CD.** Installed in namespace `argocd` from the pinned upstream manifest, including the CRDs `applications`, `applicationsets` and `appprojects.argoproj.io` (`checks.sh › argo_install`). The Redis image is rewritten from `public.ecr.aws/docker/library/redis` to `docker.io/library/redis`.
- **Kyverno ClusterPolicies from `charts-gateway`** (release `esb-ocm-gateway`, all with `failurePolicy: Fail` and `background: false`):
  - `esb-ocm-cassandra-probes`: probe timeouts for StatefulSet `infrastructure/cassandra`;
  - `esb-ocm-didcomm-startup`: startup probe for `didcomm-connector` Pods;
  - `esb-ocm-envoy-traffic`: `externalTrafficPolicy` on EnvoyProxy `infrastructure/envoy`;
  - `esb-ocm-retrieval-startup`: `Recreate` strategy for `credential-retrieval-service`;
  - `esb-ocm-tenant-routing`: `hostAliases` mapping the tenant host to the Envoy gateway ClusterIP for Pods created in `ocm-wstack`, and for `*resolver*` / `*driver-did*` Pods in `infrastructure`.
- **ExternalSecret** `ocm-wstack/esb-credential-verification-cassandra`. It reads `cassandra/cassandra` property `password` through ClusterSecretStore `infrastructure-openbao` (`services.sh › native_prerequisites`).
- **In-cluster guard `esb-ocm-guard`** (`deployment/templates/reconciler.json`, `deployment/reconcile.sh`).
  - Its job: it keeps native consumers' credential annotations in sync, checks Redis authentication for the Pre-Authorization Bridge, and checks NATS listeners for `pre-authorization-bridge` and `well-known-service`, restarting `well-known-service` if needed.
  - It has the following RBAC:

    | Kind | Scope | Rules |
    | --- | --- | --- |
    | Role | `ocm-wstack` | get/list `secrets`, `pods`, `deployments`, `replicasets`, `resourceclaims.resources.xfsc.io`, `externalsecrets.external-secrets.io`; patch `deployments` |
    | Role | `infrastructure` | get Secret `redis-root-auth`, Endpoints `nats` |
    | **ClusterRole and ClusterRoleBinding** `esb-ocm-guard` | cluster | get `resourceproviders.resources.xfsc.io/redis` |

- **Ownership and coordination objects in `kube-system`.** ConfigMap `esb-ocmwstack-v12` (ownership marker) and Lease `esb-ocmwstack-v12`.
- **Required identity.** A cluster-admin kubeconfig (`cluster_preflight`). The cluster also needs working LoadBalancer and persistent-volume provisioners (`ocmwstack.html`).

### Alternatives considered

- A namespace-scoped installation into a shared cluster, relying on platform components that are already present.
- Upstream chart changes instead of Kyverno mutations and live patches.
- Running the reconciliation as part of the deployer instead of as a long-running in-cluster guard.

### Consequences

- **A dedicated cluster is required.** `ensure_marker` refuses clusters where the upstream namespaces exist without the ESB marker (`NOT_FRESH`). Sharing the cluster with other workloads is not supported as implemented.
- **Admission risk.** The Kyverno policies use `failurePolicy: Fail`. If Kyverno is unavailable, matching admissions (Pods in `ocm-wstack`, the Cassandra StatefulSet, the EnvoyProxy) are rejected.
- **Guard privileges.** The guard can read all Secrets in `ocm-wstack` and patch Deployments there. Its only cluster-scoped permission is reading one ResourceProvider.
- **Teardown retains everything cluster-scoped** (ADR-006).
- **Pinned component versions.** Versions of Kyverno, ESO, OpenBao, the operator and Argo CD follow the pinned upstream commit and the Argo CD commit. Updating them is an upstream re-review (ADR-006).

### Status

Implemented. **Proposed – to be confirmed by the principal.**

---

## ADR-011: Argo CD `server.insecure` behind the Envoy gateway

### Context

Operators may want browser access to the upstream Argo CD and Grafana. The tenant TLS certificate is uploaded by the operator (ADR-006). TLS is terminated at the Envoy gateway with Gateway API ListenerSets.

### Decision

The following applies only when `publicDashboards` is true (`deployment/runtime.sh › dashboard_install`):

1. **Argo CD in HTTP mode.** If `argocd-cmd-params-cm` does not contain `server.insecure: "true"`, the deployer patches it and restarts `deployment/argocd-server`. Argo CD then serves plain HTTP on its Service port 80.
2. **TLS secrets.** The uploaded TLS Secret `esb-<tenantRelease>-tls` is copied into namespaces `argocd` and `observability` (`network.sh › tls_install`).
3. **Routes.** Chart `charts-dashboards` (release `esb-dashboard-routes`) creates:
   - ListenerSets `esb-argocd` and `esb-grafana` on Gateway `infrastructure/envoy-gateway` (HTTPS, `tls.mode: Terminate`) for `argocd.<domain>` and `grafana.<domain>`;
   - HTTPRoutes to `argocd-server:80` and to the Grafana Service.
4. **Admin passwords.** The `admin` passwords are initialized once (`dashboard_admins`):
   - Argo CD stores a bcrypt hash of the editor password in `argocd-secret`;
   - Grafana's admin password is reset to the editor password.

When `publicDashboards` is false, the deployer uninstalls `esb-dashboard-routes` if it is present. It does not change `server.insecure`.

### Alternatives considered

- TLS passthrough to `argocd-server`, keeping Argo CD's own TLS.
- Re-encryption from the gateway to the backend (backend TLS policy).
- No public dashboards: access by `kubectl port-forward` only. This is the default (`publicDashboards: false`).
- SSO for Argo CD and Grafana instead of the local `admin` account.

### Consequences

- **Unencrypted in-cluster hop.** The hop from the Envoy gateway to `argocd-server` is plain HTTP inside the cluster. Any in-cluster client that can reach `argocd-server` also gets plain HTTP. Whether NetworkPolicies restrict this depends on the upstream Argo CD manifest and was not verified here.
- **The setting persists** after `publicDashboards` is turned off again, because the code contains no revert path.
- **Weak protection.** The dashboards become publicly reachable, protected only by the local `admin` username and password. That password is initially the editor password.
- **One certificate for everything.** The certificate must also cover `argocd.<domain>` and `grafana.<domain>` (`network.sh › tls_preflight`).

### Status

Implemented. **Proposed – to be confirmed by the principal.**
