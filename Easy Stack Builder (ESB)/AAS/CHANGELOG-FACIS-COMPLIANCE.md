## 6.0.8

- Corrected the test-server OIDC issuer URI to the externally configured Keycloak issuer (`https://key-server.DOMAIN/realms/gaia-x`).
- No other deployment, QA-remediation, image, ingress, credential, or output-contract behavior changed.

# FACIS compliance hotfixes

## 6.0.6

- Removed the implicit kubectl client/server minor-version compatibility gate; preflight now checks only authenticated Kubernetes API reachability.
- Replaced the ingress-nginx admission create/patch Job dependency with direct, opt-in CA and serving-certificate rotation using OpenSSL, Kubernetes Secret apply, and ValidatingWebhookConfiguration CA-bundle patching.
- Existing ingress-nginx controllers are no longer reapplied merely because management is enabled; the pinned manifest is used only when the controller Deployment is absent.
- Preserved the false-by-default ingress management and separate emergency webhook-deletion controls required by NF-3.
- Preserved the project-owner-approved AAS `auth-service-image:latest` exception and all other accepted QA remediations.

## 6.0.5

- Restored the exact project-owner-approved AAS image source and the explicit `latest` exception.
- Added automatic ingress-nginx admission certificate regeneration under the existing Node-RED management opt-in, plus a separate false-by-default deletion fallback.
- Detects ingress-nginx admission CA/certificate mismatches and performs a server-side admission dry-run before application Helm releases create resources.
- Keeps the Node-RED CA bundle scoped to outbound HTTPS verification; it is not treated as a Kubernetes admission CA.
- Renders deployment-specific Helm values and realm JSON into mode-0600 temporary files instead of mutating packaged source files.
- Generates the AAS JWK secret once, stores it in Kubernetes, and reuses it on idempotent redeployment; runtime secret values are passed through mode-0600 values files rather than Helm command-line arguments.
- Rejects missing output keys instead of fabricating `Deployed`.
- Retains health/readiness-only validation without exercising the authentication workflow.

## 6.0.3

- Corrected the verified-TLS helper to invoke the real `curl` binary.
- Moved generated credential initialization before Helm consumption and made it idempotent.
- Enforced the ingress-nginx opt-in boundary.
- Removed the auth-server ingress alias for the distinct test-server.
- Moved AAS preflight before cluster mutation and made required health checks fail closed.

## 6.0.2

- Passed Node-RED deployment configuration explicitly into child-process environments.
