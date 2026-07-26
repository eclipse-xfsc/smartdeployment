[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../LICENSE)

# OCM-WStack

An automated OCM workspace that deploys an XFSC Organisation Credential Manager (OCM) wallet stack to a Kubernetes cluster.

---

## Table of Contents
- [🚀 Overview](#-overview)
- [⚡️ Click-to-Deploy](#%EF%B8%8F-click-to-deploy)
- [🛠️ How to Use](#%EF%B8%8F-how-to-use)
  - [1. Prepare the environment and prerequisites](#1-prepare-the-environment-and-prerequisites)
    - [1.1. Kubernetes](#11-kubernetes)
    - [1.2. Local ORCE](#12-local-orce)
  - [2. Create your flow](#2-create-your-flow)
  - [3. Configure instance name, domain, and email](#3-configure-instance-name-domain-and-email)
  - [4. Supply kubeconfig and TLS credentials](#4-supply-kubeconfig-and-tls-credentials)
  - [5. Click done and then deploy](#5-click-done-and-then-deploy)
  - [6. Trigger the node and monitor deployment](#6-trigger-the-node-and-monitor-deployment)
  - [7. Your stack is up!](#7-your-stack-is-up)
- [⚙️ Configuration](#%EF%B8%8F-configuration)
- [📁 Directory Contents](#-directory-contents)
- [📦 Dependencies](#-dependencies)
- [🔗 Links & References](#-links--references)
- [License](#license)

---

## 🚀 Overview

OCM-WStack is a streamlined deployment workspace that provisions and tears down an XFSC OCM wallet stack on a Kubernetes cluster from inside a ORCE-based ORCE environment. Instead of manually applying dozens of manifests and Helm charts, you provide an instance name, bare domain, issuer email address, kubeconfig, and TLS credentials, and the node executes the bundled `deploy.sh` workflow to bootstrap the required infrastructure and install the full stack.

The deployment logic validates the existing shared ingress-nginx controller by default, creates the target namespace, uploads TLS material, installs core infrastructure such as NATS, cert-manager, Cassandra, Redis, PostgreSQL, Keycloak, and Vault, and then deploys the OCM-facing services such as Storage Service, Status List Service, Universal Resolver, TSA Signer, SD-JWT, Dummy Content Signer, Pre-Authorization Bridge, Credential Issuance, Credential Retrieval, Credential Verification, Well-Known endpoints, and DIDComm. The accompanying `ocmwstack.js` back end manages temporary credentials, executes the deployment script, and reports status directly inside ORCE.

Whether you want a reproducible playground for OCM integration, a fast bootstrap path for SSI-based credential workflows, or a low-code control point for spinning up a complete wallet stack, OCM-WStack reduces the operational overhead significantly. It combines a simple node editor UI with script-driven automation so you can focus on experimenting with credential flows rather than wiring infrastructure by hand.

> **Important:** deleting the node triggers `uninstall.sh`, which deletes the target namespace. Cluster-scoped bootstrap resources installed by the deployment flow (for example ingress-nginx, cert-manager CRDs, and other cluster-level objects) are not comprehensively removed by the uninstall script.

---

## ⚡️ Click-to-Deploy

Install the packaged ORCE node (`orce-esb-ocmwstack-10.1.8.tgz`) into a local ORCE instance, add the **OCM-W-Stack** node to your flow, provide your Kubernetes and TLS inputs, review the disabled-by-default cluster-wide ingress options, and deploy the workspace from the editor.

---

## 🛠️ How to Use

### 1. Prepare the environment and prerequisites
You'll need:

1.1. A Kubernetes cluster that is reachable through a valid kubeconfig and allows namespace creation, Helm installations, CRD application, and cluster-scoped resource changes.

1.2. A local ORCE instance to host the parent low-code environment and execute the node.

1.3. A bare domain name, a TLS certificate/private key pair for that domain, and an email address for certificate issuer configuration.

1.4. The runtime environment used by ORCE must have the required command-line tooling available, including `bash`, `kubectl`, `helm`, `curl`, `jq`, and `openssl`.

### 1.1. Kubernetes
The node expects a working Kubernetes cluster with sufficient permissions for infrastructure bootstrap. The bundled deployment script validates an existing ingress-nginx controller by default. It installs or reconciles that shared controller only when the disabled-by-default **Manage ingress controller** option is explicitly selected. It also applies cert-manager CRDs, creates namespaces and secrets, installs Helm releases, configures databases, and patches application deployments. In practice, this means the supplied kubeconfig should have elevated privileges on the destination cluster.

Before using the node in a shared or production-like cluster, review the script carefully so you understand which cluster-scoped resources it modifies.

### 1.2. Local ORCE
As in the ORCE workspace, you can run a local parent environment with Docker:

```bash
docker run -d --name xfsc-orce-instance -p 1880:1880 ecofacis/xfsc-orce:2.0.12
```

After the container starts, open [http://localhost:1880](http://localhost:1880) and install the packaged node from this directory: `orce-esb-ocmwstack-10.1.8.tgz`.
![new node](./docImages/step1.jpg?raw=true)

![upload node](./docImages/step2.jpg?raw=true)
Once the package is installed successfully, refresh the page. You should then see **OCM-W-Stack** in the **FAPs** category of the ORCE palette.

### 2. Create your flow
Drag and drop an **inject** node, the **OCM-W-Stack** node, and a **debug** node into the canvas. Connect them so the inject node can trigger the OCM-W-Stack deployment and the debug node can display the script output.

![supplying info](./docImages/step3.jpg?raw=true)

### 3. Configure instance name, domain, and email
Double-click the **OCM-W-Stack** node to open the editor.

- **Instance name** defines the Kubernetes namespace used for the deployment and acts as the logical name of your stack.
- **Domain** must be a bare high-level hostname such as `example.com` (no `http://`, `https://`, or path segment).
- **Email** is passed to the cluster issuer configuration used during deployment.

You can also set an optional **Node label** for a friendlier display name in the flow editor.

### 4. Supply kubeconfig and TLS credentials
Upload the following files in the node editor:

- **kubeconfig** for the destination cluster
- **TLS Private Key** (`.key`, `.pem`, or equivalent text form)
- **TLS Certificate** (`.crt`, `.pem`, `.cer`, or equivalent text form)

The node stores the uploaded file contents in hidden editor fields, writes them to temporary files during execution, and passes those files to `deploy.sh`.

Optional editor controls are intentionally disabled by default:

- **Custom CA bundle** appends an uploaded CA bundle to the served TLS chain.
- **Manage ingress controller** installs or reconciles the pinned shared ingress-nginx controller, patches its ConfigMap with `allow-snippet-annotations=true`, `annotations-risk-level=Critical`, and `ssl-protocols=TLSv1.3`, then restarts it. This is cluster-wide. When disabled, the deployer performs read-only validation of the existing namespace, Deployment, Service, IngressClass, and rollout status.
- **Delete ingress webhook** deletes the `ingress-nginx-admission` `ValidatingWebhookConfiguration` and stale admission jobs. This is cluster-wide and high impact.

Enable either ingress option only after explicit approval from the cluster owner. When both ingress options are disabled, the deployment script performs only read-only validation of the existing shared controller and does not modify ingress-nginx resources.

### 5. Click done and then deploy
Click **Done** in the node editor and then click **Deploy** in the upper-right corner of the ORCE/ORCE interface.

At this point the flow is saved, but the actual stack rollout begins only when the node receives an input message.

### 6. Trigger the node and monitor deployment
Activate the **inject** node to start the deployment.

During execution, the node status changes as follows:

- `deploying` while `deploy.sh` is running
- `deployed` when the script completes successfully
- `deploy failed` if the shell command returns an error
- `missing config` if required inputs were not supplied

The **debug** node and node status indicator are the fastest way to inspect output and diagnose rollout issues.

### 7. Your stack is up!
Once the node status changes to **deployed**, the OCM wallet stack should be available in the target namespace and exposed according to the hostnames and ingress rules defined by the bundled Helm charts.

- ***Instance Removal:*** deleting the **OCM-W-Stack** node from the flow and redeploying triggers `uninstall.sh`, which deletes the namespace associated with the instance. This removes the namespaced stack resources, but does not fully reverse every cluster-scoped bootstrap action performed by `deploy.sh`.

---

## ⚙️ Configuration

Before you deploy, provide the following values in the node UI:

1. **Instance Name**  
   Required. Used as the deployment namespace and logical stack identifier.

2. **Domain**  
   Required. Must be a bare hostname. This value is injected into multiple chart `values.yaml` files and ingress rules.

3. **Email**  
   Required. Used during cluster issuer configuration.

4. **Kubeconfig**  
   Required. Used by `kubectl` and `helm` to target the destination cluster.

5. **TLS Private Key**  
   Required. Uploaded into the deployment namespace and also reused for signing-related secrets.

6. **TLS Certificate**  
   Required. Stored as the wildcard TLS secret for ingress exposure.

7. **Custom CA bundle**  
   Optional and disabled by default. Appends a validated PEM CA bundle to the TLS chain.

8. **Manage ingress controller**  
   Optional and disabled by default. Installs or reconciles the pinned shared ingress-nginx controller, performs the ConfigMap patch required for snippet annotations and Critical-risk annotations, enforces TLS 1.3, and restarts it. With this option disabled, the deployer only validates the existing controller and does not create, apply, patch, restart, or delete shared ingress-nginx resources.

9. **Delete ingress webhook**  
   Optional and disabled by default. Deletes the cluster-wide `ingress-nginx-admission` validating webhook configuration and stale admission jobs. Use only with cluster-owner approval.

10. **Node Label**  
   Optional. Friendly display name shown in the ORCE flow.

---

## Runtime acceptance and evidence

The package includes health-only runtime integration tests and an executable BDD acceptance pack under `test/`:

```bash
./test/evidence/collect-runtime-evidence.sh \
  --namespace ocmwstack \
  --domain example.com \
  --output-json ./captured-node-red-output.json
```

The suite validates workload rollout and Pod readiness, required Service endpoints, internal TCP and health-endpoint connectivity, verified-TLS ingress availability, and the ORCE output contract. It does **not** execute credential issuance, verification, revocation, OIDC, DIDComm-message, policy, or other application workflows. The evidence collector creates a timestamped archive containing non-secret cluster snapshots, detailed logs, redacted deployment output, the Gherkin feature, and the traceability matrix.

Vault dev-mode authentication no longer uses a committed fixed root token. The deployer generates a 256-bit token, stores it in the namespaced `vault` Kubernetes Secret, reuses a valid generated token for idempotent redeployment, and rotates legacy fixed/default values.

---

## 📁 Directory Contents

```text
.
├── Cert-Manager
│   ├── Chart.yaml
│   └── values.yaml
├── Cluster-Issuer
│   ├── Chart.yaml
│   ├── templates
│   │   └── clusterissuer.yaml
│   └── values.yaml
├── Credential Issuance
│   ├── Chart.yaml
│   └── values.yaml
├── Credential Retrieval
│   ├── Chart.yaml
│   └── values.yaml
├── Credential Verification Service Chart
│   ├── Chart.yaml
│   └── values.yaml
├── deploy.sh
├── Didcomm
│   ├── Chart.yaml
│   └── values.yaml
├── Dummy Content Signer
│   ├── Chart.yaml
│   └── values.yaml
├── Keycloak
│   ├── charts
│   │   └── keycloak-18.0.2.tgz
│   ├── Chart.yaml
│   ├── templates
│   │   └── secret.yaml
│   └── values.yaml
├── Nats Chart
│   ├── Chart.yaml
│   └── values.yaml
├── ocmwstack.html
├── ocmwstack.js
├── orce-esb-ocmwstack-10.1.8.tgz
├── package.json
├── Policies
│   ├── didDoc
│   │   └── 1.0
│   │       └── policy.rego
│   ├── didProvisioning
│   │   └── 1.0
│   │       ├── data.json
│   │       └── policy.rego
│   └── termsOfUse
│       └── 1.0
│           ├── data.json
│           └── policy.rego
├── Policy Chart
│   ├── Chart.yaml
│   └── values.yaml
├── Pre Authorization Bridge Chart
│   ├── Chart.yaml
│   └── values.yaml
├── preflight.sh
├── Redis
│   └── values.yaml
├── Reverse Proxy
│   └── nginx.conf
├── schema
│   └── ocm-output.schema.json
├── SdJwt Service
│   ├── Chart.yaml
│   └── values.yaml
├── signer
│   ├── Chart.yaml
│   ├── ci
│   │   └── argocd.yaml
│   ├── templates
│   │   ├── deployment.yaml
│   │   ├── _helpers.tpl
│   │   ├── hpa.yaml
│   │   ├── ingress.yaml
│   │   └── service.yaml
│   └── values.yaml
├── Status List Service Chart
│   ├── Chart.yaml
│   └── values.yaml
├── Storage Service
│   ├── Chart.yaml
│   └── values.yaml
├── test
│   └── static-validate.sh
├── test_script.sh
├── uninstall.sh
├── Universal Resolver
│   ├── Chart.yaml
│   └── values.yaml
├── Vault
│   ├── Chart.yaml
│   └── values.yaml
├── Well Known Chart
│   ├── Chart.yaml
│   └── values.yaml
└── Well Known Ingress Rules
    ├── Chart.yaml
    ├── templates
    │   └── ingress.yaml
    └── values.yaml

```

- **deploy.sh**  
  The main automation entry point. It bootstraps ingress-nginx, namespace and TLS secrets, installs infrastructure components, prepares database state and secrets, and deploys the OCM wallet stack services via Helm.

- **uninstall.sh**  
  Removes the deployed instance by deleting the target namespace.

- **package.json**  
  Declares the ORCE package metadata, node registration, keywords, and runtime version requirements.

- **ocmwstack.js**  
  Node back end. It validates required inputs, writes temporary kubeconfig/key/certificate files, executes `deploy.sh`, updates node status, and runs namespace cleanup on node removal.

- **ocmwstack.html**  
  Node front end. It defines the ORCE editor form for instance name, domain, email, kubeconfig, TLS key, certificate, optional custom CA bundle, and optional node label. Custom CA handling is disabled by default and must be explicitly enabled with the **Custom CA bundle** checkbox.

- **orce-esb-ocmwstack-10.1.8.tgz**  
  Packaged ORCE node ready for installation into ORCE.

- **Chart and service directories**  
  These folders contain the Helm charts, values, policies, and supporting manifests used to assemble the full OCM wallet stack and its supporting infrastructure.

---

## 📦 Dependencies

### ORCE package dependencies

```json
"node"    : ">=14.0.0",
"ORCE": ">=2.0.0",
"tmp"     : "^0.2.1"
```

### External CLI/runtime dependencies

The deployment workflow also expects the following tools to be available in the execution environment:

```text
bash
kubectl
helm
curl
jq
openssl
```

---

## 🔗 Links & References

- [XFSC ORCE](https://github.com/eclipse-xfsc/orchestration-engine)
- [XFSC Organisation Credential Manager (OCM)](https://eclipse-xfsc.github.io/landingpage/xfsc-toolbox/xfsc-foss-components/icam-and-trust/organisation-credential/)
- [XFSC Trust Services API (TSA)](https://eclipse-xfsc.github.io/landingpage/xfsc-toolbox/xfsc-foss-components/icam-and-trust/trust-service/)
- [Eclipse XFSC smartdeployment repository](https://github.com/eclipse-xfsc/smartdeployment)

---

## License

This project is licensed under the Apache License 2.0.  
See the [LICENSE](../LICENSE) file for details.


## Optional custom CA bundle

Custom CA handling is disabled by default. Enable **Custom CA bundle** in the Node-RED editor and upload a PEM bundle. When selected, the deployer validates the PEM bundle, appends it to the served certificate chain, and adds it as `ca.crt` in the `xfsc-wildcard` Kubernetes TLS Secret. When the checkbox is clear, no CA bundle is written or applied.
