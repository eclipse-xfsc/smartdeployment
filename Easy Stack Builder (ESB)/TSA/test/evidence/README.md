# Runtime Evidence Bundle

During deployment, `test/bdd/run-bdd.sh` invokes `test/runtime-health.sh`. The compact generated bundle is stored as data in the namespace ConfigMap `tsa-runtime-evidence`. Large Pod, Service, and Event snapshots remain temporary local diagnostics and are not stored in annotations.

Expected files include:

- `runtime-health.json` and `runtime-health.md`
- `bdd-results.json` and `bdd-results.md`
- `service-readiness.tsv`
- `services.json` and `pods.json`
- `events.txt`

The evidence records only Kubernetes Service readiness. It does not probe ingress, DNS, TLS, HTTP, authentication, policy, signing, credential, or other TSA business functionality.
