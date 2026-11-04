<!-- SPDX-License-Identifier: Apache-2.0 -->

# OCM W-Stack: acceptance test checklist

This checklist is executed once per instance, on OSC and on IONOS, against the release that is handed over. The results and the evidence files form the test evidence of the handover.

## How to record the evidence

- Record before testing: instance URL, commit hash of the release, version of the deployer node, SHA-256 of the installed `orce-esb-ocmwstack-<version>.tgz`, date and tester.
- Write every BDD run to a new directory outside the repository (`run.py --output`). Keep `summary.json`, `behave.json` and the JUnit file.
- Take screenshots for the manual steps. Remove credentials, tokens and personal data before the files leave the team.
- Never put passwords, tokens or kubeconfigs into the evidence, e-mails or chats.
- A failed step is recorded as failed, with the error code and an issue in the repository. It is not repeated until it passes without a record.

## Steps

| No. | Area | What to do | Expected result |
|---|---|---|---|
| 1 | Reachability | Open `https://<host>/orce/`, `/orce/ui-api/v1/health/live`, `/orce/ui-api/v1/health/ready`, `/orce/ui-api/v1/auth/config` without logging in; call `/orce/ui-api/v1/credentials` without a session | UI page loads; `alive: true`; `ready: true` with all dependencies ok; `/credentials` returns 401 |
| 2 | Deployer | In the deployer's shell, run `bash deploy.sh check`; in ORCE, run the deployer actions `preflight`, `validate` and `diagnose-storage`; then run `deploy` again on the existing tenant | `validate` returns `ready` with internet verified; the repeated `deploy` keeps accounts, keys and stored credentials |
| 3 | BDD core | In the module directory, with `OCM_BASE_URL`, `OCM_USERNAME` and `OCM_PASSWORD` set as in the README: `python test/bdd/run.py --suite core --output <new dir outside the repository>` | 15 of 15 scenarios pass |
| 4 | BDD credential | Prepare one ldp_vc and one SD-JWT credential; run the suite twice, once per credential: `OCM_CREDENTIAL_ID=<id> python test/bdd/run.py --suite credential --output <new dir>` | 3 of 3 scenarios pass in each run |
| 5 | BDD clearing | Prepare the three Gaia-X input credentials (LegalPerson, VatID, Issuer) and their inputs file: `OCM_CLEARING_INPUTS_FILE=<file> python test/bdd/run.py --suite clearing --output <new dir>` | The compliance credential is received, verified and stored |
| 6 | Accounts and roles | First login of the admin with password change; wrong password several times; log in with the role `auditor` | Password change enforced; login rate limit applies; `auditor` cannot verify, revoke or delete (403, buttons hidden). The role `viewer` may verify |
| 7 | Issue and receive | Issue a DeveloperCredential and an SDJWTCredential; take the offer; receive and accept it (with transaction code if asked) | Credential appears in the list and is read back from storage. The error `RETRIEVAL_CREDENTIAL_FORMAT_UNSUPPORTED` for the JSON credential is recorded as a known limitation |
| 8 | Verify | Verify a valid ldp_vc and a valid SD-JWT; verify a modified copy; verify a Gaia-X jwt_vc_json credential | Valid; Invalid; Unsupported (known limitation) |
| 9 | Revoke | Revoke a credential issued by this tenant; check its status; verify it again | Recorded result. While the upstream Status List defects are open, the UI shows "Status not checked" or "not revocable"; this is recorded, not hidden |
| 10 | Remove | Delete the local copy of a credential | It disappears from the list; it is not revoked |
| 11 | Provenance | Open the provenance view of an issued and of a received credential | Issuer, holder and verification history are shown; relationships are linked |
| 12 | Clearing Center in the UI | Run the Loire flow in the UI from start to "stored"; interrupt one run and reopen the page | All phases are shown; the interrupted request is not repeated automatically; the history is kept |
| 13 | Relationships | Create an invitation, accept it, label it, block and unblock it, delete it; try to accept an invitation of the other instance | All actions work; the cross-instance invitation is rejected with `RELATIONSHIP_HOST_NOT_ALLOWED` (known limitation) |
| 14 | Live updates and languages | Watch a new offer arrive without reloading; check the audit log; switch between English, German and French | Offer appears live; actions are in the audit log; all three languages work |
| 15 | Accessibility | Keyboard-only run through login, list, detail and dialogs; axe in Chrome, Firefox, Safari and Edge, and Lighthouse in Chrome or Edge | Results entered in `docs/ACCESSIBILITY.md` |
| 16 | Resilience | Restart the ORCE pod and the MongoDB pod; interrupt the NATS connection | Service recovers without data loss; `ready` reports `degraded: true` while NATS is down |
| 17 | Security exposure | Record whether `/orce/editor/` is reachable from the internet; record the response headers of `/orce/` and of an API route | Reachable unless the restriction in the README Security notes was applied (Known limitation 6); headers recorded |
| 18 | Test offering endpoint | `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' https://<host>/test/offering/create` | 404 (the deployer does not render this route). A 400 with `identifier is required` means a route rendered by an older deployer version is still present and must be removed |

## Results

| No. | OSC: result | OSC: evidence | IONOS: result | IONOS: evidence |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |
| 8 | | | | |
| 9 | | | | |
| 10 | | | | |
| 11 | | | | |
| 12 | | | | |
| 13 | | | | |
| 14 | | | | |
| 15 | | | | |
| 16 | | | | |
| 17 | | | | |
| 18 | | | | |

### Run record

| Field | OSC (`ocm-osc.facis.cloud`) | IONOS (`ocm-ionos.facis.cloud`) |
| --- | --- | --- |
| Tested commit (branch or tag) | | |
| `orce-esb-ocmwstack-12.6.4.tgz` SHA-256 installed in the deployer | | |
| Deployer ORCE version | | |
| Kubernetes version / node pool | | |
| `validate` result (date) | | |
| BDD `core` (summary.json: passed/total) | | |
| BDD `credential` (two runs: ldp_vc, SD-JWT) | | |
| BDD `clearing` | | |
| BDD `refresh` | not run: no configurable refresh endpoint in this release | not run: no configurable refresh endpoint in this release |
| Accessibility ([ACCESSIBILITY.md](ACCESSIBILITY.md)) | | |
| Evidence location (outside the repository) | | |
| Tester / date | | |



Note: announced maintenance windows of a provider affect the single-replica pods; schedule the run outside them.
