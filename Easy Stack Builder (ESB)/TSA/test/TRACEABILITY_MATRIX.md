# TSA QA/SRS Traceability Matrix

| Requirement | Implementation | Evidence |
|---|---|---|
| NF-2: no `curl -k` | No insecure curl option exists; runtime acceptance does not use curl | `test/static-validate.sh` |
| NF-3: global ingress-nginx modification is opt-in | Node editor checkbox defaults to false and is passed as argument 11 | `tsastack.html`, `tsastack.js`, `deploy.sh` |
| NF-7: actual deployment health test | Executable runtime test polls Kubernetes Services and requires a ready EndpointSlice/Endpoints backend for every selector-backed Service | `test/runtime-health.sh`, `runtime-health.json`, `service-readiness.tsv` |
| NF-8: executable BDD, traceability, and evidence | Executable Gherkin/BDD runner plus this matrix; evidence is persisted in `tsa-runtime-evidence` | `test/bdd/`, `test/TRACEABILITY_MATRIX.md`, runtime ConfigMap |
| NF-9: fail-closed `Deployed` result | Service-readiness acceptance runs before status publication and returns non-zero if any required Service lacks a ready backend | `deploy.sh`, `test/runtime-health.sh` |
| NF-12: no fixed Vault root token | Secure token generation/reuse and Kubernetes Secret storage | `deploy-core.sh` |
| SRS TSA deployment validation | Health-only validation confirms deployed Kubernetes Services are routable to ready Pods without testing TSA business workflows | Runtime JSON/Markdown and Kubernetes snapshots |
