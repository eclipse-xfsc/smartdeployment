# Reference-cluster evidence bundle

`collect-runtime-evidence.sh` executes the BDD health suite and packages non-secret Kubernetes snapshots, detailed check logs, the redacted deployment output, Gherkin feature, traceability matrix, and machine-readable results into a timestamped `.tar.gz` archive.

It never exports Kubernetes Secret values. The captured ORCE output is redacted before being placed in the evidence bundle.

Example:

```bash
./test/evidence/collect-runtime-evidence.sh \
  --namespace ocmwstack \
  --domain example.com \
  --output-json ./captured-node-red-output.json
```
