# OCM W-Stack deployer 12.6.1

The ESB node deploys the XFSC native services and the OCM W-Stack UI. ORCE routes UI requests to native credential, issuance, verification, status and relationship services. MongoDB stores UI accounts, roles, sessions, preferences and operation metadata.

## Deployment outputs and full log

1. **Result** (`ocm-wstack/result`): the final structured result with access URLs and DNS records.
2. **Progress** (`ocm-wstack/progress`): phases, command start/end events, exit codes,
   recovery attempts and a heartbeat every 10 seconds while the operation runs.
3. **Full log** (`ocm-wstack/log`): one plain-text `msg.payload` on completion,
   including failures. It contains the command arguments, working directories,
   time budgets, stdout, stderr, exit codes, progress events and final result.
   Each captured command has its own ID so nested hooks and lease renewal remain distinguishable.
   Binary output containing NUL bytes is represented as base64.

Wire output 3 to a File node, or inspect it in Debug. Debug may shorten its display;
the message itself is not truncated. `msg.filename` points to the retained full log
under `/data/ocm-deployer-logs/<operation>/deployment.log` (or the configured ORCE
user directory). Files have mode 0600 and operation directories mode 0700.
The raw command files are retained alongside the transcript. Existing result and
progress wires keep their positions; add a third wire after updating the palette node.

**Raw logs may contain credentials and Kubernetes Secret data. Keep output 3 and
its saved files private.** This output is intentionally unredacted. The deployer
does not explicitly dump credential files or enable shell tracing. Log files are
not automatically deleted. An interrupted command is marked as incomplete in the
transcript; closing the node retains the log on disk but cannot send to a closed flow.
An abrupt process termination cannot emit a final message. On the next trigger,
the node reconstructs that run from retained files and emits its interrupted log
on output 3 before starting the requested action. `msg.recovered=true` identifies
that transcript; `msg.complete=false` indicates an interrupted or incomplete log.

Set **Log directory** to a persistent mounted directory when the ORCE user
directory is ephemeral. Files survive a replacement pod only when their storage
survives it. The node does not modify the hosting ORCE deployment or mount storage.

A deployment records each intended Helm operation in its owned installation marker
before making the Helm write. After a lost response or a process restart, it reads
the existing release and confirms the recorded operation before deciding whether
a write is needed. Successful completion still requires the stack checks to pass.
See [deployment recovery](docs/DEPLOYMENT-RECOVERY.md) for the state transitions,
retry budgets, ownership checks and release acceptance matrix.

## Envoy traffic-policy reconciliation

The deployer checks the EnvoyProxy and its generated Service before writing.
Correct traffic-policy settings require no patch. After configuring the proxy,
it gives Envoy up to 30 seconds to update the Service before using a direct
fallback patch. Both `Cluster` and `Local` configurations are supported.

Fallback patches test the freshly read object UID and resourceVersion. After a
rejection, the deployer reads the object again: an already-applied value completes
the step, a confirmed concurrent change allows a rebuilt patch, and an unchanged
validation or authorization rejection stops with `GATEWAY_PATCH_REJECTED`.
Transport failures also require readback before another write. Each object has
at most five patch attempts and a reconciliation budget of the configured timeout,
capped at 180 seconds. Service ownership and the deployment lease are checked.

Output 2 reports `gateway-reconciliation`, controller waits and patch attempts.
Output 3 includes the generated patch and the patch command's verbose API exchange.
A final fresh Service read verifies traffic policy and refreshes the public DNS
address. This step does not alter Service ports, addresses, selectors or TLS.

## Argo CD installation and workload readiness

Argo installation uses the checksum-verified pinned manifest. The namespace and
52 prerequisite resources are applied first. Every prerequisite must be readable
before the seven Deployment/StatefulSet resources are applied. Missing ConfigMaps
remain pending and the same prerequisite manifest is reapplied at most once every
30 seconds within the configured installation budget. Existing generated Secret
data is retained. Every write checks API readiness and the deployment lease.
Transport recovery uses at most five attempts for each apply invocation. The
uploaded kubeconfig is used throughout.

All seven Argo workloads share one readiness deadline. Grafana, ESO, Kyverno,
OpenBao and the Kubernetes operator use the same JSON polling checks in bootstrap.
An earlier ProgressDeadlineExceeded condition is reported while the controllers
continue reconciling. Completion requires the current generation and all desired,
updated, ready and available replicas; StatefulSets also require matching revisions.
A missing component, empty selection, paused Deployment or incomplete rollout
cannot pass. API interruptions use the same remaining budget. Use a deployment
timeout of 1800 seconds for clusters with slow provisioning.

If workload readiness fails, output 3 includes pod conditions, container states,
previous termination details, recent warning events and bounded current/previous
container logs, including init containers. Diagnostic collection has a separate
60-second ceiling and preserves the original failure. Progress reports identify
blocking workloads and remaining time. The initial Argo admin Secret is not
required on subsequent runs: a ready existing Argo installation may have had its
initial password Secret removed after credential setup.

Kyverno recovery checks all four controllers through the same readiness mechanism
before changing a pending release record. Backup creation/copying and concurrent
release/lease checks remain in force.

## CRD and policy readiness

Kyverno CRDs and ClusterPolicies are polled through `kubectl get -o json` with
the uploaded kubeconfig. Missing objects, missing status, null/empty conditions,
and a False or Unknown required condition remain pending. Deployment proceeds
only when Established (CRDs) or Ready (ClusterPolicies) becomes True. When an
observed generation is supplied, it must match or exceed the resource generation.

The configured deployment timeout is the total wait budget. Each API request is
bounded to at most ten seconds; unsuccessful reads and pending conditions are
followed by up to three seconds between probes. Connection/readiness failures
use the existing retry classification and the same budget. A process termination
has up to three seconds of grace. TLS/configuration errors, malformed responses,
CRD name conflicts and terminating resources stop with a specific error.
Timeout results identify the resource, condition, last observed conditions and
last API failure category. Progress and output 3 retain each attempt.

## Kyverno bootstrap recovery

Before installing Kyverno, the deployer renders the pinned wrapper chart and
creates missing CRDs, service accounts and RBAC objects with Helm ownership.
Existing objects are preserved. CRDs must be established before Helm proceeds.

For a pending Kyverno bootstrap operation, recovery waits until the configured
operation timeout plus 30 seconds has elapsed. It requires the current deployment
lease, the expected wrapper and chart version, and no deployed or superseded
Kyverno revision. A successful prior revision stops automatic bootstrap recovery.

The deployer backs up the pending Secret, creates missing prerequisites from its
stored manifest, and waits for all four Kyverno controllers to become ready.
A resourceVersion-guarded update then marks the interrupted revision failed,
retaining history, before the normal Helm upgrade retries. This legacy Kyverno path also supports installations started before operation
records were introduced. Other pending releases require an exact recorded ESB
operation. No Helm record or CRD is deleted.

The node saves backups under `ocm-deployer-backups` in the ORCE user directory
(normally `/data`). Standalone Bash uses `ESB_RECOVERY_BACKUP_DIR` or a private
directory under `/tmp`. Progress identifies the backup path, resources created
and remaining pending-operation wait. Failed recovery preserves the pending state.

## API readiness and retries

The deployer uses the uploaded kubeconfig for every Kubernetes and Helm command.
Before a Helm install or upgrade it checks `/readyz`. DNS, connection,
API timeout, throttling, service-unavailable and readiness authentication or
authorization failures are retried for up to five minutes, capped at 30 probes.
Pauses increase from 2 to 4 to 8 seconds, then stay at 15 seconds. Progress events
report the next attempt, failure category and remaining recovery time.
Each probe has a 10 second request timeout and an outer 12 second process timeout
with a 3 second termination grace; an in-flight probe may finish after the window.
Certificate, configuration, local command and unclassified errors stop immediately.
A denied or failed probe must recover to a successful HTTP response before Helm
can proceed. The uploaded credentials and context remain bound to every call.

Helm transport failures receive up to five attempts, with 5, 15, 30 and 30 second
pauses. Each write is preceded by readiness, release-state and lease checks.
After a lost response, release reads are retried without repeating a completed
write. Interrupted operations recorded by this version can resume after their
original timeout and termination grace. Recovery verifies the owned installation
marker, active lease, release revision and operation label, saves the release
Secret, then conditionally marks that revision failed so Helm can retry. Unknown
pending operations remain untouched. There is a final read-only reconciliation
after the fifth write attempt.

Failure results include `diagnostics.history`: the step, namespace, release,
API server, reason, command exit code and attempt count. The bounded history retains the first Helm failure when later readiness
checks repeatedly fail. Raw response bodies and credentials
are excluded from the structured result and progress outputs. Output 3 contains raw command output. `diagnose-api` returns the reason and exit code for each failed
sample. Every node output retains the configured access URLs and discovered
DNS targets.

The runtime, UI and their seed archives remain at 12.5.11 in this deployer release.

## Source layout

- `ocmwstack.html`: node fields, credential uploads and help.
- `ocmwstack.js`: Node-RED registration, private input files, process cancellation and the three outputs.
- `deploy.sh`: deployment procedure and standalone command.
- `deployment/`: Bash helpers, JSON transformations, templates and the continuous native-service reconciler.
- `runtime/flows/`: domain flows; `runtime/flows.json`: generated deployment flow.
- `runtime/lib/modules/`: Auth, Credentials, ClearingCenter, Issue, Relationships and Provenance handlers.
- `ui/src/`: Vue components and EN/DE/FR catalogs.
- `runtime/uibuilder/orce/dist/`: UI runtime assets. The Vite build writes compiled assets here.
- `charts-runtime/`, `charts-gateway/`, `charts-dashboards/`: deployment charts.
- `docs/baseline/`, `docs/requirements.json`: specifications and acceptance criteria.

## Build and test

The deployment container needs Bash 5, Node.js, jq, curl, git, Helm 3.13 or newer, or Helm 4, kubectl, OpenSSL and the BusyBox utilities supplied by `ecofacis/xfsc-orce:2.0.15`. Run `bash deploy.sh check` to inspect the available tools. Python 3 with PyYAML and Helm are needed on the development host for recovery and chart tests.

```sh
npm install --ignore-scripts
npm run verify:source
npm test
npm run test:bdd
npm run test:recovery
npm run test:ui
npm run test:helm
```

The deployer uses `ecofacis/xfsc-orce:2.0.15` by default. Its init container installs the packaged runtime dependencies and compiles the Vue UI on the persistent volume. Follow [BUILD.md](docs/BUILD.md) for source verification and packaging. `npm run build:flows` regenerates the domain flow aggregate; `node scripts/build-flows.js --check` checks it against the source routes. [VALIDATION.md](VALIDATION.md) describes the checks.

## Install the deployment node

Install `orce-esb-ocmwstack-12.6.1.tgz` in the deployer's ORCE/Node-RED user directory, restart the deployer and configure the OCM-W-Stack node. Provide the cluster kubeconfig, domain, TLS certificate/key and initial UI/editor credentials. The ORCE base image field can keep its default.

Native startup refreshes missing claim-backed credentials through ESO and waits for current provisioning status. Progress events identify pending workloads and credential references. The guard stores its private state under `/state/guard`. Its DNS policy uses the cluster DNS Service selector and ready EndpointSlice
ports. The Service can be named `coredns`, `kube-dns` or another name. Runtime
DNS retains standard port 53 and adds only discovered alternate backend ports;
8053 is not assumed on other clusters. API requests use the discovered Kubernetes Service address with TLS verification for `kubernetes.default.svc`.

The configuration schema remains `procedureVersion: 12`. Existing node fields, encrypted credentials, action names and output topics are preserved. The deployer package is version 12.6.1. The runtime, UI and runtime chart are version 12.5.11.

Verification comparison accepts reordering of the complete expected provider-injected environment block. Missing, duplicate or changed entries remain visible. Signing-key preservation also normalizes an empty `data` map. Failure results are saved before lease cleanup; the node can recover them from its private operation directory and reports termination signals when no result exists.

A healthy `credential-verification-service-chart` Application may remain `OutOfSync` without blocking deployment. The ApplicationSet wait retains expected application counts and pinned revision checks. Final inspection reports the accepted difference in `acceptedSyncDifferences`; other applications still require synchronization and every application must be healthy.

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

The bootstrap, tenant chart and native ApplicationSets use deployment commit `c1ba65c23ffdd891b6edec3bd277fad32b097378`. See [the upstream integration notes](docs/UPSTREAM-12.5.0.md) for the reviewed service versions and routing configuration.

Full offline chart validation: `npm run test:charts -- --charts /path/to/deployment --output /path/to/results`. Use the dependency collection supplied with the release. The test renders the complete deployment plan for IONOS, Hetzner, DigitalOcean and generic configurations in install and upgrade modes.

## Public URLs and DNS records in node output

Every progress and result payload contains `access.urls` and `access.dns`.
DNS status is `pending` until this operation discovers public Gateway or
LoadBalancer addresses; then it is `discovered`. Records contain name, type
(A/AAAA/CNAME), and value. Dashboard URLs and records appear only when public
dashboards are enabled. Targets describe intended routing, not proof that DNS
has been configured or endpoints are reachable. Failures retain the most
recent discovered targets. Each new action starts with pending discovery.

## Clearing Center

Select the required Gaia-X credentials in the Clearing Center view to request a Loire compliance credential. The runtime verifies the signed authorization request, performs the OID4VCI exchange, verifies the returned credential signature and confirms storage. See [the API and deployment notes](docs/CLEARING-CENTER.md).
