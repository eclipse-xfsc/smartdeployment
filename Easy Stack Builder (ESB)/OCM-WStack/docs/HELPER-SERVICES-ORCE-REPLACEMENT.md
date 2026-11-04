<!-- SPDX-License-Identifier: Apache-2.0 -->

# OCM W-Stack: helper services replaceable by ORCE, with effort calculation

| Item | Value |
|---|---|
| Change request | CR01, item 2 (FACIS ESB ICAM, contract identifier `FACIS.ESB_ICAM`) |
| Principal | eco – Association of the Internet Industry |
| Module | ESB `OCM-WStack`, package `orce-esb-ocmwstack` 12.6.4, on the branch of the follow-up pull request based on commit `e5c7b44` |
| Upstream baseline | `eclipse-xfsc/deployment` commit `c1ba65c23ffdd891b6edec3bd277fad32b097378` (`upstream-lock.json`, reviewed 2026-10-26) |
| Basis of this document | Code inspection on 31 October 2026. Nothing was deployed or executed for it. |
| Status | Contractor's estimate, delivered with the CR01 handover; the figures are confirmed by the module author before the handover |

Marker used in this document: **[unverified]** means the statement is based on reading code or descriptions only and has to be confirmed on a running system or with the upstream maintainers before implementation starts.

## 1. Purpose and scope

### 1.1 Requirement

CR01 (form dated 29-04-2026) asks to "extend the current deployment via ORCE extension" and contains, as item 2:

> "2) Identify helper services of OCM-W Stack to be connected/ replaced by ORCE services and provide an effort calculation (Deployment Efficiency Enhancement)"

(Wording taken from the CR01 PDF. The PDF text layer splits words with extra spaces; only whitespace was normalised.)

The RfQ "FACIS ESB Change Request OCM" lists only the UI-related areas (CR01 item 1). It does not mention helper services. For the form of the estimate it asks for a "Formal Quote with break down per requirement and enumeration of Project Days". Section 4 follows this.

CR01 does not name the helper services. The selection below is the contractor's interpretation (section 1.2).

### 1.2 Interpretation

- **Helper service:** a workload deployed by this module that is not a system of record for credentials or connections, not a cryptographic or OAuth trust component, and not shared infrastructure. Examples: glue adapters, bootstrap and registration jobs, demo plugins, workaround controllers.
- **Connected:** the service stays native and ORCE uses it through its HTTP or NATS interface.
- **Replaced:** the workload is removed from the deployment and an ORCE flow provides the same function.
- **Deployment efficiency:** fewer workloads, container images, scheduled jobs, public routes and workaround logic, without lowering protocol conformance or security.

### 1.3 In scope and out of scope

In scope: every OCM W-Stack workload that this module deploys (section 2), assessed against the dedicated application ORCE (`ocm-orce`, namespace `ocm-wstack`).

Out of scope: CR01 item 1 (UI, delivered separately), infrastructure components, the Deployer ORCE node and its Bash scripts, PCM, and changes to upstream source code (section 5.4).

### 1.4 Sources inspected

- This module: `upstream-lock.json`, `deployment/cluster.sh` (`chart_plan`), `deployment/assets.sh` (`tenant_values`, chart contracts), `deployment/reconcile.sh`, `deployment/checks.sh` (`test_credentials`), `deployment/templates/*`, `charts-*/templates/*`, `charts-runtime/files/flows.json`, `README.md`.
- Upstream `eclipse-xfsc/deployment` at the pinned commit: `OCM W-Stack/*` charts, `XFSC/Applicationsets/values/06_ocm_wstack-values.yaml`, `XFSC/tenant/chart`, `OCM W-Stack/Tools/offering`.
- Upstream service repositories in `eclipse-xfsc` (README, source tree and file sizes at the pinned image tags): `oid4-vci-issuer-dummycontentsigner` v2.4.3, `oid4-vci-authorization-bridge` v2.5.7, `oid4-vci-vp-well-known-service` v1.5.2, `sd-jwt-service` v1.2.13, `oid4-vci-issuer-service` v1.9.2 (NATS dependencies only).

The mapping from chart to source repository is made by component name and README. It was not checked against image provenance. **[unverified]**

## 2. Inventory of deployed OCM W-Stack services

### 2.1 How the module deploys them

`chart_plan` (in `deployment/cluster.sh`) creates the upstream ApplicationSet `ocm-wstack` over `OCM W-Stack/*`. Upstream excludes `tenant`, `Policies`, `Tools` and `Didcomm`. The ESB removes `Didcomm` from the exclude list unless an external DIDComm service is configured in `runtimeServices.didcomm`. The ESB also installs the upstream tenant chart (`XFSC/tenant/chart`, with routes from `tenant_values`), its own gateway and dashboard charts, the guard (`deployment/templates/reconciler.json`) and the application ORCE (`charts-runtime`).

### 2.2 OCM W-Stack services

| No. | Chart (upstream) | Component / repository | Pinned image | Function | Class |
|---|---|---|---|---|---|
| S1 | Credential Issuance | issuance-service / `oid4-vci-issuer-service` | 1.9.2 | OID4VCI issuer frame: credential and nonce endpoints, calls the issuer plugin | Core |
| S2 | Credential Retrieval | `oid4-vci-credential-retrieval-service` | 1.1.7 | Holder side of OID4VCI: receives offers, accepts and retrieves credentials (Cassandra) | Core |
| S3 | Credential Verification Service Chart | `oid4-vci-credential-verification-service` | 1.2.2-alpha | OID4VP verifier (Cassandra) | Core |
| S4 | Crypto Service | signer / `crypto-provider-service` (TSA) | 2.3.8 | Signing and verification with OpenBao transit keys; serves `did.json`, DID list, DID configuration, JWKS | Core (crypto) |
| S5 | Status List Service Chart | `statuslist-service` | 1.5.0 | Revocation and suspension status lists | Core |
| S6 | Storage Service | `credential-storage-service` | 1.3.3 | Credential and presentation storage (system of record) | Core |
| S7 | Didcomm (conditional) | didcomm-connector / `didcomm-v2-connector` | `latest` | DIDComm v2 mediator, connections and relationships | Core |
| S8 | Pre Authorization Bridge Chart | `oid4-vci-authorization-bridge` | 2.5.7 | OAuth token endpoint for the pre-authorized code grant; codes in Redis | Protocol helper |
| S9 | Well Known Chart | `oid4-vci-vp-well-known-service` | 1.5.2 | Issuer metadata (`/.well-known/openid-credential-issuer`), NATS metadata lookup (PostgreSQL) | Protocol helper |
| S10 | SdJwt Service | `sd-jwt-service` | 1.2.13 | SD-JWT encoding and disclosures | Crypto helper |
| S11 | Policy Chart | TSA policy / `custom-policy-agent` | 1.1.2 | Rego policy evaluation; policies cloned at runtime from `eclipse-xfsc/rego-policies` | Policy helper |
| S12 | Dummy Content Signer | `oid4-vci-issuer-dummycontentsigner` | 2.4.3 | Demo issuer plugin: prepares the two demo credentials, tenant registry, metadata publisher, SD-JWT type metadata | Demo helper |
| S13 | Offering Dummy | credential-offering-bootstrap (`deployment/OCM W-Stack/Tools/offering`) | `dev` | REST to NATS adapter that starts a credential offer | Glue / demo helper |

### 2.3 Other workloads deployed with the stack

| No. | Workload | Source | Function | Class |
|---|---|---|---|---|
| T1 | Tenant registration Job (Helm post-install/post-upgrade hook) and CronJob (`*/15 * * * *`), image `curlimages/curl:8.16.0` | Upstream tenant chart | `PUT /internal/tenants/{tenant}` on the dummy content signer | Bootstrap helper |
| T2 | OpenBao transit bootstrap Job | Upstream tenant chart | Creates the tenant transit mount and key `eckey` | Bootstrap helper (security) |
| T3 | Tenant HTTPRoutes and ListenerSet | Upstream tenant chart, routes set by `tenant_values` | Public routing with `X-*` tenant headers | Configuration, not a service |
| E1 | `esb-ocm-guard` Deployment | ESB (`reconcile.sh`) | Keeps injected Redis credentials and NATS listeners of S8/S9 consistent; restarts S9 when its NATS listener is lost | ESB workaround helper |
| E2 | Kyverno ClusterPolicies (`charts-gateway`) | ESB | Admission mutations: Envoy traffic policy, startup probes, Recreate strategy, host aliases | Configuration, not a service |
| E3 | `ocm-orce` and MongoDB | ESB (`charts-runtime`) | Application ORCE: UI, API, accounts, audit | Target platform of this CR |

Infrastructure (out of scope): NATS, Redis, Cassandra, PostgreSQL (operators and instances), universal resolver, OpenBao, External Secrets, Kyverno, XFSC kubernetes-operator, cert-manager, Envoy Gateway, external-dns (optional), observability stack, Argo CD.

### 2.4 What the application ORCE already does itself

| ORCE function (`flows.json`) | Done by ORCE itself | Delegated to |
|---|---|---|
| Issuance (`POST /orce/ui-api/v1/issuance`, library `events`) | Builds the CloudEvent `issuance.request` and sends a NATS request to the plugin subject (for example `issuer.dummycontentsigner.request`). **This is the same contract as S13.** | S12 (plugin), via NATS |
| Credential type catalogue (`registry`, `events.types`) | Merges native types with types stored in MongoDB | S9, NATS `wellknown.issuer.metadata` |
| Issuer tenant registration (`issuer-bootstrap`) | Can `GET` and `PUT /internal/tenants/{tenant}`. The `PUT` is switched off because `runtime-config.json` sets `managedUpstreamTenant: true`. | Currently T1 |
| Status check and revocation | Request and reply validation | S5: NATS `status.data`, HTTP `/status/.../revoke` |
| Verification | Result handling | S4 `/v1/credential/verify` |
| Browse, delete, import | Scoping, paging, audit | S6 HTTP |
| Offers list, accept, reject | Encrypted recovery copy until storage is confirmed | S2 HTTP, NATS observer `retrieval.offering.publication` |
| Relationships | Filtering and actions | S7 `/admin/connections` |
| Gaia-X clearing | Full OID4VP/OID4VCI exchange with the Dispatcher | S4, S6 for verification and storage |
| Accounts, roles, sessions, audit, jobs | Entirely (MongoDB `ocm_ui`) | – |
| Readiness | Probes S6, S2, issuer registration, S7 and NATS every 20 s | – |

ORCE does not hold signing keys. All signatures are made by S4 with OpenBao transit keys. This stays so in every option below.

### 2.5 Not deployed by this module

`email-service`, `event-log-service`, `configuration-service`, `redis-cache-service`, the PCM cloud wallet plugins, TSA cache/task services and the notarization service are not part of the pinned `OCM W-Stack/*` set or the ESB charts. They are not assessed. The upstream test scripts in `OCM W-Stack/Tools/scripts` are excluded upstream. Their ESB counterpart is the `test-credentials` action (covered under H1).

## 3. Assessment of the helper services

### 3.1 Summary

| ID | Helper | Replaceable by ORCE | Recommendation |
|---|---|---|---|
| H1 | Offering Dummy (S13) | **Yes** | Replace (wave 1) |
| H2 | Tenant registration Job and CronJob (T1) | **Yes** | Replace (wave 1) |
| H3 | Dummy Content Signer (S12) | **Yes**, after a protocol spike | Replace (wave 2) |
| H4 | Well-Known Service (S9) | **Partly** | Optional (wave 3), only after H3 |
| H5 | Pre-Authorization Bridge (S8) | **No** | Keep; connect for health only |
| H6 | SD-JWT Service (S10) | **No** | Keep; connect for health only |
| H7 | Policy Service (S11) | **No** | Keep; connect for health only |
| H8 | ESB guard (E1) | **Partly** (technically) | Keep, not recommended for ORCE |
| H9 | OpenBao transit bootstrap Job (T2) | **No** | Keep |

C1 in section 4 (health connection of H5 to H7 and of the native services that ORCE does not probe yet: S1, S3, S4, S5) is the "connected" part of the requirement. Which health endpoints these services offer was not checked. **[unverified]**

### 3.2 H1 – Offering Dummy (credential-offering-bootstrap)

- **Function:** `POST /api/createOffering` and `POST /api/offering/create` take an XFSC `IssuanceRequest`, send it as CloudEvent `issuance.request` to NATS `issuer.dummycontentsigner.request` (10 s timeout) and return the `IssuanceReply` with the offer. Health: `GET /health`, `GET /isalive`.
- **Size:** about 5 KB of Go (handler and NATS client), 3 KB of tests.
- **Interfaces:** HTTP 8080. The upstream tenant values declare a public route `POST https://<tenant>/test/offering/create` under `routes:`; ESB releases before 12.6.4 rendered it through the mapping `$defaults.routes // $defaults.ocm_issuer` in `tenant_values`. Since 12.6.4 the deployer leaves that route out of the rendered tenant values (`deployment/assets.sh`), and `test-credentials` reaches the service through a localhost port-forward. Outbound NATS.
- **State:** none.
- **Security relevance:** high in releases before 12.6.4. The route had no authentication in the ESB charts, a missing `tenant_id` fell back to a default tenant, and anyone who could reach the tenant host could create offers for the demo credential types with free claim values, signed with the tenant issuer key (`did:web:<tenant host>`). This was confirmed on both FACIS instances on 1 November 2026 and the route was removed there by hand; 12.6.4 no longer renders it. The image tag `dev` is mutable.
- **Can ORCE replace it: Yes.** ORCE already implements the identical NATS call in `events.issue()`, behind login, CSRF protection, the permission `credentials.issue`, claim validation and audit. The only remaining user of S13 in this module is the Deployer action `test-credentials` (`deployment/checks.sh`).
- **ORCE flows needed:** no new user-facing flow. A loopback-only diagnostic endpoint for `test-credentials`, following the existing `/_ocm/storage-diagnostics` pattern (reachable only through a port-forward), or a switch of `test-credentials` to the authenticated API.
- **Deployment changes:** add `OCM W-Stack/Offering Dummy` to `ocmExcludes`; switch `test_credentials` from the port-forward to ORCE; clean up the Argo CD application on upgrade. The removal of the public route and the port-forward for `test_credentials` are already part of 12.6.4.
- **Dependencies:** NATS; S12 (or H3).
- **Risks:** external users or scripts may rely on `/test/offering/create` (eco to confirm); Argo CD prune behaviour for the removed application. **[unverified]**

### 3.3 H2 – Tenant registration Job and CronJob

- **Function:** a `curl` container sends `PUT http://dummycontentsigner:8080/internal/tenants/<tenant>` with `credentialIssuer`, `authorizationServers`, `credentialEndpoint`, `nonceEndpoint`, `statusEndpoint` and `schemaEndpoint`. It runs once as a Helm hook and then every 15 minutes (96 job pods per day), because the dummy content signer keeps the registry in memory only.
- **Interfaces:** outbound HTTP to S12 only. **State:** none in the job; the target state is in S12 memory.
- **Security relevance:** medium. `/internal/tenants` on S12 has no authentication and is reachable only inside the cluster. A wrong registration changes the published issuer metadata.
- **Can ORCE replace it: Yes.** The class `IssuerBootstrap` in `flows.json` already checks the registration every 30 s and can register when it is missing. Two gaps: the ORCE body lacks `nonceEndpoint`, `statusEndpoint` and `schemaEndpoint`, and the comparison ignores these fields. Without fixing both, switching to `managedUpstreamTenant: false` would publish incomplete metadata.
- **ORCE flows needed:** extend the `issuer-bootstrap` library (full body, full comparison, defined handling of conflicts); keep the 30 s cycle; report the state in `/health/ready`.
- **Deployment changes:** `tenantRegistration.enabled: false` in the tenant values; `managedUpstreamTenant: false` in `runtime-config.json`; remove the existing Job and CronJob on upgrade.
- **Dependencies:** S12, or none after H3 (the registry then lives in ORCE).
- **Risks:** while ORCE is down, a restarted S12 is not registered again. Issuance needs ORCE anyway, but redemption of offers that were created before must still work. Issuer metadata that was published before stays in S9 (PostgreSQL). **[unverified]** whether S9 keeps it when the registration stops.

### 3.4 H3 – Dummy Content Signer (issuer plugin)

- **Function** (v2.4.3, 15 Go files, about 46 KB including 9 KB of tests):
  1. NATS replier `issuer.dummycontentsigner.request`: receives `IssuanceRequest`, asks S1 for an offer (`credential.offer.url`, pre-authorized code grant, two-factor off), stores the prepared credential under the code, replies with the offer.
  2. NATS replier `issuer.dummycontentsigner.issue`: receives `IssuanceModuleReq` with the code, loads the prepared credential, sets issuer `did:web`, holder, status list type and, for SD-JWT, `vct`, has it signed by S4 (`SIGNER_CREDENTIAL_URL`, with `x-origin`, `x-tenantid`, `x-groupid`), and replies.
  3. Every 30 s it publishes one issuer registration per tenant (two fixed configurations: `DeveloperCredential` as `ldp_vc`, `SDJWTCredential` as `dc+sd-jwt`) on NATS `wellknown.issuer.registration`.
  4. HTTP: `/internal/tenants/{id}` (PUT/GET/DELETE), SD-JWT VC type metadata under the schema path (public through `/api/schema`), `/health`.
- **State:** prepared credentials and the tenant registry, both in memory. They are lost on restart, which is why T1 and its CronJob exist.
- **Security relevance:** high. The service is on the issuance path and decides credential content. Signing stays in S4. The upstream code logs the full credential before signing, which puts personal claim data into the logs.
- **Can ORCE replace it: Yes, after a spike.** Every function is message handling, HTTP calls and storage, which ORCE already does (NATS client 2.29.2, MongoDB, HTTP client). No key material moves to ORCE. Benefits: persistent and encrypted storage of prepared credentials (existing AES-256-GCM key) instead of memory; the tenant registry in ORCE, which makes H2 unnecessary; no claim data in logs; and a later basis for issuing the ORCE-defined business types, which today show `ISSUER_TEMPLATE_UNAVAILABLE` (not included in the estimate).
- **ORCE flows needed:** a NATS request/reply foundation (C0); two repliers; a metadata publisher; a tenant registry; a type metadata HTTP endpoint; a prepared-credential store with TTL and single use.
- **Deployment changes:** exclude the chart; point the `vctschema` route (`/api/schema`) to ORCE; remove `issuerBootstrapUrl`; T1 off; a switch back to the native S12 until acceptance.
- **Dependencies:** NATS, S1, S4, S9 (as consumer of the registration), MongoDB.
- **Risks:** exact compatibility with the message types of `nats-message-library` and `oid4-vci-issuer-service` at the pinned versions; the signer request contract (status flags, `nonce`, format-specific response); interoperability with wallets and S2; ORCE (one replica, Recreate strategy) becomes part of the redemption path; NATS subject access control was not checked, and today any NATS client can send to the plugin subjects. **[unverified]**

### 3.5 H4 – Well-Known Service

- **Function** (v1.5.2, 21 Go files, about 56 KB, no tests): stores issuer metadata from the broadcast importer (NATS, from plugins) or a Git importer in PostgreSQL; serves `/.well-known/openid-credential-issuer` (tenant path rewrite, optional header enrichment); answers NATS `wellknown.issuer.metadata`, which S1 uses during issuance and ORCE uses for the type catalogue.
- **State:** PostgreSQL. **Security relevance:** medium to high. The metadata is public and decides which configurations wallets and S1 accept.
- **Can ORCE replace it: Partly.** ORCE can take the registration subscription, the metadata replier and the public endpoint for the configurations that this module uses. The Git importer, the verifier metadata and full header enrichment would not be rebuilt. After H3 the metadata source is ORCE itself, which makes the replacement simpler. The guard (E1) currently restarts S9 when its NATS listener is lost. That workaround would no longer be needed.
- **ORCE flows needed:** registration subscriber with MongoDB persistence; NATS replier `wellknown.issuer.metadata`; public metadata endpoint.
- **Deployment changes:** exclude the chart; point the HTTPRoute `openid-credential-issuer` to ORCE; remove the S9 branch from the guard; remove the PostgreSQL resource claim only if no other consumer exists. **[unverified]** In the ESB overrides only S9 declares a PostgreSQL need; upstream defaults of other charts were not checked.
- **Dependencies:** NATS, H3 (recommended), S1 as consumer.
- **Risks:** OID4VCI metadata conformance; S1 depends on the reply format; public endpoint caching; the efficiency gain depends on whether PostgreSQL can be removed.

### 3.6 H5 – Pre-Authorization Bridge

- **Function** (v2.5.7, about 55 KB of Go): OAuth 2.0 token endpoint for `urn:ietf:params:oauth:grant-type:pre-authorized_code` (public `POST /api/auth/token`, `/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server`); NATS `auth.authorization.generate` and `auth.authorization.validate` for S1; codes, PINs and nonces with TTL in Redis; access tokens signed through S4.
- **Can ORCE replace it: No.** It is an authorization server component on the public internet. A low-code reimplementation would need the same depth of review as a new authorization server. The deployment would still need Redis or an equivalent store. The efficiency gain (one Deployment) does not justify the risk.
- **Connect:** include in ORCE readiness (C1).

### 3.7 H6 – SD-JWT Service

- **Function:** creates and verifies SD-JWT encodings with disclosures (one JavaScript file, about 15 KB).
- **Can ORCE replace it: No.** Cryptographic encoding belongs in a dedicated, reviewed service, not in Function nodes of an internet-facing UI runtime. Which native service calls it was not traced. **[unverified]**
- **Connect:** include in ORCE readiness (C1).

### 3.8 H7 – Policy Service

- **Function:** evaluates Rego (OPA) policies over HTTP and NATS. Policies are cloned at runtime from `eclipse-xfsc/rego-policies`.
- **Can ORCE replace it: No.** ORCE has no Rego engine. A replacement would change policy semantics. The runtime dependency on GitHub is a deployment risk, but it is solved by pinning or mirroring the policy repository, not by ORCE.
- **Connect:** include in ORCE readiness (C1).

### 3.9 H8 – ESB guard (`esb-ocm-guard`)

- **Function:** a Bash loop in the ORCE base image. It reads Deployments, Secrets, ResourceClaims and ExternalSecrets, reads the Redis admin Secret in `infrastructure`, patches Deployment annotations to roll out credential changes, checks NATS subscriptions of S8 and S9 and restarts S9 when needed. It has a read-only source volume and a memory-backed state volume.
- **Can ORCE replace it: Partly, not recommended.** The logic could run as flows. In the application ORCE it would give an internet-facing runtime Kubernetes Secret access and the right to patch Deployments. A separate headless ORCE instance would keep the isolation but add a workload, so there is no efficiency gain. The S9 branch disappears with H4. The rest should be removed when the upstream operator handles credential rotation.
- **Indicative effort (not in the totals):** about 8 PD for a separate headless instance.

### 3.10 H9 – OpenBao transit bootstrap Job

- **Can ORCE replace it: No.** It needs an OpenBao Kubernetes-auth role that can create transit mounts and keys, and it must run in Helm hook order before the signer uses the key. Moving it to ORCE would put key-management rights into the application runtime.

## 4. Effort calculation

All figures are the contractor's estimates in person days (PD), based on code inspection on 31 October 2026. They are planning figures for the CR01 realisation proposal, not measured values.

### 4.1 Assumptions

1. Baseline: this module at release 12.6.4 (the follow-up pull request to `e5c7b44`) and the upstream versions pinned in `upstream-lock.json`. Upstream changes after 31 October 2026 can change the effort.
2. Implementation in the existing application ORCE, as libraries in the `OCM initialization` tab plus new flow tabs. No new ORCE instance, no new image, no compiled code.
3. Like-for-like parity with the pinned upstream services. For H3 these are the two demo configurations `DeveloperCredential` and `SDJWTCredential`. Issuing the ORCE-defined business types is an option and is not estimated.
4. The native core services (S1 to S7) stay unchanged. No upstream pull requests are needed. Message contracts are taken from the pinned libraries.
5. One existing FACIS test cluster with this ESB deployment is available. The tests use the existing Behave setup (`test/bdd`).
6. Work by one engineer who knows ORCE and OCM W-Stack. A second person does the security review. No external penetration test.
7. 1 PD = 8 hours. Project management, meetings with eco and waiting time for third parties are not included.
8. Each wave keeps a configuration switch back to the native service until eco accepts the wave. This is included in "deployment changes".
9. Contingency: 20 % for wave 1 (small, known code paths) and 30 % for waves 2 and 3 (contracts to be reverse-engineered, wallet and issuer interoperability).
10. Documentation is in English, in the repository (`README.md` and `docs/`).

### 4.2 Effort per item (PD)

| ID | Work package | Analysis | Flow implementation | Tests (BDD) | Security review | Documentation | Deployment changes | Base | With contingency |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| H1 | Offering Dummy → existing ORCE issuance; `test-credentials` via loopback endpoint | 0.5 | 1.0 | 1.0 | 0.5 | 0.5 | 1.0 | 4.5 | 5.4 |
| H2 | Tenant registration → ORCE `issuer-bootstrap` | 0.5 | 1.0 | 1.0 | 0.5 | 0.5 | 1.0 | 4.5 | 5.4 |
| C1 | Connect H5 to H7 and the native services not probed yet (S1, S3, S4, S5) to ORCE readiness | 0.25 | 1.0 | 0.5 | 0.25 | 0.25 | 0.25 | 2.5 | 3.0 |
| – | Wave 1 integration: fresh install, upgrade from 12.6.4, full BDD run | – | – | – | – | – | – | 1.5 | 1.8 |
| | **Wave 1** | | | | | | | **13.0** | **15.6** |
| C0 | NATS request/reply foundation (CloudEvent checks, size limits, timeouts, queue group, reconnect, error codes, feature switch, BDD NATS steps) | 0.5 | 1.5 | 1.0 | 0.5 | 0.5 | 0.5 | 4.5 | 5.85 |
| H3 | Dummy Content Signer → ORCE issuer plugin | 2.0 | 5.0 | 3.0 | 1.5 | 1.0 | 1.5 | 14.0 | 18.2 |
| – | Wave 2 integration: issuance and retrieval end to end for both formats, upgrade, rollback | – | – | – | – | – | – | 1.5 | 1.95 |
| | **Wave 2** | | | | | | | **20.0** | **26.0** |
| H4 | Well-Known Service → ORCE (partial) | 1.5 | 4.0 | 2.5 | 1.0 | 1.0 | 1.5 | 11.5 | 14.95 |
| – | Wave 3 integration | – | – | – | – | – | – | 1.0 | 1.3 |
| | **Wave 3** | | | | | | | **12.5** | **16.25** |
| | **Total (all waves)** | 5.25 | 13.5 | 9.0 | 4.25 | 3.75 | 5.75 | **45.5** | **57.85** |

The column totals cover the work packages only. The 4.0 PD of wave integration are counted in "Base".

Breakdown of the H3 implementation (5.0 PD): offer replier 1.25; issue replier with signer call, status and `vct` handling 1.75; metadata publisher 0.75; tenant registry and type metadata endpoint 0.75; encrypted prepared-credential store with TTL and single use 0.5.

Breakdown of the H4 implementation (4.0 PD): registration subscriber with persistence 1.25; metadata replier 1.0; public endpoint with tenant rewrite and header handling 1.5; re-import and start order 0.25.

The H3 analysis (2.0 PD) includes a protocol spike of about 1 PD. If the spike shows that the contracts cannot be met without upstream changes, wave 2 stops after the spike. The cost is then about 1.5 PD (spike and write-up).

New BDD scenarios (in addition to the existing 20):
- H1: issuance through ORCE returns an offer; `/test/offering/create` stays unrouted (already the case in 12.6.4).
- H2: re-registration after an S12 restart; conflict handling.
- C1: dependency list in `/health/dependencies`.
- H3: offer, retrieval, acceptance and storage readback for `ldp_vc` and `dc+sd-jwt`; reuse of a code is rejected; behaviour after an ORCE restart.
- H4: metadata conformance; lookup by S1 during issuance.

### 4.3 Totals

| Scope | Base PD | Contingency PD | Total PD |
|---|---:|---:|---:|
| Wave 1 only (H1, H2, C1) | 13.0 | 2.6 | 15.6 |
| Waves 1 and 2 (recommended) | 33.0 | 8.6 | 41.6 |
| Waves 1, 2 and 3 (all replaceable items) | 45.5 | 12.35 | **57.85 (rounded 58)** |

Dependencies between the items:
- If wave 2 is approved together with wave 1, H2 can be dropped. This saves about 3.0 PD base, because H3 contains the registry.
- If H4 were done without H3, C0 would move into wave 3 (+4.5 PD base).

### 4.4 Not estimated

- H5, H6, H7 and H9 (not replaceable).
- H8 (not recommended, indicative 8 PD).
- Issuing the ORCE-defined business credential types through the H3 plugin.
- Any upstream change.
- A production high-availability setup of ORCE.
- External security testing.

## 5. Recommendation

### 5.1 Order

1. **Wave 1: H1, H2, C1 (15.6 PD).** Low risk. It uses code that already exists in ORCE. It removes:
   - one Deployment, which uses the mutable `dev` image;
   - the internal offering bootstrap service (its public route was already removed in 12.6.4);
   - one CronJob with 96 runs per day, plus its hook Job and the `curl` image.

   It also adds the missing dependencies to the readiness view. Start with H1; its security question (3.2) was answered, and the public route was removed in 12.6.4.
2. **Gate:** the H3 protocol spike. Go or no-go together with eco.
3. **Wave 2: C0 and H3 (26.0 PD).** Recommended if eco wants:
   - the dummy content signer and its in-memory fragility removed;
   - no claim data in logs;
   - a basis for issuing ORCE-defined credential types.

   It removes one Deployment and one image.
4. **Wave 3: H4 (16.25 PD).** Optional. Do it only after wave 2, and only if PostgreSQL can be removed or eco wants the guard's NATS workaround for S9 gone. Otherwise keep S9 native.

### 5.2 Expected effect on the deployment

| After | Removed | Changed |
|---|---|---|
| Wave 1 | Offering Dummy Deployment; tenant registration Job and CronJob; images `credential-offering-bootstrap:dev` and `curlimages/curl:8.16.0` | `test-credentials` uses an ORCE loopback endpoint; ORCE registers the issuer tenant |
| Wave 2 | `dummycontentsigner` Deployment and image | `/api/schema` routed to ORCE; ORCE answers the plugin NATS subjects |
| Wave 3 | `well-known-service` Deployment and image; guard branch for S9; possibly the PostgreSQL claim **[unverified]** | Issuer metadata endpoint routed to ORCE |

### 5.3 Decisions needed from eco

- Approval of the waves, and of the gate after the spike.
- Whether eco or other users relied on `/test/offering/create`, which 12.6.4 no longer routes.
- Whether the plugin flows may run in the internet-facing application ORCE (assumed), or need a separate internal ORCE instance (more isolation, one extra workload, about +3 PD).
- Whether the two demo credential types must stay available after H3.

### 5.4 Out of scope

- Core services S1 to S7.
- All infrastructure components.
- The Kyverno policies and routes of this module (configuration, not services).
- The Deployer ORCE node and `deploy.sh`/`deployment/*.sh` (ESB tooling, not OCM helpers).
- CR01 item 1.
- PCM.
- The credential refresh endpoint.
- Upstream code changes.
- Performance and high-availability tests.
- Production hardening of the demo credential semantics.

## 6. Open points

1. ~~Whether `/test/offering/create` is reachable without authentication on the live tenant hosts (3.2).~~ Confirmed on 1 November 2026 (anonymous `POST {}` answered `400 identifier is required` on both instances); the route is no longer rendered by the deployer, and the rule was removed by hand on both instances.
2. NATS authorization: whether subject-level permissions exist for the plugin, status and well-known subjects (3.4).
3. Other consumers of PostgreSQL and Redis besides S9 and S8 (3.5, 3.6).
4. Which native service calls the SD-JWT service (3.7).
5. Whether S9 keeps published metadata when registrations stop (3.3).
6. Whether the chart-to-repository mapping in 2.2 matches the image provenance (1.4).
