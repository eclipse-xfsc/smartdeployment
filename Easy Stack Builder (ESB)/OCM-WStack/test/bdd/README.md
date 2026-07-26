# OCM-WStack executable BDD acceptance pack

The Gherkin feature maps directly to `run.sh`, which executes the health-only runtime suite. The suite validates Kubernetes rollout/readiness, internal dependency connectivity, verified-TLS ingress availability, and the ORCE JSON output contract. It intentionally does not perform credential, authentication, policy, DIDComm-message, or other business-workflow tests.

Run on the approved reference cluster:

```bash
./test/bdd/run.sh \
  --namespace ocmwstack \
  --domain example.com \
  --output-json ./captured-node-red-output.json \
  --evidence-dir ./runtime-evidence
```

For a private CA, add `--ca-bundle ./ca-bundle.crt`.
