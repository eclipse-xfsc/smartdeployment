[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../LICENSE)

# TSA

An automated Trust Services Agent workspace that deploys a TSA instance to a Kubernetes cluster while reusing shared services from an existing OCM stack.

---

## Table of Contents
- [🚀 Overview](#-overview)
- [⚡️ Click-to-Deploy](#%EF%B8%8F-click-to-deploy)
- [🛠️ How to Use](#%EF%B8%8F-how-to-use)
  - [1. Prepare the environment and prerequisites](#1-prepare-the-environment-and-prerequisites)
    - [1.1. Kubernetes](#11-kubernetes)
    - [1.2. Local ORCE](#12-local-orce)
    - [1.3. Existing OCM stack](#13-existing-OCM-stack)
  - [2. Create your flow](#2-create-your-flow)
  - [3. Configure namespaces and base domain](#3-configure-namespaces-and-base-domain)
  - [4. Upload kubeconfig and TLS credentials](#4-upload-kubeconfig-and-tls-credentials)
  - [5. Provide registry configuration for image builds](#5-provide-registry-configuration-for-image-builds)
  - [6. Optional: deploy the legacy TSA login flow](#6-optional-deploy-the-legacy-tsa-login-flow)
  - [7. Click done and then deploy](#7-click-done-and-then-deploy)
  - [8. Your TSA workspace is up!](#8-your-tsa-workspace-is-up)
- [⚙️ Configuration](#%EF%B8%8F-configuration)
- [📁 Directory Contents](#-directory-contents)
- [📦 Dependencies](#-dependencies)
- [🔗 Links & References](#-links--references)
- [License](#license)

---

## 🚀 Overview

TSA is a deployment workspace for standing up a Trust Services Agent environment on Kubernetes while reusing shared OCM services that already exist in another namespace. Instead of redeploying platform-wide dependencies such as Keycloak, signer, NATS, and the DID resolver, the TSA node connects to an existing OCM namespace through cluster DNS and only provisions the TSA-local runtime pieces it needs: MongoDB, Redis, policy, task, cache, infohub, and optionally the legacy login flow.

The included ORCE node collects the target TSA namespace, the OCM namespace, the base domain, kubeconfig, TLS material, registry information, and optional OCM/email parameters. When triggered, the backend writes the uploaded files to temporary paths and invokes `deploy.sh`, which ensures ingress-nginx and cert-manager are present, creates the namespace and secrets, discovers the shared OCM services, builds the TSA service images dynamically, pushes them to your registry, bootstraps MongoDB, configures a dedicated Keycloak realm and OAuth client in the shared Keycloak instance, deploys the TSA services, and runs smoke tests.

The public deployment model is intentionally compact. TSA is exposed under a single host:

- `https://<tsa-namespace>.<base-domain>/infohub`
- `https://<tsa-namespace>.<base-domain>/login` *(optional legacy login path)*

This makes TSA well suited for quickly creating tenant-like workspaces that sit on top of a shared OCM backbone while still keeping their own runtime state, OAuth client, Mongo data, Redis cache, and ingress resources isolated inside a namespaced deployment.

---

## ⚡️ Click-to-Deploy

---

## 🛠️ How to Use

### 1. Prepare the environment and prerequisites
You'll need:

1.1. A Kubernetes cluster to host the TSA instance  
1.2. A local ORCE instance to host the parent low-code environment  
1.3. An already-running OCM namespace whose shared services TSA can reuse

### 1.1. Kubernetes
The **TSA Stack** node requires a working Kubernetes cluster that is reachable through kubeconfig and allows namespace creation, ingress provisioning, secret creation, and workload rollout. The deployment script installs or repairs **ingress-nginx** and **cert-manager** automatically if they are missing, so the supplied kubeconfig must have sufficient permissions for those operations.

The target namespace also receives a TLS secret named `xfsc-wildcard`, so you need a certificate and private key for the domain you want TSA to serve.

In addition, the environment executing the deployment must have the following tools available:

```bash
kubectl
helm
docker
git
curl
openssl
base64
```

### 1.2. Local ORCE
As described in the [ORCE page](https://github.com/eclipse-xfsc/orchestration-engine), you can run a local ORCE parent environment with:

```bash
docker run -d --name xfsc-orce-instance -p 1880:1880 ecofacis/xfsc-orce:2.0.12
```

After the container starts, open [http://localhost:1880](http://localhost:1880). Then install the TSA node package from this repository into ORCE/ORCE and refresh the editor. The node appears in the **FAPs** category as **TSA Stack**.

![new node](./docImages/step1.jpg?raw=true)

![new node](./docImages/step2.jpg?raw=true)

### 1.3. Existing OCM stack
TSA is **not** a fully standalone stack. It expects an existing OCM namespace and discovers the following shared services from there:

- Keycloak
- signer
- NATS
- DID resolver / universal resolver

These services are reused over cluster-internal addresses such as `*.svc.cluster.local`, while the TSA namespace keeps its own local runtime components and secrets.

Before deployment, make sure you know:

- the exact **OCM namespace** name,
- that those shared services are healthy,
- and that Keycloak credentials are still available through the OCM secret expected by the deployment.

### 2. Create your flow
Drag and drop an **inject** node, the **TSA Stack** node, and a **debug** node. Connect them so the inject node triggers the TSA deployment and the debug node shows the deployment result.

A minimal flow is:

```text
inject  -->  TSA Stack  -->  debug
```

### 3. Configure namespaces and base domain
Double click the **TSA Stack** node to open the editor.
![new node](./docImages/step3_tsa.jpg?raw=true)
Provide:

- **TSA namespace** – the namespace for the new TSA deployment
- **OCM namespace** – the namespace of the shared OCM stack TSA should reuse
- **Base domain** – the bare high-level hostname suffix, for example `example.com`

The deployer exposes TSA on a single host:

- `https://<tsa-namespace>.<base-domain>/infohub`
- `https://<tsa-namespace>.<base-domain>/login` *(when legacy login is enabled)*

You can also optionally provide:

- **Email**
- **OCM address** – defaults to `https://cloud-wallet.<base-domain>` if omitted

### 4. Upload kubeconfig and TLS credentials
In the node editor, upload:

- **kubeconfig**
- **TLS private key**
- **TLS certificate**

The backend writes these files to temporary storage and passes them into the deployment script.

### 5. Provide registry configuration for image builds
TSA dynamically builds and pushes the application images during deployment. The script clones the component sources, detects Dockerfiles, builds the images, tags them with a timestamp, pushes them to your registry, and then deploys those exact image references into Kubernetes.

Because of that, you must provide:

- **Registry image prefix** – for example `ghcr.io/myorg/tsa`
- **Registry username**
- **Registry password**

The deployment also creates an image-pull secret named `regcred` in the TSA namespace so the workloads can pull the built images back from the registry.

### 6. Optional: deploy the legacy TSA login flow
The editor contains a checkbox called **Deploy TSA login**.

When enabled, the deployment also:

- builds and deploys the legacy `login` service,
- creates RSA keys in the `login-jwt` secret,
- deploys MailHog for local mail handling,
- and exposes `/login` on the same TSA host.

When disabled, TSA deploys only the core `/infohub` path and related backend services.

### 7. Click done and then deploy
Click **Done** in the editor and then click **Save & Deploy** in ORCE. Finally, trigger the inject node.

During deployment, the node status changes through its normal lifecycle:

- `deploying`
- `deployed`
- `deploy failed`
- `missing config`

The deployment script performs the following high-level sequence:

1. Creates the namespace if needed
2. Discovers shared OCM services
3. Ensures ingress-nginx and cert-manager exist
4. Creates TLS and registry secrets
5. Builds and pushes TSA component images
6. Creates Mongo/Redis infrastructure and runtime secrets
7. Initializes the Mongo replica set and seed data
8. Bootstraps a dedicated Keycloak realm and OAuth client
9. Deploys the TSA applications and ingress
10. Runs smoke tests against liveness, Keycloak token retrieval, and signer operations

### 8. Your TSA workspace is up!
After deployment succeeds, the node emits the script output and the workspace becomes reachable on the configured host.

Typical public routes are:

- `https://<tsa-namespace>.<base-domain>/infohub`
- `https://<tsa-namespace>.<base-domain>/login` *(optional)*

The deployment summary also reports the generated values for:

- Keycloak realm
- Keycloak client ID and client secret
- Mongo root user and password
- resolved shared-service addresses
- built image tag and registry prefix

- ***Instance Removal:*** deleting the TSA node and redeploying the flow triggers `uninstall.sh`, which deletes only the TSA namespace. Shared OCM services and other cluster-wide components are intentionally left untouched.

---

## ⚙️ Configuration

Before deployment, provide the following values in the node editor:

1. **TSA namespace**  
   The namespace created for the TSA deployment.

2. **OCM namespace**  
   The existing namespace from which shared services are reused.

3. **Base domain**  
   Bare hostname suffix such as `apps.example.com`.

4. **Email** *(optional)*  
   Optional informational value passed into the deployment.

5. **OCM address** *(optional)*  
   Defaults to `https://cloud-wallet.<base-domain>` if empty.

6. **kubeconfig**  
   Access configuration for the destination cluster.

7. **TLS private key**  
   Used to create the `xfsc-wildcard` secret.

8. **TLS certificate**  
   Used together with the private key for the same TLS secret.

9. **Registry image prefix**  
   Base image name prefix used for pushed component images.

10. **Registry username / password**  
    Credentials used for `docker login` and for the Kubernetes image-pull secret.

11. **Deploy TSA login**  
    Enables or disables the legacy login flow and its `/login` route.

### Shared services reused from OCM

- Keycloak
- signer
- NATS
- DID resolver / universal resolver

### Local services deployed inside TSA

- MongoDB
- Redis
- policy
- task
- cache
- infohub
- login *(optional)*
- MailHog *(optional, when login is enabled)*

---

## 📁 Directory Contents

```text
.
├── deploy.sh
├── package.json
├── tsastack.html
├── tsastack.js
├── uninstall.sh
└── templates/
    └── mongo-init.js
```

- **deploy.sh**  
  Main deployment entry point. It validates inputs, ensures required cluster components exist, discovers shared OCM services, creates TLS and registry secrets, builds and pushes TSA component images, deploys MongoDB/Redis, bootstraps Keycloak, applies the TSA workloads and ingress, and runs smoke tests.

- **uninstall.sh**  
  Removes the TSA instance by deleting the target namespace.

- **package.json**  
  Defines the ORCE package metadata, runtime requirements, keywords, and the `tsastack` node entry point.

- **tsastack.js**  
  ORCE backend implementation. It validates the configuration, writes the uploaded files to temporary locations, executes `deploy.sh`, and triggers namespace cleanup through `uninstall.sh` when the node is removed.

- **tsastack.html**  
  ORCE frontend/editor definition. It exposes the configuration form for namespace names, domain, kubeconfig, TLS material, registry settings, optional OCM/email values, and the legacy login toggle.

- **templates/mongo-init.js**  
  Seed script used during deployment to initialize MongoDB collections and example data for policy, task, and infohub databases.

---

## 📦 Dependencies

### Node package

```json
"node"    : ">=14.0.0",
"ORCE"    : ">=2.0.0",
"tmp"     : "^0.2.1"
```

### Deployment-time tools

```bash
kubectl
helm
docker
git
curl
openssl
base64
```

### External prerequisites

- A Kubernetes cluster
- A writable container registry
- A working OCM namespace with shared Keycloak, signer, NATS, and resolver services

---

## 🔗 Links & References

- [XFSC ORCE](https://github.com/eclipse-xfsc/orchestration-engine)
- [NGINX Ingress Controller](https://kubernetes.github.io/ingress-nginx/)
- [cert-manager](https://cert-manager.io/)
- [Keycloak](https://www.keycloak.org/)

---

## License

This project is licensed under the Apache License 2.0.  
See the [LICENSE](../LICENSE) file for details.
