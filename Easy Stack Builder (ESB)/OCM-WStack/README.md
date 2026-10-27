# OCM W-Stack 12.6.2

Deploys the XFSC native services and an OCM wallet implemented as Node-RED flows, with a uibuilder UI. The behavioral baseline is package 12.6.1. The implementation and installation layout have changed.

## Files

- `deploy.sh` and `deployment/*.sh`: deployment, validation, diagnostics and guarded recovery.
- `deployer-flow.json`: standard Function node replacing the custom deployment palette node; three outputs retain result, progress and full-log messages.
- `charts-runtime/files/flows.json`: wallet HTTP routes, Function nodes, business services and uibuilder node.
- `charts-runtime/files/ui/`: `index.html`, `index.js`, `index.css`, `facis-logo.svg`.
- `charts-*`, `deployment/templates` and `upstream-lock.json`: Helm resources, configuration and the unchanged upstream revision/checksums.

There is no custom backend module, Docker build, Vue compiler/build step or npm palette package in this source tree. The UI uses the installed Vue runtime through `/orce/vendor/vue.js`; its editable application source is `index.js`. Third-party runtime dependencies still install through npm. Their own internal filenames are outside this project's source whitelist.

The chart initialization container installs `flows.json` at `/data/flows.json` and the UI at `/data/uibuilder/orce/src/`. It generates the Node-RED settings and the small uibuilder middleware registration hook required by those products. Authentication and business logic live in named Function nodes in `flows.json`. Prepared releases are published through `/data/current`. Existing MongoDB/PVC data and retained Secrets are preserved; an independently managed flow volume is refused.

## Command-line deployment

Run on the same supported Linux deployment host with Bash, Node.js, npm, jq, curl, Git, Helm, kubectl, OpenSSL, coreutils, setsid, nc and busybox. The deployed Node.js requirement remains 20.19+ or 22.12+. Use the existing private deployment configuration, kubeconfig and TLS files.

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

The same options apply to `install-ui`, `repair-ocm`, `repair-network`, `inspect`, `validate`, `diagnose-auth`, `diagnose-api`, `diagnose-storage`, `test-credentials` and `teardown`. The last two retain their explicit `--confirm` requirement. Run `bash deploy.sh --help` for the interface. stdout contains the JSON result; stderr contains progress.

Minimal configuration (replace the example domain and tenant):

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

For an initial deployment, the private credentials JSON must contain `editorPassword` and `uiAdminPassword`: at least 12 characters, at most 72 UTF-8 bytes, no control characters. Existing installation credentials and application encryption keys are retained. Do not commit credentials, kubeconfigs, certificates, exports or logs. Password hashing uses bcrypt cost 12; its helper resolves the installed library or installs bcryptjs 2.4.3 in the user's cache.

## Node-RED deployer

The former custom palette-node editor is replaced by tab configuration and a standard Function node. Stop the hosting Node-RED process before running this installer. Use paths visible inside that process's filesystem; keep this package at its permanent location.

```bash
chmod 600 /private/credentials.json
bash install-deployer.sh /data flows.json \
  /private/deployment.json /private/credentials.json
```

Restart Node-RED with `/data/settings.js`. The installer preserves its existing settings and unrelated flows. It adds the `OCM deployer` tab and its required standard-library context. It does not remove existing custom palette nodes. Reconnect their three output wires to `OCM deployment action`, then remove the obsolete instances and package through Node-RED.

Set `msg.action` to the deployment action; the default is `deploy`. Use `msg.confirm` for actions requiring confirmation. Configuration and credentials are read from the tab's configured file paths, never taken from incoming messages. Full deployment logs remain private and may contain credentials or Kubernetes Secret data.

The wallet flow starts from `OCM initialization`, initializes named services in dependency order, then connects MongoDB and NATS. Use a full flow deploy after editing initialization functions. There are separate tabs for authentication, credentials, issuance, relationships, provenance and clearing. The manual identity-migration Function accepts `msg.mode="prepare"` with `msg.payload={export,hashes}` and `msg.tenant`; applying its output requires `msg.mode="apply"` and `msg.confirm="apply-identity-migration"`. Do not wire migration inputs or credential exports to public HTTP or Debug nodes.

## Verification status

The conversion was checked with 123 existing backend regression tests against the Function-node code, 288 deployment cases (including reruns of relocated-fixture and timing-sensitive checks), script/Function syntax checks, flow wiring checks, source-whitelist checks and installer simulations. The original upstream patch, jq programs and Cassandra recovery program/schema are byte-preserved. Gateway, dashboard, MongoDB and NetworkPolicy definitions retain their baseline content.

A real Node-RED/uibuilder startup, browser UI test, Helm rendering and live Kubernetes deployment have **not** been completed in the build environment. npm access was denied and Helm was unavailable. This package is a locally checked conversion, not a claim of completed live acceptance.

Before replacing a working installation, validate in a disposable environment using the same ORCE image and configuration: startup/readiness; login, logout and password change; roles/users; list/import/issue/accept/verify/revoke/delete; relationships; provenance; clearing; socket reconnect; process restart; repeated installation. Retain the existing deployment until those checks pass. No cluster was modified while creating this package.

## Preserve development history while removing confidential files

Use `prepare-history-preserving.sh SOURCE_REPO NEW_CLONE` from the archive. It clones the inspected branch into a new directory, leaving the original checkout and all uncommitted changes untouched. It removes confidential documents, root release archives and documentation/Docker clutter from the PR's commits. Historical executable code is retained; the current source tree uses the cleaned flow implementation.

Every existing PR commit is retained, including commits that become empty. Authors, author/committer dates, messages, parent relationships and outside-scope file trees are checked. Commit hashes necessarily change for rewritten commits and their descendants; old cryptographic commit signatures cannot remain valid. The inherited upstream base remains unchanged. The refactor is appended as one new ordinary commit.

The helper requires source branch `ocm-wstack/ocm-cr` at `98c0eaff2ff2104fa7c57886e8aafb55d75990a2`. A mismatch stops the procedure. It does not push.

After inspecting the new clone and validating the implementation, push only its branch using the explicit force-with-lease shown in the accompanying chat instructions. Then run `purge-rewritten-objects.sh NEW_CLONE`. It verifies the remote tip, removes only the known filter-branch backup and updates the matching tracking ref, refuses remaining references to obsolete commits, and expires local reflogs/prunes old objects. The rewritten development commits stay reachable.

The original checkout still holds the old history. Old source exports, bundles, release archives and GitHub PR/cached objects are separate copies. Keep them private and clean them deliberately after verifying the new checkout; request GitHub Support cleanup for PR #7 and cached confidential objects. Neither a force-push nor cleaning one clone proves complete erasure.
