# AAS Runtime Evidence Bundle

Run `collect-runtime-evidence.sh` with the same arguments accepted by `test/health-check.sh`. The collector executes the health-only BDD runner and creates a timestamped `.tar.gz` archive.

Expected evidence includes:

- `runtime-health.json`
- `runtime-health.stderr`
- `bdd-results.json`
- `bdd-results.md`
- `aas-deployment-health.feature`
- `TRACEABILITY_MATRIX.md`
- `exit-code.txt`

The pack validates deployment health only and does not execute business workflows.
