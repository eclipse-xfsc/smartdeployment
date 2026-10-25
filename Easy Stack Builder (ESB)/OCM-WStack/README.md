# OCM-WStack ESB 11.0.5

This package extends the original `orce-esb-ocmwstack` Node-RED node in `Easy Stack Builder (ESB)/OCM-WStack`. It includes the deployer, runtime flows, BFF, Vue UI, translations, Helm chart, tests and source provenance. 

**For the login callback fix and runtime-only update, read `docs/CALLBACK-FIX-11.0.5.md`.**

**Upgrading after the Vault mount failure? Read `docs/VAULT-FIX-11.0.1.md`.**

Read `docs/READINESS.md` for deployment prerequisites and acceptance checks. Installation requires network access to the declared registries.

## Install on the existing ORCE deployer

1. Download `orce-esb-ocmwstack-11.0.5.tgz` and install it through the ORCE/Node-RED palette upload option. Alternatively copy it into the existing ORCE container and run:

   ```sh
   cd /data
   npm install /path/to/orce-esb-ocmwstack-11.0.5.tgz
   ```

2. Restart that ORCE instance, then add or reopen the **OCM-W-Stack** node. Node.js 18+ is required; Node 20+ is recommended by the runtime dependencies. The deployer needs bash, kubectl, Helm, jq, openssl and curl, as before.
3. Complete the existing Instance, Kubernetes/Domain and Keycloak/TLS inputs. Use an isolated test namespace for the first run. Leave the existing cluster-wide ingress management options disabled when using the shared controller.
4. In **ORCE Initial Credentials**, enter separate editor and OCM UI administrator credentials. Passwords must be 12–72 bytes. Supply UI email and optional names. Initial UI password change is required at first login. Existing passwords and role customizations are preserved on redeployment.
5. Embedded MongoDB is the default, with a **5Gi** PVC; ORCE uses **3Gi**. To use an external database, select **Use external MongoDB** and provide its connection string. The runtime uses database `ocm_ui`; the account needs CRUD and index creation there. The embedded test instance uses its own generated root credential; use a database account scoped to the UI database for persistent installations.
6. Add approved external issuer/offer hosts and remote OCM invitation hosts as comma-separated bare DNS names if needed. The local OCM context is always allowed. Clearing Center offer import defaults to `clearing.gaia-x.eu`; adjust to the actual issuer returned by your environment.
7. Deploy the flow and trigger the OCM-W-Stack node. It provisions the stack, Keycloak client/roles/user, ORCE runtime and MongoDB. It idempotently creates `nginx-orce-cluster` for the existing compatible ingress-nginx controller. Failure retains resources for inspection.
8. Open **`https://cloud-wallet.<domain>/orce/`**. No `ocm-ui.<domain>` DNS record is used. The internal Keycloak client ID remains `ocm-ui`.

The runtime editor is private and uses its separate initial credential. Access it when needed with:

```sh
kubectl -n <namespace> port-forward service/ocm-orce 1880:80
```

Then open `http://127.0.0.1:1880/_orce-editor/`. Protect the deployer editor itself using your existing ORCE administration settings. Deleting the ESB node retains its original uninstall behavior and can remove the deployed namespace; do not delete it merely to restart it.

## Runtime and UI

- Shared organizational OCM context; identity scope is taken from validated Keycloak claims.
- Credential search, details, decoded/raw view, native Signer verification, local StatusList2021 revocation, delete and declared chain resolution.
- Offer import (inline, deep link or approved HTTPS reference), pending offer acceptance/rejection, demo issuance through the configured NATS content plugin, offer copy and QR.
- DIDComm invitation creation, acceptance, listing, labels, block/unblock and removal.
- Atomic permissions and managed composite roles, assignments, last human manager protection, audit, preferences, health and counters.
- English, German and French; PKCE sign-in; browser tokens only in memory.
- Polling resynchronization; authenticated socket hints for local changes. Native upstream event observer mapping is not yet enabled.

The BFF API is `/orce/ui-api/v1`. Existing native OCM route configurations remain as in ESB 10.1.8. Credentials stay in native Storage. Mongo contains preferences, 72-hour operation metadata, encrypted offers/invitations, and 90-day audit metadata; it does not copy the credential inventory.

## Output change

Version 11 replaces plaintext `clientSecret` with `clientSecretRef: {namespace, name, key}` and adds `uiUrl`, `namespace`, runtime/release versions and the frozen reference SHA. Existing `ocmUrl`, `keycloakUrl`, `externalIp` and `status` remain. Update downstream flows using the old plaintext field. Do not connect credential retrieval commands to Debug nodes.

## Validation and packaging

```sh
npm test
npm run test:legacy
python3 test/config-regression.py # requires PyYAML
python3 scripts/build-runtime.py
npm pack --ignore-scripts
```

The build script embeds the exact runtime source into the seed ConfigMap. Init installs pinned direct npm dependencies on the ORCE PVC and copies Vue's runtime browser build; it requires outbound npm registry access. Helm dependencies and service images also require registry access. Record resolved dependency versions and image digests for the installation.

After deployment:

```sh
bash test/runtime-ui-health.sh <namespace> <domain>
# Optional third argument: path to a short-lived UI access-token file, mode 0600.
```

Use `docs/CLUSTER-ACCEPTANCE.md` for the live acceptance sequence. Source decisions, compatibility boundaries and exact upstream commits are recorded under `docs/`.
