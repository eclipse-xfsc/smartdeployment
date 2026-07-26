# AAS QA/SRS Traceability Matrix

| Requirement | Scenario | Automated check | Evidence |
|---|---|---|---|
| NF-7: executable deployment health testing | AAS namespace and workloads are healthy | `test/health-check.sh` validates namespace existence, Deployment availability, and Pod readiness | `runtime-health.json`, `runtime-health.stderr` |
| NF-7: verified endpoint reachability | Selected AAS endpoint is reachable over verified TLS | Optional `--url` and `--ca-bundle` parameters call the endpoint without disabling certificate verification | `runtime-health.json` |
| NF-8: executable BDD pack and traceability | All AAS health scenarios | `test/bdd/run-bdd.sh`, Gherkin feature, this matrix, and evidence collector | `bdd-results.json`, `bdd-results.md`, evidence archive |
| NF-11: test-server health evidence within deployer scope | Optional test-server URL is reachable | Run the BDD pack with the deployed test-server URL; no authentication workflow is executed | Runtime evidence archive |
| Agreed test boundary | Deployment health only | The pack excludes OIDC, SIOP, token exchange, login, and authorization behavior | Feature file and result metadata |
