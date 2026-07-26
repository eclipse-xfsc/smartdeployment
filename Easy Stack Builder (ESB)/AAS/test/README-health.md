# AAS deployment health check

This check is intentionally limited to deployer scope: namespace existence, Kubernetes Deployment availability, Pod readiness, and optional verified-TLS reachability of a service health URL. It does not execute or assert the component's business workflow.

```bash
./health-check.sh --namespace <namespace> [--url https://service.example/health] [--ca-bundle ./ca.pem] [--kubeconfig ~/.kube/config]
```

Exit codes: `0` passed, `1` failed health/readiness, `2` invalid invocation, `3` skipped because no cluster credentials are available.
