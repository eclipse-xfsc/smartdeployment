<!-- SPDX-License-Identifier: Apache-2.0 -->

# OCM-WStack: API and Endpoint Inventory

Module: FACIS Easy Stack Builder (ESB), `OCM-WStack`. Context: ESB ICAM Change Request CR01.

## About this inventory

- **Code basis.** The branch of the follow-up pull request, based on `main` commit `e5c7b44`. Compared with that commit, the branch changes version strings to `12.6.4`, including two hard-coded version strings in `flows.json`, and UI text; no route of `/orce/ui-api/v1` changes. The deployer no longer renders the public offering test route (`deployment/assets.sh`). Paths are relative to `Easy Stack Builder (ESB)/OCM-WStack/`.
- **How section 1 was derived.** `charts-runtime/files/flows.json` was parsed with `python -I -X utf8`: `http in` nodes, function nodes, tabs and wiring. The 57 `/orce/ui-api/v1` routes were cross-checked against the route table `definitions` in `flows.json › runtime` (id `ocm-library-28`).
  - Every `http in` route maps to a definition or to one of the 7 special-cased paths in `Runtime.handle`, and every definition has an `http in` node.
- **NATS and links.** `flows.json` contains **no NATS nodes and no link nodes**. NATS is used through the `nats` npm client inside `flows.json › events`.
- **Placeholders.** `{tenant}` = configured `tenantId`. `{tenantHost}` = `<tenantSubdomain>.<domain>`. `{publicOrigin}` = `https://{tenantHost}`. `{group}` and `{account}` = `ocm-wstack` (defaults from `deployment/templates/runtime-config.json`).
- **Uncertainties** are marked *(inference)* or *(not verified)*.
- **No secrets.** This document lists no credential values.

---

## 1. Module HTTP API (`/orce/ui-api/v1`)

Base URL: `https://{tenantHost}/orce/ui-api/v1`. The path is routed by HTTPRoute `ocm-orce-ui` (`PathPrefix /orce`) to Service `ocm-orce:80`, which targets container port 1880 (`charts-runtime/templates/runtime.yaml`).

### 1.1 Common behaviour

These rules apply to all routes in 1.3 unless the route says otherwise. They are implemented in `flows.json › runtime` (`Runtime.handle`), `local-auth`, `api-body` and `coordination`.

| Aspect | Behaviour |
| --- | --- |
| Dispatch | `http in` node → per-tab service function (e.g. `Auth service`) → `ocmBridge.app.handle(req, res, "<Module>")`. If the runtime is not created yet: `503 COORDINATION_UNAVAILABLE`. |
| Authentication | Cookie `__Secure-ocm_session` with exactly one value of 43 base64url characters. The session is looked up by SHA-256 hash in `ui_sessions`. The 24-hour absolute expiry is checked on every request. The user must be enabled and `authVersion` must match. Failure: `401 AUTHENTICATION_REQUIRED`. |
| Origin | If an `Origin` header is present it must equal `{publicOrigin}`, else `403 ORIGIN_FORBIDDEN`. For non-GET requests `Origin` is **mandatory** (checked inside the CSRF check). For non-GET requests, login, `/auth/csrf` and the Socket.IO handshake, a present `Sec-Fetch-Site` must be `same-origin` (`LocalAuth.sameOrigin`); GET routes do not check it. |
| CSRF | Every **non-GET** route requires header `X-CSRF-Token`. The value is the token returned by `POST /auth/login` or `POST /auth/csrf`, i.e. HMAC-SHA256 over the session hash. Failure: `403 CSRF_INVALID`. |
| Permission | Checked against the user's effective permissions (1.2). Failure: `403 PERMISSION_DENIED`. |
| Password change gate | While `passwordChangeRequired` is set, every route except `GET /auth/me` returns `403 PASSWORD_CHANGE_REQUIRED`. The special auth routes, including `POST /auth/password`, are not affected. |
| Rate limit | 180 requests per 60 s per authenticated subject, in memory (single replica): `429 RATE_LIMITED`. If more than 10,000 rate-limit keys are tracked: `503 SERVER_BUSY`. |
| Request body | Parsed for POST, PUT, PATCH and DELETE (`api-body › parseApiBody`). Rules: optional `Content-Type: application/json`; no content encoding other than identity; at most 1 MiB; must be a JSON object; 15 s read timeout. |
| Body errors | `400 INVALID_JSON_BODY`, `400 REQUEST_BODY_INTERRUPTED`, `400 REQUEST_BODY_UNAVAILABLE`, `408 REQUEST_BODY_TIMEOUT`, `413 REQUEST_TOO_LARGE`, `415 JSON_CONTENT_TYPE_REQUIRED`, `415 UNSUPPORTED_CONTENT_ENCODING`. |
| Scope protection | A body containing `tenant`, `tenantId`, `account`, `accountId`, `group`, `groupId` or `auth` is rejected with `403 SCOPE_FORBIDDEN`. `permissions` is allowed only for role create and update. The scope always comes from runtime configuration. |
| Idempotency | Routes marked "Idem." require `X-Idempotency-Key` matching `^[A-Za-z0-9_-]{16,128}$`, else `400 IDEMPOTENCY_KEY_REQUIRED`. The key is recorded in `operation_jobs` per tenant, subject, account, group and operation for 72 h. |
| Idempotent replay | Same key and same body: the stored state is returned with `replayed: true` and `responseAvailable: false`. Same key with a different body: `409 IDEMPOTENCY_KEY_REUSED`. A previously failed operation: `409 <stored code>`. |
| Reconciliation | For a stored `unknown` state, `clearingStore`, `deleteCredential` and `revoke` re-check the native state. |
| Live hint | After each mutation a `resync` hint is emitted to the Socket.IO clients (1.5). |
| Success envelope | `200` or `202` with `{type: <action>, auth: {subject}, data, requestId}`, plus header `X-Request-Id` and `Cache-Control: no-store`. `202` is used when `data.state` is `unknown`, `dispatching` or `pending`. |
| Offer results | If `data.offer` is present, the runtime adds `data.offerUrl` (`openid-credential-offer://?…`). If that URL is shorter than 2,000 bytes it also adds `data.offerQr` (PNG data URL from `qrcode`). |
| Error envelope | `{error: {code, requestId, [operationId, operationState], [upstream], [upstreamStatus], [reason]}, requestId}`. Upstream response bodies are never passed through. Denials (401 or 403 with a resolved session) are written to `ui_audit_log`. |
| Unhandled errors | Default `500 INTERNAL_ERROR`. *(Observation: for non-application exceptions the code sets `code = e.code \|\| 'INTERNAL_ERROR'`, so a driver error code could appear in place of `INTERNAL_ERROR`.)* |

**Upstream error mapping** (`flows.json › http`, `request`, `Client.call`). These codes can occur on any route that calls a native service.

| Upstream condition | Module response |
| --- | --- |
| Upstream 404 | `404 RESOURCE_NOT_FOUND` |
| Upstream 5xx | `503 UPSTREAM_REJECTED` |
| Other non-2xx | `502 UPSTREAM_REJECTED` |
| Timeout | `504 UPSTREAM_TIMEOUT` |
| Connection error | `503 UPSTREAM_UNAVAILABLE` |
| Circuit open (3 consecutive transient failures, 30 s) | `503 UPSTREAM_CIRCUIT_OPEN` |
| Non-JSON response | `502 UPSTREAM_PROTOCOL_ERROR` |
| Response over 2 MiB | `502 UPSTREAM_RESPONSE_TOO_LARGE` |
| Invalid service URL | `500 CONFIGURATION_ERROR` |

Known upstream messages are mapped to `error.reason`:

| Upstream message | `error.reason` |
| --- | --- |
| `Region Id Missing.` | `STORAGE_REGION_MISSING` |
| `Country Id Missing.` | `STORAGE_COUNTRY_MISSING` |
| `Tenant Id Missing.` | `STORAGE_TENANT_MISSING` |
| `Account Id Missing.` | `STORAGE_ACCOUNT_MISSING` |
| `Bad content type` | `STORAGE_CONTENT_TYPE_INVALID` |
| `Body error` | `STORAGE_QUERY_INVALID` |
| `Error during record get.` | `STORAGE_READ_FAILED` |
| `Token Invalid.` | `STORAGE_TOKEN_INVALID` |
| `tenant not found` | `ISSUER_TENANT_NOT_REGISTERED` |

One message also changes the status: a Retrieval 400 for an unsupported wallet format returns `422 RETRIEVAL_CREDENTIAL_FORMAT_UNSUPPORTED`.

### 1.2 Permissions and system roles

Defined in `flows.json › permissions`. Effective permissions are the union over the user's roles (`local-roles › effective`). A disabled user has none.

| Permission | viewer | operator | issuer | auditor | administrator |
| --- | :-: | :-: | :-: | :-: | :-: |
| `credentials.read` | x | x | x | x | x |
| `credentials.verify` | x | x | x |  | x |
| `credentials.delete` |  |  |  |  | x |
| `credentials.receive` |  | x |  |  | x |
| `credentials.issue` |  |  | x |  | x |
| `credentials.revoke` |  |  | x |  | x |
| `relationships.read` | x | x |  | x | x |
| `relationships.write` |  | x |  |  | x |
| `clearing.request` |  | x |  |  | x |
| `audit.read` |  |  |  | x | x |
| `roles.read` |  |  |  |  | x |
| `admin.users` |  |  |  |  | x |
| `system.health.read` |  |  |  |  | x |

- System roles cannot be changed (`403 SYSTEM_ROLE_PROTECTED`).
- Custom roles may combine any atomic permissions.
- The last holder of `admin.users` cannot be removed or disabled (`409 LAST_ROLE_MANAGER`).

### 1.3 Route table

Legend:
- **Auth.** "none" means no session is required. "session" means a valid session is required but no permission. Otherwise the named permission is required in addition to a session.
- **CSRF.** "yes" means `X-CSRF-Token` plus a matching `Origin` header are required.
- **Idem.** "yes" means `X-Idempotency-Key` is required.
- **Upstream.** "Mongo" refers to database `ocm_ui`. Native endpoints are detailed in section 2.
- **Storage list.** The read of all scoped records: `POST /v1/tenants/{tenant}/storage/{region}/{country}/{account}/credentials` with an empty body.

#### Base tab

| # | Method | Path | Auth | CSRF | Idem. | Purpose | Upstream called | Main error codes |
| --: | --- | --- | --- | :-: | :-: | --- | --- | --- |
| 1 | GET | `/health/live` | none | no | no | Liveness. Returns `{alive: true}`. Used by the startup and liveness probes. | none | `503 COORDINATION_UNAVAILABLE` (runtime not started) |
| 2 | GET | `/health/ready` | none | no | no | Readiness. Returns `{ready, nativeReady, dependencies, degraded}`. Used by the readiness probe and the deployer validation. | Mongo `ping`; cached result of the 20-s native probe (Storage list, Retrieval offer list, Dummy Content Signer tenant check, DIDComm connection list, NATS connected) | `503 {ready:false}` |
| 3 | GET | `/metrics` | `system.health.read` | no | no | Per-action request counters, `natsConnected`, `mongoReady`. | none (in-memory) | 401, 403 |
| 4 | GET | `/health/dependencies` | `system.health.read` | no | no | NATS state and mode, circuit state per upstream, issuer bootstrap state, cached native probe. The `version` field is a hard-coded string in `flows.json › modules/Base`: `12.6.4` on this branch, `12.5.11` at commit `e5c7b44`. | none (in-memory) | 401, 403 |

#### Auth tab

| # | Method | Path | Auth | CSRF | Idem. | Purpose | Upstream called | Main error codes |
| --: | --- | --- | --- | :-: | :-: | --- | --- | --- |
| 5 | GET | `/auth/config` | none | no | no | Returns `{mode: "local-session", sessionHours: 24, features: {pcm: false, issuance: true, relationships: true, roleManagement: true}}`. | none | none |
| 6 | POST | `/auth/login` | none; `Origin` must equal `{publicOrigin}` | no | no | Body `{username, password}`. Sets the session cookie and returns `{csrfToken, expiresAt, passwordChangeRequired}`. Limited to 10 attempts per username and 50 per peer address per 15-min window. | Mongo | `400 VALIDATION_ERROR`, `401 AUTHENTICATION_REQUIRED`, `403 ORIGIN_FORBIDDEN`, `429 LOGIN_RATE_LIMITED`, `503 COORDINATION_UNAVAILABLE` |
| 7 | POST | `/auth/csrf` | session; `Origin` must equal `{publicOrigin}` | no (issues token) | no | Returns `{csrfToken}` for the current session, e.g. after a page reload. | Mongo | 401, `403 ORIGIN_FORBIDDEN`, 503 |
| 8 | POST | `/auth/logout` | session | yes | no | Deletes the session and clears the cookie. | Mongo | 401, `403 CSRF_INVALID` or `ORIGIN_FORBIDDEN` |
| 9 | POST | `/auth/password` | session (allowed during the password change gate) | yes | no | Body `{currentPassword, newPassword}`. The new password needs at least 12 characters, at most 72 bytes, no control characters. Increments `authVersion`, deletes all sessions of the user and returns `loginRequired: true`. | Mongo | `400 PASSWORD_POLICY` or `VALIDATION_ERROR`, `401 PASSWORD_INCORRECT`, `403 CSRF_INVALID`, `409 USER_CHANGED` |
| 10 | GET | `/auth/me` | session (allowed during the password change gate) | no | no | Returns subject, username, tenant, account, group, permissions, `expiresAt` and `passwordChangeRequired`. | Mongo | 401 |
| 11 | GET | `/preferences` | session | no | no | Own preferences. Default `{locale: "en", pageSize: 25}`. | Mongo | 401, 403 |
| 12 | PATCH | `/preferences` | session | yes | no | Body `{locale ∈ en, de, fr; pageSize ∈ 10, 25, 50, 100}`. | Mongo | `400 VALIDATION_ERROR` |
| 13 | GET | `/audit` | `audit.read` | no | no | Latest 100 audit entries of the tenant. | Mongo | 403 |
| 14 | POST | `/users` | `admin.users` | yes | yes | Create a user. Body `{username, email, firstName, lastName, enabled, temporaryPassword}`. The temporary password is required and forces a change at first login. | Mongo | `400 VALIDATION_ERROR` or `PASSWORD_POLICY`, `409 USER_EXISTS`, `409 ROLE_CHANGE_IN_PROGRESS` |
| 15 | PATCH | `/users/:id` | `admin.users` | yes | yes | Update or enable/disable a user; optionally set a temporary password. Invalidates the user's sessions. | Mongo | 404, `400 USER_NAME_IMMUTABLE`, `409 LAST_ROLE_MANAGER` or `ROLE_CHANGE_IN_PROGRESS` |
| 16 | DELETE | `/users/:id` | `admin.users` | yes | yes | Delete a user and their sessions. | Mongo | 404, `409 LAST_ROLE_MANAGER` |
| 17 | GET | `/roles` | `roles.read` | no | no | Atomic permissions plus system and custom roles. | Mongo | 403 |
| 18 | POST | `/roles` | `admin.users` | yes | yes | Create a custom role. Body `{name (^[a-z][a-z0-9-]*$), description, permissions[]}`. | Mongo | `400 VALIDATION_ERROR`, `409 ROLE_EXISTS` |
| 19 | PATCH | `/roles/:id` | `admin.users` | yes | yes | Update a custom role. | Mongo | `403 SYSTEM_ROLE_PROTECTED`, 404, `409 LAST_ROLE_MANAGER` |
| 20 | DELETE | `/roles/:id` | `admin.users` | yes | yes | Delete a custom role. | Mongo | `403 SYSTEM_ROLE_PROTECTED`, 404, `409 LAST_ROLE_MANAGER` |
| 21 | GET | `/role-assignments` | `roles.read` | no | no | Users and their roles. Query `search`. | Mongo | `503 UI_USER_RESULT_LIMIT` |
| 22 | PUT | `/role-assignments/:id` | `admin.users` | yes | yes | Body `{roleIds[] (at most 50, unique)}`. Replaces the user's roles. | Mongo | `400 VALIDATION_ERROR`, 404, `409 LAST_ROLE_MANAGER` |
| 23 | GET | `/role-assignments/:id/effective` | `roles.read` | no | no | Effective permissions of a user. | Mongo | 403 |

#### Credentials tab

| # | Method | Path | Auth | CSRF | Idem. | Purpose | Upstream called | Main error codes |
| --: | --- | --- | --- | :-: | :-: | --- | --- | --- |
| 24 | GET | `/credentials` | `credentials.read` | no | no | List credentials, with display summary and lifecycle status. Query: `q`, `type`, `status`, `sort` (`id`, `issuedAt`, `expiresAt`), `direction`, `pageSize` (1–100, default 25), `cursor`. | Storage list; NATS `status.data` (at most 16 status checks per request, 4 in parallel) | `400 VALIDATION_ERROR`; upstream codes and Storage reasons |
| 25 | GET | `/credentials/:id` | `credentials.read` | no | no | Detail: claims, raw credential, capabilities, declared provenance. | Storage list | 404, `422 UNSUPPORTED_FORMAT` |
| 26 | GET | `/credentials/:id/lifecycle` | `credentials.read` | no | no | Availability of verify, revoke and delete for the caller. Failures are reported in the body (`state: pending` or `blocked`). | Storage list | (in body) |
| 27 | POST | `/credentials/import` | `credentials.receive` | yes | yes | Body `{credential}` (JSON object or compact JWT/SD-JWT, at most 1 MiB). Stored with credential id = operation `requestId`. | Storage `PUT …/credentials/{requestId}`; Storage list for lifecycle (only with `credentials.read`) | `400 VALIDATION_ERROR`, `413 CREDENTIAL_TOO_LARGE`, `422 UNSUPPORTED_FORMAT` |
| 28 | DELETE | `/credentials/:id` | `credentials.delete` | yes | yes | Delete the local copy. This does not revoke the credential. | Storage `DELETE …/credentials/{id}`; reconcile via Storage list | 404 |
| 29 | POST | `/credentials/:id/verify` | `credentials.verify` | yes | no | Native verification. Writes a `verification_events` record (TTL 90 days). Returns `overall` = `valid`, `invalid`, `indeterminate` or `unsupported`. Only `ldp_vc` and `dc+sd-jwt` are sent to the Signer. | Storage list; Signer `POST /v1/credential/verify` | 404; otherwise 200 with `overall` and `code` (e.g. `UNSUPPORTED_FORMAT`, `NATIVE_VERIFICATION_UNAVAILABLE`) |
| 30 | POST | `/credentials/:id/revoke` | `credentials.revoke` | yes | yes | Revoke through the status list. Only for credentials whose status list is on `{publicOrigin}` and whose issuer is in `issuerDids`. | Storage list; Status List `POST /status/{tenant}/{listId}/revoke/{index}`; reconcile via NATS `status.data` | `422 STATUS_FORMAT_UNSUPPORTED`, `CREDENTIAL_NOT_REVOCABLE` or `STATUS_NOT_MANAGED_HERE`; `504 OPERATION_OUTCOME_UNKNOWN` |
| 31 | POST | `/credential-chains/resolve` | `credentials.read` | yes | no | Body `{root, chainName, chain[] (at most 32)}`. Native declared-chain resolution. | Storage `POST …/credentials/chain` | `400 VALIDATION_ERROR` |
| 32 | GET | `/offers` | `credentials.receive` | no | no | Pending credential offers of the group. | Retrieval `GET /v1/tenants/{tenant}/offering/list/{group}` | `502 UPSTREAM_PROTOCOL_ERROR` |
| 33 | POST | `/offers/import` | `credentials.receive` | yes | yes | Body `{offer, source}`. The offer can be an `openid-credential-offer:` link, an offer JSON object, or an envelope. `credential_issuer` and any `credential_offer_uri` host must be in `offerIssuerHosts` (default: `{tenantHost}` only). | optional HTTPS `GET <credential_offer_uri>`; Retrieval `PUT /v1/tenants/{tenant}/offering/retrieve/{group}` | `400 OFFER_ISSUER_NOT_ALLOWED`, `OFFER_SCHEME_UNSUPPORTED` or `VALIDATION_ERROR` |
| 34 | POST | `/offers/:id/accept` | `credentials.receive` | yes | yes | Body `{txCode?}`. Accepts the offer, then persists the returned credentials in Storage and reads them back (`accepted-storage`). | Retrieval `DELETE /v1/tenants/{tenant}/offering/clear/{group}/{id}`; Storage list, `PUT`, list | `422 RETRIEVAL_CREDENTIAL_FORMAT_UNSUPPORTED`; `202` with `state: unknown` and `code` `ACCEPTED_STORAGE_UNCONFIRMED` or `ACCEPTED_CREDENTIAL_RESPONSE_INVALID` |
| 35 | POST | `/offers/:id/reject` | `credentials.receive` | yes | yes | Reject an offer. Body `{txCode?}`. | Retrieval `DELETE …/offering/clear/{group}/{id}` with `accept: false` | 404 |

#### Provenance tab

| # | Method | Path | Auth | CSRF | Idem. | Purpose | Upstream called | Main error codes |
| --: | --- | --- | --- | :-: | :-: | --- | --- | --- |
| 36 | GET | `/credentials/:id/provenance` | `credentials.read` | no | no | Provenance graph built from declarations; connection join; native chain result; latest 20 verifications. | Storage list; DIDComm `GET /admin/connections?group={group}`; Storage `POST …/credentials/chain` (only if all selected records are JSON objects); Mongo | 404, `422 UNSUPPORTED_FORMAT` |

#### ClearingCenter tab

For rows 38–42 the clearing code additionally requires `credentials.read` and `credentials.receive` (`clearing › requirePermissions`), on top of `clearing.request`. If they are missing: `403 PERMISSION_DENIED`.

| # | Method | Path | Auth | CSRF | Idem. | Purpose | Upstream called | Main error codes |
| --: | --- | --- | --- | :-: | :-: | --- | --- | --- |
| 37 | GET | `/clearing/providers` | `clearing.request` | no | no | The single provider `gaia-x` with URL, protocol, `trustScope: GX_LOIRE_COMPLIANCE`, required inputs and availability. Availability is reported in the body. | Dispatcher metadata (section 3.1, rows 1–2; cached 60 s) | (in body: `state`, `code`) |
| 38 | GET | `/clearing/inputs` | `clearing.request` + extras | no | no | Candidate stored credentials for each of the three required inputs. | Storage list | 403 |
| 39 | GET | `/clearing/requests` | `clearing.request` + extras | no | no | The caller's last 20 clearing jobs. | Mongo | 403 |
| 40 | GET | `/clearing/requests/:id` | `clearing.request` + extras | no | no | Job state: `state`, `phase`, `code`, `httpStatus`, `credentialId`, `storageConfirmation`, `notification`. | Mongo | 404 |
| 41 | POST | `/clearing/requests` | `clearing.request` + extras | yes | yes | Body `{provider: "gaia-x", credentials: {"gaiax-legal-person", "gaiax-vat-id", "gaiax-terms-and-conditions"}}`, each a Storage credential id. Returns `202 {state: "pending", resourceId}`. The exchange then runs asynchronously (section 3.1). | Storage list; dispatcher metadata; then dispatcher OID4VP/OID4VCI, issuer DID document, Storage `PUT`, list | `400 VALIDATION_ERROR`, 404, `422 CLEARING_INPUT_FORMAT` or `CLEARING_CREDENTIAL_EXPIRED`, `502 CLEARING_METADATA_INVALID`. Later failures appear as job codes (e.g. `CLEARING_REQUEST_INVALID`, `CLEARING_QUERY_UNSUPPORTED`, `CLEARING_OFFER_INVALID`, `CLEARING_TOKEN_INVALID`, `CLEARING_SIGNATURE_INVALID`, `CLEARING_INTERRUPTED`). |
| 42 | POST | `/clearing/requests/:id/store` | `clearing.request` + extras | yes | yes | Retry native storage of a received (encrypted) clearing credential. | Storage list, `PUT`, list | `409 CLEARING_CREDENTIAL_NOT_RECEIVED` or `CLEARING_STORAGE_CONFLICT`, `502 CLEARING_STORAGE_UNCONFIRMED` |

#### Issue tab

| # | Method | Path | Auth | CSRF | Idem. | Purpose | Upstream called | Main error codes |
| --: | --- | --- | --- | :-: | :-: | --- | --- | --- |
| 43 | POST | `/credentials/:id/refresh` | `credentials.issue` | yes | yes | Forwards the body unchanged to an operator-configured URL. Returns `{state: "submitted", upstreamResult}`; this does not prove reissuance. | Storage list (scope check); `POST` to `OCM_CREDENTIAL_REFRESH_URL` or `credentialRefreshUrl` with native scope headers, 15 s timeout | `503 REFRESH_ENDPOINT_NOT_CONFIGURED` (default), `500 REFRESH_ENDPOINT_INVALID`, 404 |
| 44 | GET | `/credential-types` | `credentials.issue` | no | no | Catalog: issuer metadata types, registry entries and the four required business types (`ComplianceCredential`, `MembershipCredential`, `ParticipantCredential`, `ServiceOfferingCredential`). | NATS `wellknown.issuer.metadata`; Mongo `credential_types` | `503 REGISTRY_LIMIT` |
| 45 | POST | `/credential-types` | `credentials.issue` | yes | yes | Body `{id, name, description, format, issuerConfigurationId, fields}`. | NATS `wellknown.issuer.metadata`; Mongo | `400 VALIDATION_ERROR`, `409 CREDENTIAL_TYPE_EXISTS`, `422 ISSUER_TEMPLATE_UNAVAILABLE` |
| 46 | PATCH | `/credential-types/:id` | `credentials.issue` | yes | yes | Update a type, with optimistic `revision`. | as #45 | `400 TYPE_ID_IMMUTABLE`, 404, `409 REGISTRY_CHANGED` |
| 47 | DELETE | `/credential-types/:id` | `credentials.issue` | yes | yes | Body `{revision}`. | as #45 | 404, `409 REGISTRY_CHANGED` |
| 48 | POST | `/issuance` | `credentials.issue` | yes | yes | Body `{credentialConfigurationId, claims}` (claims at most 64 KiB). Returns an offer plus `offerUrl` and `offerQr`. | NATS `wellknown.issuer.metadata`; Dummy Content Signer `GET /internal/tenants/{tenant}`; NATS request on `<topic>.request` (CloudEvent `issuance.request`, 10 s) | `400 UNKNOWN_CREDENTIAL_TYPE`, `413 CLAIMS_TOO_LARGE`, `422 ISSUER_TEMPLATE_UNAVAILABLE`, `502 ISSUANCE_REJECTED`, `503 NATS_REQUIRED_FOR_ISSUANCE`, `ISSUANCE_NO_RESPONDERS`, `ISSUER_TENANT_NOT_REGISTERED`, `ISSUER_INITIALIZING` or `ISSUER_TENANT_CONFIGURATION_CONFLICT`, `504 OPERATION_OUTCOME_UNKNOWN` |
| 49 | GET | `/issuance/:id` | `credentials.issue` | no | no | The caller's own operation record by `requestId`. Payloads are not stored. | Mongo `operation_jobs` | 404 |

#### Relationships tab

| # | Method | Path | Auth | CSRF | Idem. | Purpose | Upstream called | Main error codes |
| --: | --- | --- | --- | :-: | :-: | --- | --- | --- |
| 50 | GET | `/relationships` | `relationships.read` | no | no | DIDComm connections of `{group}`. | DIDComm `GET /admin/connections?group={group}` | `502 UPSTREAM_PROTOCOL_ERROR` |
| 51 | POST | `/relationships/invitations` | `relationships.write` | yes | yes | Body `{}`. Creates an invitation, returned as text. | DIDComm `POST /admin/invitation` | upstream codes |
| 52 | POST | `/relationships/accept` | `relationships.write` | yes | yes | Body `{invitation}`. Must be an `https:` URL whose host is in `relationshipHosts` (default `{tenantHost}`). | DIDComm `POST /admin/connections/accept` | `400 INVALID_INVITATION_URL` or `RELATIONSHIP_HOST_NOT_ALLOWED` |
| 53 | GET | `/relationships/:id` | `relationships.read` | no | no | One connection. Returns 404 if it belongs to another group. | DIDComm `GET /admin/connections/{id}` | 404 |
| 54 | PATCH | `/relationships/:id` | `relationships.write` | yes | yes | Body `{label}` (at most 128 characters). | DIDComm `GET`, then `PUT /admin/connections/{id}` | 400, 404 |
| 55 | DELETE | `/relationships/:id` | `relationships.write` | yes | yes | Delete a connection. | DIDComm `GET`, then `DELETE /admin/connections/{id}` | 404 |
| 56 | POST | `/relationships/:id/block` | `relationships.write` | yes | yes | Block a connection. | DIDComm `GET /admin/connections/{id}`, then `POST /admin/connections/block/{id}` | 404 |
| 57 | POST | `/relationships/:id/unblock` | `relationships.write` | yes | yes | Unblock a connection. | DIDComm `GET /admin/connections/{id}`, then `POST /admin/connections/unblock/{id}` | 404 |

**Notes on the route table**
- `:id` is one URL-decoded path segment. Credential ids are native Storage record keys.
- The UI client (`files/ui/index.js`, `api`) sends `X-Idempotency-Key` on every non-GET request except `/verify` and `/credential-chains/resolve`. The server ignores the header on non-idempotent routes such as `PATCH /preferences`.

### 1.4 Other HTTP endpoints of the application ORCE

| Path | Served by | Access | Purpose |
| --- | --- | --- | --- |
| `GET /` | HTTPRoute `ocm-orce-ui` | public | `302` redirect to `/orce/` |
| `http://{tenantHost}/*` | HTTPRoute `ocm-orce-https-redirect` (Envoy `http` listener) | public | `301` redirect to HTTPS |
| `/orce/` (`index.html`, `index.js`, `index.css`, `facis-logo.svg`) | uibuilder node `OCM W-Stack UI` (`url: orce`, uibuilder 7.5.0) | public, static | Vue UI (ADR-002) |
| `GET /orce/vendor/vue.js` | `flows.json › Serve installed Vue runtime` | public, `Cache-Control: public, max-age=3600` | `vue.runtime.esm-browser.prod.js` from the installed `vue` 3.5.13 |
| `/orce/socket.io/` | uibuilder Socket.IO; middleware `uibuilder/.config/sioMiddleware.js` → `flows.json › Authenticate live UI connections` | session + CSRF + origin (1.5) | Live refresh hints |
| `/orce/editor/` | Node-RED editor (`httpAdminRoot`) | Node-RED `adminAuth`: one user (`editorUsername`), bcrypt hash | Flow editor. **Reachable on the public tenant host** through `PathPrefix /orce`. |
| `GET /_ocm/storage-diagnostics` | `flows.json › Read storage diagnostics (loopback only)` | loopback only (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`; otherwise `403`). Not covered by any HTTPRoute. | Used by `deploy.sh diagnose-storage` through `kubectl exec … node -e` inside the pod. Calls Storage `GET /v1/metrics/health`, `GET /swagger/doc.json`, `POST <credentials path>` and the adapter list. |

### 1.5 Socket.IO channel

- **Endpoint.** Namespace `/orce`, path `/orce/socket.io`. The client uses the WebSocket transport only and no automatic reconnection (`index.js › connect`).
- **Handshake** (`flows.json › Authenticate live UI connections`):
  - session cookie;
  - `auth.csrfToken`, checked as in 1.1;
  - `Origin` equal to `{publicOrigin}`;
  - at least one permission;
  - no pending password change.
- **Re-checks.** The session is re-validated every 5 s and on every client packet.
- **Allowed packets.** Clients may only send `ui:ack` packets, which are rate-limited per subject.
- **Disconnect** at session expiry or on any failed check.
- **Server events.** The server emits `ui:hint` `{type, requiresRefresh: true}` only. Types:
  - `resync`: after mutations and on NATS reconnect or disconnect;
  - `offers.changed`: after issuance and on matching NATS events.

---

## 2. Native OCM W-Stack services consumed

### 2.1 Endpoint configuration

- **Source of URLs.** Service URLs come from `deployment/templates/runtime-config.json`, rendered into ConfigMap `ocm-orce-config` by `deployment/cluster.sh › write_values`.
- **Discovery override.** At install time `deployment/runtime.sh › runtime_install` overrides them from Services discovered in `ocm-wstack`:
  - by exact name, or by label `app.kubernetes.io/name`;
  - preferring the port named `http`, then the expected port.
- **Operator override.** The deployer field `runtimeServices` may override the keys `storage`, `retrieval`, `signer`, `status`, `didcomm` and `issuerBootstrap` with validated `http(s)` URLs (`assets.sh › normalize_config`).
- **Request headers** sent on every native HTTP call from `flows.json › adapters` (`headers`):

  | Header | Value |
  | --- | --- |
  | `x-tenantid` | `{tenant}` |
  | `x-groupid` | `{group}` |
  | `x-group` | `cryptoGroup` (= `{tenant}`) |
  | `x-namespace` | `cryptoNamespace` (= `ocm-wstack`) |
  | `x-origin` | `{publicOrigin}` |
  | `authorization: Bearer …` | only if `nativeToken` is configured; the deployer does not set it |

  Signer verification is the exception: it sends only `authorization` (if configured) and `x-format`.
- **Timeouts.** 5 s for GET and 15 s otherwise. Responses are limited to 2 MiB. Mutations are not retried.

### 2.2 HTTP services

The "Pinned chart" column names the chart directory in `eclipse-xfsc/deployment` at commit `c1ba65c23ffdd891b6edec3bd277fad32b097378`. Its `Chart.yaml` and `values.yaml` SHA-256 values are listed in `upstream-lock.json` (section 2.5).

| Service | In-cluster endpoint | Pinned chart | Calls made by this module | Used for |
| --- | --- | --- | --- | --- |
| **Storage** | `http://storage-service.ocm-wstack.svc.cluster.local:8080` | `OCM W-Stack/Storage Service` | `POST /v1/tenants/{tenant}/storage/{region}/{country}/{account}/credentials` (empty body, `content-type: application/json`) = list; `PUT …/credentials/{id}` (raw credential) = store; `DELETE …/credentials/{id}`; `POST …/credentials/chain`; diagnostics: `GET /v1/metrics/health`, `GET /swagger/doc.json` | System of record for credentials. Routes 24–31, 34, 36, 38, 41–43; native probe; `diagnose-storage`. `{region}` and `{country}` come from the Retrieval chart values or Deployment env `CREDENTIALRETRIEVAL_REGION` and `CREDENTIALRETRIEVAL_COUNTRY` (default `EU`/`DE`; `services.sh › discover_storage_scope`). Version hints in code comments: "Storage 1.2.5" (`storage-path`) and "Storage 1.3.0" (`adapters`). These are inconsistent and not enforced. |
| **Retrieval** | `http://credential-retrieval-service.ocm-wstack.svc.cluster.local:8080` | `OCM W-Stack/Credential Retrieval` | `GET /v1/tenants/{tenant}/offering/list/{group}`; `PUT /v1/tenants/{tenant}/offering/retrieve/{group}` with `{credential_offer: "openid-credential-offer://?…"}`; `DELETE /v1/tenants/{tenant}/offering/clear/{group}/{requestId}` with `{accept, holderKey: "eckey", holderNamespace: "ocm-wstack", holderGroup: {tenant}, tx_code?}` | Offer intake, listing, acceptance and rejection (routes 32–35); native probe. The deployer also enforces `Recreate` rollouts and can repair a dirty V001 migration through Cassandra (`services.sh › repair_retrieval`, `retrieval-recovery.sh`). That repair is permitted only for the images `node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/ocm-wstack/credential-retrieval-service:1.1.5` and `:1.1.7-alpha` with fixed digests (`assets.sh › retrieval_recovery_contract`). |
| **Signer** | `http://signer.ocm-wstack.svc.cluster.local:8080` | *(inference)* `OCM W-Stack/Crypto Service`. No chart named "Signer" is listed; the code comment "Crypto 2.3.7" sits at this call. | `POST /v1/credential/verify` with header `x-format` and body `{credential: <base64>, disclosureFrame: []}` (the latter for SD-JWT only). The response must contain boolean `valid`, and may contain `disclosedCredential`. | Credential verification (route 29) |
| **Status List** | `http://status-list-service.ocm-wstack.svc.cluster.local:8080` | `OCM W-Stack/Status List Service Chart` | `POST /status/{tenant}/{listId}/revoke/{index}`. The response must echo `tenantId`, `listId`, `index` and `status: "revoked"`. | Revocation (route 30). The status *read* goes over NATS (2.3). Supported status list URLs: `{publicOrigin}/api/status/{n}` or `{publicOrigin}/status/{tenant}/{n}`. Supported types: `TokenStatusList`, `StatusList2021Entry`, `BitstringStatusListEntry` (revocation purpose); index ≤ 16,777,215. |
| **DIDComm connector** | `http://didcomm-connector.ocm-wstack.svc.cluster.local:9090` | `OCM W-Stack/Didcomm` | `GET /admin/connections?group={group}`; `GET`, `PUT` and `DELETE /admin/connections/{id}`; `POST /admin/invitation` (text response) and `POST /admin/connections/accept`, both with `{protocol: "nats", topic: "didcomm-connector", eventType: "didcomm.message", properties: {}, group}`; `POST /admin/connections/block/{id}` and `/unblock/{id}` | Relationships (routes 50–57), provenance connection join (36), native probe. The tenant route `POST /api/didcomm/message/receive` → `didcomm-connector:9090 /message/receive` is added by `assets.sh › tenant_values` unless `runtimeServices.didcomm` is set. |
| **Dummy Content Signer** (issuer bootstrap) | `http://dummycontentsigner.ocm-wstack.svc.cluster.local:8080` (`issuerBootstrapUrl`; runtime fallback `http://dummycontentsigner:8080`) | `OCM W-Stack/Dummy Content Signer` | `GET /internal/tenants/{tenant}`. A `PUT` of the same path with `{credentialIssuer, authorizationServers, credentialEndpoint}` happens only if `managedUpstreamTenant` is false. The default is `true`, so the module never writes. | Checks that the issuer tenant is registered with `credentialIssuer = {publicOrigin}`, `authorizationServers = [{publicOrigin}]` and `credentialEndpoint = {publicOrigin}/api/credential`. Runs every 30 s and before each issuance (`flows.json › issuer-bootstrap`). Who registers the tenant is *not verified*; presumably the upstream tenant chart's `registration-cron`. |
| **Well-Known** | no HTTP call by the runtime | `OCM W-Stack/Well Known Chart` (`well-known-service`) | NATS `wellknown.issuer.metadata` (2.3) | Issuer metadata and credential-type catalog (routes 44–48). The public `/.well-known/*` endpoints are checked only by the deployer (2.4). |
| **Credential Issuance** | no HTTP call by the runtime | `OCM W-Stack/Credential Issuance` | NATS issuance subject (2.3) | Issuance requests. *(inference: responder of `<topic>.request`; not identified in this repository.)* The advertised credential endpoint is `{publicOrigin}/api/credential`. |
| **Credential Verification Service** | not called by the runtime | `OCM W-Stack/Credential Verification Service Chart` | none | Configured by the deployer (`native-overrides.json`): `storageServiceUrl` = Storage; `externalPresentation.authorizeEndpoint` = `http://credential-verification-service.ocm-wstack.svc.cluster.local:8080/v1/tenants/{tenant}/presentation/`; NATS queue group; Cassandra keyspace `ocm`; pull secret `esb-ocm-public-registry` (empty `auths`). A tenant compatibility route `/api/presentation/proof` is added (`assets.sh › tenant_values`). |
| **Pre-Authorization Bridge** | not called by the runtime | `OCM W-Stack/Pre Authorization Bridge Chart` | none | Injection `nats,redis,signer`. The guard `esb-ocm-guard` checks its Redis authentication and NATS listener. |
| **Policy** | not called by the runtime | `OCM W-Stack/Policy Chart` | none | Image overridden to `node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/tsa/policy:1.1.2`. Policies repository `https://github.com/eclipse-xfsc/rego-policies.git` (folder `Policies`). Addresses: universal resolver, Signer, `{publicOrigin}`. |
| **SD-JWT Service** | not called by the runtime | `OCM W-Stack/SdJwt Service` | none | Native dependency. |
| **Offering Dummy** | not called by the runtime | `OCM W-Stack/Offering Dummy` | Deployer only, through a localhost port-forward to `service/offering-dummy-credential-offering-bootstrap:8080`: `POST /api/offering/create` (`checks.sh › test_credentials`). The deployer does not render a public route for this service. | Test offer for the explicit `test-credentials` action. |
| **Universal resolver** | `http://universal-resolver-service.infrastructure.svc.cluster.local:8080` | from the `INFRA/core` ApplicationSet | none by the runtime; the deployer checks port 8080 (`resolver_preflight`) | DID resolution for Policy, Verification and DIDComm |

### 2.3 NATS

Server: `nats://nats.infrastructure.svc.cluster.local:4222` (`runtime-config.json › natsUrl`). The client name is `ocm-ui-runtime`, with unlimited reconnects at a 2 s interval. Credentials are used only if `natsUser` is configured (then with `natsPassword`); the deployer does not set them. All messages are CloudEvents 1.0 with `source: urn:xfsc:ocm-ui`.

| Subject | Pattern | Message type (`type`) | Payload sent / checked | Used for | Responder |
| --- | --- | --- | --- | --- | --- |
| `status.data` | request/reply, 5 s | sends `status.data.verify`; expects `status.data` | Sends `{tenant_id, group_id, request_id, namespace, group, type, purpose: "revocation", index, statusUrl}`. Expects `{tenant_id, request_id, revocated: bool, suspended: bool}`. | Status in the credential list (24) and revoke reconciliation (30) | *(inference)* Status List service |
| `wellknown.issuer.metadata` | request/reply, 5 s | `wellknown.issuer.metadata` | Sends `{tenant_id, request_id}`. Expects `Issuer.credential_configurations_supported`, where each entry may contain `topic`. | Credential-type catalog (44–48) | *(inference)* Well-Known service |
| `<topic>.request` (from issuer metadata `topic`; `.request` appended if missing) or configured `credentialTypes[].subject` | request/reply, 10 s | `issuance.request` | Sends `{tenant_id, group_id, request_id, identifier, payload: claims}`. Expects `{request_id, tenant_id, [group_id], offer}`. | Issuance (48) | not identified in this repository |
| `retrieval.offering.publication` | subscribe (no queue group) | filter `retrieval.offering.received` | Accepted only if `data.tenant_id` and `data.group_id` match. Mapped to UI hint `offers.changed`. | Live refresh of offers | Retrieval (publisher) |
| `ui.events.*` | subscribe | as configured | Allowed by `events.start`; none configured by default | (optional) | — |

- **Other subjects in the configuration.** `signer-topic` and `storage.service.store` appear in the Credential Verification Service environment (`deployment/templates/routing-patch.yaml`), and `didcomm-connector` / `didcomm.message` in the DIDComm settings. The UI runtime does not use them directly.
- **Guard connections.** The guard `esb-ocm-guard` opens TCP connections to NATS port 4222 (ping) and port 8222 (monitoring connections) (`reconcile.sh › nats_connections`, `nats_ping`).

### 2.4 Native and public endpoints checked by the deployer

From `deployment/checks.sh`. These calls are made from the deployer host over the public tenant URL, or through `kubectl port-forward` where stated.

| Check | Request | Expected |
| --- | --- | --- |
| issuer metadata | `GET {publicOrigin}/.well-known/openid-credential-issuer` | `credential_issuer = {publicOrigin}`; `credential_endpoint = {publicOrigin}/api/credential`; at least one configuration |
| DID document | `GET {publicOrigin}/.well-known/did.json` | `id = did:web:{tenantHost}`; at least one verification method |
| JWKS | `GET {publicOrigin}/.well-known/jwks.json` | at least one key |
| UI ready | `GET {publicOrigin}/orce/ui-api/v1/health/ready` | `ready: true` (plus `nativeReady`) |
| UI auth mode | `GET {publicOrigin}/orce/ui-api/v1/auth/config` | `mode: local-session`, `sessionHours: 24`, `features.pcm: false` |
| Anonymous denial | `POST …/issuance`, `PATCH …/preferences`, `DELETE …/credentials/esb-auth-probe` | `401 AUTHENTICATION_REQUIRED` |
| Dashboards (only if `publicDashboards`) | `GET https://argocd.<domain>/api/version`, `GET https://grafana.<domain>/api/health` | version string; `database: ok` |
| `test-credentials` (explicit confirmation) | port-forward to Storage, Retrieval and the offering bootstrap tool: Storage list → `POST http://127.0.0.1:<port>/api/offering/create` → Retrieval `PUT …/offering/retrieve/esb-check-<uuid>` → `GET …/offering/list/…` → `DELETE …/offering/clear/…` → Storage read-back (up to 90 s) | test data is retained |

### 2.5 Version pins (from `upstream-lock.json` and the charts)

**Upstream repositories and tools**

| Item | Pin |
| --- | --- |
| XFSC deployment repository | `https://github.com/eclipse-xfsc/deployment.git`, commit `c1ba65c23ffdd891b6edec3bd277fad32b097378` (also `argoRevision`), `reviewedAt` 2026-10-26; 56 files pinned by SHA-256 and git blob |
| Argo CD install manifest | commit `c9c369efcc5b2a0bd720803f8d14a1c3eaddf579` (`argoCdCommit`) |
| XFSC kubernetes-operator (review record) | repository `https://github.com/eclipse-xfsc/kubernetes-operator.git`, commit `25536da670e3ed5a9b300378b8880a6ce8dd6c48`, image tag `2.4.2`, chart `2.4.2-helm`. Informational only: no script reads `operatorReview`. The operator itself is installed from `INFRA/kubernetes-operator` at the pinned deployment commit. |
| Retrieval recovery contract | `node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/ocm-wstack/credential-retrieval-service:1.1.5` (`sha256:c6ff55eaff0624c9e3f94d23a823c9cbdb2b7235dc6d14180b359ad8e79176ae`) and `:1.1.7-alpha` (`sha256:6a9363c4e8c4437fa185bf1dd859c34e1eebc100fcdbbcfc988fd258d4b333d7`). This only gates the migration repair; it does not select the deployed image. |
| Helm pins | `external-dns` 1.23.0, `opentelemetry-collector` 0.177.0, `kube-prometheus-stack` 92.13.1, `loki` 7.5.0, `tempo` 1.24.4, `jaeger` 4.16.1, `promtail` 6.17.1 |
| ExternalDNS webhooks | IONOS `ghcr.io/ionos-cloud/external-dns-ionos-webhook:v0.14.0`; Hetzner `docker.io/hetzner/external-dns-hetzner-webhook:v0.3.4` |

**Images and packages set by this module**

| Item | Pin |
| --- | --- |
| Runtime and guard image | `ecofacis/xfsc-orce:2.0.15` (tag, not digest) |
| Embedded MongoDB | `mongo:6.0.20` |
| Policy image | `node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/tsa/policy:1.1.2` (manifest checked by `policy_image_preflight`) |
| Runtime npm (direct deps only; no lockfile, see ADR-003) | `node-red-contrib-uibuilder` 7.5.0, `vue` 3.5.13, `mongodb` 6.13.0, `nats` 2.29.2, `bcryptjs` 2.4.3, `qrcode` 1.5.4 |
| Deployer npm | `bcryptjs` 2.4.3 (`package.json`) |
| BDD tests | Python packages pinned in `test/bdd/requirements.txt` (`behave` 1.3.3 etc.) |

**Native service charts** (`Chart.yaml` SHA-256 from `upstream-lock.json › sha256`). The container image tags of these charts are **not recorded in this repository**; they are whatever the pinned chart files specify.

| Chart | `Chart.yaml` SHA-256 |
| --- | --- |
| `OCM W-Stack/Storage Service` | `9e3cf20b28c8c82fe432dbbee719455c2eca4093a581e9dc3c8be2dc2cd4caea` |
| `OCM W-Stack/Credential Retrieval` | `373f3fe4174c10a7be3a1b3b7f3578761da82bbda5935407a3bfa8e984f9fb5c` |
| `OCM W-Stack/Crypto Service` | `c721c129c0f35966e9c1f97882fc526a8183b6a6b49b54e23dfe09dada66859b` |
| `OCM W-Stack/Status List Service Chart` | `0e92147a8e6ae944d7d9c5872fe5aaff9e837e8d789045b630a3738f7df1dddb` |
| `OCM W-Stack/Didcomm` | `0e171eaf87a930afd17df7d233f0139e3a510b50f3d0e583d3ed06420bdd87ea` |
| `OCM W-Stack/Well Known Chart` | `e6fc5f24aae0c76e3c6aad58a54255f059c0a45a10ea62d468d5575c8490f924` |
| `OCM W-Stack/Dummy Content Signer` | `22f6b4c6547d402b248699b933a3ff7ccab6c308e245c47a0c0221a494ea48c1` |
| `OCM W-Stack/Credential Issuance` | `b7b2200d81ffda78674c16f5f03495c49c48984dc4e662c09ab07225c7ef6ef5` |
| `OCM W-Stack/Credential Verification Service Chart` | `8c26e4fc3dcefee853f7cfbbcf8f97796cbc2fd5d7e4b6d5896114c4019368ed` |
| `OCM W-Stack/Pre Authorization Bridge Chart` | `3dea636789351220dc308e3fb0cf81175825bd11855bafa9f846c83c2a489702` |
| `OCM W-Stack/Policy Chart` | `d456ae2367281645600fc7fd2a87530e85bcd0f09e5c956f894ee8e2445a2bb5` |
| `OCM W-Stack/SdJwt Service` | `5c34d1cfdf1874293bbd69ef617876165df4693b69d8b2dd6ae7a45544d93092` |
| `OCM W-Stack/Offering Dummy` | `4b1c749e6cfbe24823bd781ee28875615fa0b38cdec460a23931cba9d191bcb2` |
| `XFSC/tenant/chart` | `28a2a6c2dea42f027afbf9db0293d92ddc88d995cc6ec8701f2c9de826f269bf` |

### 2.6 Other in-cluster endpoints

| Endpoint | Client | Purpose |
| --- | --- | --- |
| `mongodb://…@ocm-ui-mongodb.ocm-wstack.svc.cluster.local:27017/ocm_ui?authSource=admin` (embedded) or the operator-supplied URI | application ORCE | UI state (ADR-004) |
| Envoy gateway ClusterIP (from `infrastructure` Services labelled `gateway.envoyproxy.io/owning-gateway-name=envoy-gateway`) | application ORCE and native pods via `hostAliases` | `{tenantHost}` resolves to the gateway inside the cluster (Kyverno `esb-ocm-tenant-routing`, `network.sh › native_routing`, chart value `hostAliases`). In-cluster calls to `{publicOrigin}`, e.g. allowed offer URIs, stay inside the cluster. |
| `redis` in `infrastructure` (TCP 6379), Secret `redis-root-auth` | `esb-ocm-guard` | Redis authentication check for the Pre-Authorization Bridge |
| Kubernetes API (ClusterIP of `default/kubernetes`) | `esb-ocm-guard`; the deployer through the uploaded kubeconfig | Reconciliation; all deployment actions |
| `cassandra.infrastructure.svc.cluster.local:9042` | deployer, through `kubectl exec` in the Cassandra pod | Guarded Retrieval migration recovery only |

---

## 3. External endpoints

### 3.1 Called by the application ORCE at runtime

The runtime NetworkPolicy allows TCP 443 to `0.0.0.0/0` except `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8` and `169.254.0.0/16`. The rule applies to the whole pod (`charts-runtime/templates/networkpolicy.yaml`).

**Gaia-X compliance dispatcher (lab)**

Base URL `https://compliance-dispatcher.lab.gaia-x.eu/v3`, **hard-coded** in `flows.json › clearing` (`ENDPOINT`); see ADR-009. Expected verifier DID and `client_id`: `did:web:compliance-dispatcher.lab.gaia-x.eu:v3` and `decentralized_identifier:did:web:compliance-dispatcher.lab.gaia-x.eu:v3`.

| # | Method and path (relative to the base) | Purpose |
| --: | --- | --- |
| 1 | `GET /.well-known/openid-credential-issuer` | Issuer metadata. Must state `credential_issuer` = base, `credential_endpoint` = `/oid4vci/credentials`, `nonce_endpoint` = `/oid4vci/nonce`, configuration `ComplianceCredential` (`jwt_vc_json`, ES256). Cached 60 s. |
| 2 | `GET /.well-known/oauth-authorization-server` | `issuer` = base, `token_endpoint` = `/oid4vci/token`, pre-authorized-code grant |
| 3 | `GET /oid4vp/authorize?trustScope=GX_LOIRE_COMPLIANCE&vcid=<LegalPerson credential id>&complianceLevel=standard-compliance` | Returns an `openid4vp:` link with `client_id` and `request_uri` |
| 4 | `GET /oid4vp/request.jwt?state=…` (the `request_uri`; must be exactly this path) | Request object, `typ: oauth-authz-req+jwt` |
| 5 | `GET /.well-known/jwks.json` | Key for the request object (matched by `kid`) |
| 6 | `POST /oid4vp/callback` (form: `state`, `vp_token`) | Submits the three input JWTs. 90 s timeout. Returns a `redirect_uri` with a by-value `credential_offer`. |
| 7 | `POST /oid4vci/token` (form: `grant_type=urn:ietf:params:oauth:grant-type:pre-authorized_code`, `pre-authorized_code`) | Bearer access token |
| 8 | `POST /oid4vci/nonce` | `c_nonce` |
| 9 | `POST /oid4vci/credentials` (Bearer; `{credential_configuration_id: "ComplianceCredential", proofs: {jwt: [<ES256 proof, ephemeral P-256 key>]}}`) | Exactly one `vc+jwt` ComplianceCredential |
| 10 | `POST /oid4vci/notification` (Bearer; `{notification_id, event: "credential_accepted"}`) | Only if the metadata advertises exactly this endpoint and a `notification_id` is returned |

Transport rules (`flows.json › clearing-transport`):
- HTTPS only, default port, no IP-literal host, no URL credentials or fragment.
- All DNS answers must be public. Blocked: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/3. IPv6 must be in 2000::/3, excluding 2001::/23, 2001:db8::/32 and 2002::/16.
- Redirects are not followed. Responses are limited to 2 MiB.

**Other runtime calls**

| Endpoint | Caller | When | Purpose |
| --- | --- | --- | --- |
| Issuer DID document of the received ComplianceCredential: for `did:web:<host>` → `https://<host>/.well-known/did.json`; for `did:web:<host>:<path…>` → `https://<host>/<path…>/did.json`. `did:jwk` is resolved locally. | application ORCE (`clearing-jwt › issuerKey`) | each clearing exchange (verifying step) | Issuer key for signature verification. The host is whatever the credential declares; the dispatcher's own DID is expected *(not enforced)*. Same transport rules as above. |
| `credential_offer_uri` from an imported offer | application ORCE (`adapters › importOffer`) | `POST /offers/import` | Download the offer object (HTTPS, 5 s, at most 16 KiB). The host must be in `offerIssuerHosts`, default `{tenantHost}` only, which `hostAliases` resolve to the in-cluster gateway. |
| `OCM_CREDENTIAL_REFRESH_URL` (tab or ORCE environment) or `credentialRefreshUrl` (runtime configuration) | application ORCE (`adapters › refresh`) | `POST /credentials/:id/refresh` | Operator-defined. **Unset by default.** No deployer field exists for it: `normalize_config` does not pass `credentialRefreshUrl`, and `runtime-config.json` has no such key. |
| npm registry (npm default `https://registry.npmjs.org/`; no registry is configured in `seed.sh`, and whether the base image overrides it is *not verified*) | init container `seed-orce-runtime` | first start and after any seed change | `npm install` of the runtime dependencies (ADR-003) |

### 3.2 Called by the deployer (host running the deployer ORCE or `deploy.sh`)

| Endpoint | Function | Purpose |
| --- | --- | --- |
| `https://github.com/eclipse-xfsc/deployment.git` | `cluster.sh › checkout_source`, `prepare_charts` | `git fetch --depth=1 origin c1ba65c23ffdd891b6edec3bd277fad32b097378` (twice) |
| `https://raw.githubusercontent.com/argoproj/argo-cd/c9c369efcc5b2a0bd720803f8d14a1c3eaddf579/manifests/install.yaml` | `prepare_charts` | Argo CD install manifest; its SHA-256 is recorded and re-checked before apply |
| `https://kubernetes-sigs.github.io/external-dns/` | `prepare_charts` (`helm pull external-dns --version 1.23.0`) | Only if `externalDns` is true. Also added to the `sourceRepos` of AppProject `infrastructure` (`network.sh › permit_dns_repository`). |
| Helm repositories of the pinned charts' dependencies | `prepare_charts` (`helm repo add esb-audit-<n> <repo>`; `helm dependency build`) | The list is derived at run time from the `dependencies[].repository` entries of the pinned charts. The upstream bootstrap lines replaced by the ESB patch reference `open-telemetry.github.io/opentelemetry-helm-charts`, `prometheus-community.github.io/helm-charts`, `grafana.github.io/helm-charts`, `jaegertracing.github.io/helm-charts`, `openbao.github.io/openbao-helm`, `charts.external-secrets.io` and `kyverno.github.io/kyverno`. *(The exact set at the pinned commit was not verified.)* |
| `https://node-654e3bca7fbeeed18f81d7c7.ps-xaas.io/v2/tsa/policy/manifests/1.1.2` | `checks.sh › policy_image_preflight` | `HEAD` and `GET` of the image manifest. On `401` it requests an anonymous Bearer token from the `realm` in `WWW-Authenticate` (HTTPS only) with `scope=repository:tsa/policy:pull`. |
| `{publicOrigin}/…`, `https://argocd.<domain>/…`, `https://grafana.<domain>/…` | `validate_stack`, `test_credentials` | Public validation (section 2.4) |
| Kubernetes API server from the uploaded kubeconfig | all actions | Cluster operations. Requires cluster-admin. |

### 3.3 External dependencies of in-cluster components configured by this module

| Endpoint | Component | Purpose |
| --- | --- | --- |
| `https://github.com/eclipse-xfsc/deployment.git` at `c1ba65c23ffdd891b6edec3bd277fad32b097378` | Argo CD repo-server | Continuous sync of the upstream ApplicationSets (`tag` = pinned commit) |
| `https://kubernetes-sigs.github.io/external-dns/` | Argo CD | ExternalDNS chart 1.23.0 (if `externalDns`) |
| `https://github.com/eclipse-xfsc/rego-policies.git` | Policy service (`memoryStorage.policiesRepo`) | Rego policies, folder `Policies` |
| DNS provider APIs (IONOS or Hetzner) | ExternalDNS webhook (if `externalDns`) | DNS records for `{tenantHost}` and optional dashboards. The API endpoints are the webhook images' defaults and are not configured in this repository. |
| Container registries | kubelet | `docker.io` (`ecofacis/xfsc-orce:2.0.15`, `mongo:6.0.20`, `library/redis` for Argo CD (rewritten from `public.ecr.aws`), `hetzner/external-dns-hetzner-webhook:v0.3.4`); `ghcr.io` (`ionos-cloud/external-dns-ionos-webhook:v0.14.0`); `node-654e3bca7fbeeed18f81d7c7.ps-xaas.io` (`tsa/policy:1.1.2`, and native OCM images under `ocm-wstack/`, e.g. `credential-retrieval-service` as referenced by the recovery contract; *(inference)* other native images likely come from the same registry); plus the registries referenced by the pinned upstream charts (not enumerated in this repository) |

### 3.4 DNS resolvers

| Resolver | Used by | Status |
| --- | --- | --- |
| Cluster DNS. Services in `kube-system` with TCP and UDP port 53 and a pod selector, discovered by `network.sh › discover_dns`. | application ORCE (NetworkPolicy egress to `kube-system` on 53, plus discovered extra ports via `dnsFallbackEgress`), `esb-ocm-guard`, `clearing-transport` (Node `dns.lookup`) | active |
| `https://dns.google/resolve` and `https://cloudflare-dns.com/dns-query` (DNS-over-HTTPS JSON API, A and AAAA) | `network.sh › public_dns_view` | **Defined but not reachable in this revision.** `public_dns_view` is only called from `wait_dns`, and `wait_dns` has no caller. |
| `busybox nslookup` (system resolver of the deployer host) | `network.sh › system_dns_view` | Same: only called from `wait_dns` (no caller) |

---

## 4. Open points for the reviewer

1. **Signer chart mapping.** Which upstream chart provides Service `signer`? It is presumably `OCM W-Stack/Crypto Service` (2.2).
2. **NATS responders.** Which services answer `status.data`, `wellknown.issuer.metadata` and the issuance subjects (2.3)?
3. **Native image versions.** Record the container image tags of the native services at the pinned commit. They are not in this repository.
4. **npm registry.** Confirm the npm registry the base image uses (3.1).
5. **Per-peer login limit.** Confirm on a live system whether `req.socket.remoteAddress` behind Envoy is the client address or the Envoy pod address (ADR-005).
