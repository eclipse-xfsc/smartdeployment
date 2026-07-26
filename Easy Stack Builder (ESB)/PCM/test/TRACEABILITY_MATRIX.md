# PCM QA/SRS Traceability Matrix

| Requirement | Scenario | Automated check | Evidence |
|---|---|---|---|
| NF-3: cluster-wide ingress-nginx changes are opt-in | Ingress management disabled by default | Node-RED checkbox defaults to false; `deploy.sh` performs read-only prerequisite validation and returns before create, apply, patch, or restart operations | `pcmcloud.html`, `pcmcloud.js`, `deploy.sh`, static validation log |
| NF-7: executable deployment health testing | PCM namespace and workloads are healthy | `test/health-check.sh` validates namespace existence, Deployment availability, and Pod readiness | `runtime-health.json`, `runtime-health.stderr` |
| NF-7: verified endpoint reachability | Selected PCM endpoint is reachable over verified TLS | Optional `--url` and `--ca-bundle` parameters call the endpoint without disabling certificate verification | `runtime-health.json` |
| NF-8: executable BDD pack and traceability | All PCM health scenarios | `test/bdd/run-bdd.sh`, Gherkin feature, this matrix, and evidence collector | `bdd-results.json`, `bdd-results.md`, evidence archive |
| Agreed test boundary | Deployment health only | The pack excludes credential issuance, wallet synchronization, revocation, login, and policy behavior | Feature file and result metadata |
