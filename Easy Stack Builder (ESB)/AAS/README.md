[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../LICENSE)

# AAS

An automated Authentication and Authorization Stack workspace that deploys an AAS instance to a Kubernetes cluster.

---

## Table of Contents
- [🚀 Overview](#-overview)
- [⚡️ Click-to-Deploy](#%EF%B8%8F-click-to-deploy)
- [🛠️ How to Use](#%EF%B8%8F-how-to-use)
  - [1. Prepare the environment and prerequisites](#1-prepare-the-environment-and-prerequisites)
    - [1.1. Kubernetes](#11-kubernetes)
    - [1.2. Local ORCE](#12-local-orce)
    - [1.3. Tooling on the ORCE host](#13-tooling-on-the-orce-host)
  - [2. Create your flow](#2-create-your-flow)
  - [3. Name your instance and provide the destination domain](#3-name-your-instance-and-provide-the-destination-domain)
  - [4. Upload kubeconfig and TLS credentials](#4-upload-kubeconfig-and-tls-credentials)
  - [5. Choose database mode](#5-choose-database-mode)
  - [6. Click done and then deploy](#6-click-done-and-then-deploy)
  - [7. Read the deployment output](#7-read-the-deployment-output)
  - [8. Remove your instance](#8-remove-your-instance)
- [⚙️ Configuration](#%EF%B8%8F-configuration)
- [📁 Directory Contents](#-directory-contents)
- [📦 Dependencies](#-dependencies)
- [🔗 Links & References](#-links--references)
- [License](#license)

---

## 🚀 Overview

AAS is a streamlined authentication and authorization workspace that provisions an XFSC Authentication and Authorization Stack on a target Kubernetes cluster with minimal manual intervention. Through a custom ORCE node, the workspace collects a kubeconfig, TLS credentials, a destination domain, and the desired database mode, then executes the included `deploy.sh` and `uninstall.sh` scripts to automate namespace creation, ingress preparation, Keycloak installation, realm import, token bootstrapping, and AAS deployment.

The workspace supports two database strategies:

- **Embedded deploy** installs PostgreSQL inside the target namespace and bootstraps the `aas` database automatically.
- **External DB** connects AAS to an already existing PostgreSQL instance using a JDBC URL, username, and password supplied through the editor.

At the end of a successful deployment, the node returns a structured output containing:

- `authServerUrl`
- `keyServerUrl`
- `keycloakAdminUsername`
- `keycloakAdminPassword`
- `iatToken`

This makes the node useful not only for infrastructure provisioning, but also as a handoff point for downstream automation flows that need the resulting AAS endpoints and bootstrap credentials.

---

## ⚡️ Click-to-Deploy

---

## 🛠️ How to Use

### 1. Prepare the environment and prerequisites
You'll need:

1.1. A Kubernetes cluster to host the child instance  
1.2. A local ORCE as the parent to host the initial developing environment  
1.3. Required CLI tooling installed on the machine running ORCE / ORCE

### 1.1. Kubernetes
The **AAS-Stack** node requires a working Kubernetes cluster that is reachable through a valid kubeconfig file. The deployment script installs or repairs `ingress-nginx` automatically, so the cluster user must have sufficient permissions to create namespaces, secrets, deployments, ingresses, configmaps, and cluster-scoped ingress resources.

You also need TLS material for the domain you want to expose. The script creates a TLS secret named `xfsc-wildcard` in the target namespace and uses it for both Keycloak and AAS ingresses.

### 1.2. Local ORCE
As described in the [ORCE page](https://github.com/eclipse-xfsc/orchestration-engine), you can install ORCE locally with:

```bash
docker run -d --name xfsc-orce-instance -p 1880:1880 ecofacis/xfsc-orce:2.0.12
```

After pulling and starting the image, open [http://localhost:1880](http://localhost:1880) to access your local Orchestration Engine.

Then install the AAS node package from this repository using the **New Node** flow in the left sidebar. After the package is installed and the editor is refreshed, the node becomes available in the **FAPs** category as **AAS-Stack**.

### 1.3. Tooling on the ORCE host
The deployment script expects the following binaries to be available on the machine running ORCE / ORCE:

```bash
kubectl
helm
openssl
jq
curl
sed
grep
base64
mktemp
tr
```

Without these tools, deployment will fail before the Kubernetes installation begins.

### 2. Create your flow
Drag and drop an **inject** node, the **AAS-Stack** node, and a **debug** node. Connect them so the AAS-Stack node can be triggered by the inject node and the deployment result can be inspected in the debug sidebar.

A minimal flow is:

```text
inject  -->  AAS-Stack  -->  debug
```

### 3. Name your instance and provide the destination domain
Double click on the node to open the editor.

- **Instance name** becomes the Kubernetes namespace used by the deployment.
- **Domain** must be a bare hostname such as `apps.example.com`.

Do **not** include `http://`, `https://`, or a path. The editor warns about this because the deployment templates derive multiple hostnames from the base domain.

After deployment, the stack will expose endpoints like:

- `https://auth-server.<DOMAIN>`
- `https://key-server.<DOMAIN>`

### 4. Upload kubeconfig and TLS credentials
Upload the following files through the node editor:

1. **kubeconfig**  
   Access configuration for the target Kubernetes cluster.

2. **TLS private key** (`.key` / `.pem`)  
   Used to create the target namespace TLS secret.

3. **TLS certificate** (`.crt` / `.pem` / `.cer`)  
   Used together with the private key for ingress termination.

These files are written to temporary files during execution and then passed to `deploy.sh`.

### 5. Choose database mode
The editor provides two database options:

#### Embedded deploy
Use this mode when you want the workspace to install PostgreSQL in the same namespace as AAS.

In this mode, the deployment script will:

- install PostgreSQL via Helm,
- wait for the database to become ready,
- create/update an `aas` PostgreSQL role,
- create the `aas` database,
- generate a random application password,
- create the `aas-db-secret` secret for the chart.

#### External DB
Use this mode when you already have a PostgreSQL instance available.

You must provide:

- **DB JDBC URL**  
  Example: `jdbc:postgresql://db.example.com:5432/aas`
- **DB Username**
- **DB Password**

In this mode, the script will not install PostgreSQL. Instead, it injects the supplied connection information into the AAS Helm deployment and creates the required Kubernetes secret for the password.

### 6. Click done and then deploy
Click **Done** in the node editor and then click **Save & Deploy** in the upper right corner of the ORCE interface.

Now trigger the flow using the inject node.

During deployment, the node status changes to indicate progress. Internally, the backend runs `deploy.sh` with the collected configuration and waits until Keycloak and AAS are reachable.

### 7. Read the deployment output
On success, the node emits a structured payload to the debug node. The payload contains:

```json
{
  "authServerUrl": "https://auth-server.<DOMAIN>",
  "keyServerUrl": "https://key-server.<DOMAIN>",
  "keycloakAdminUsername": "admin",
  "keycloakAdminPassword": "<generated-password>",
  "iatToken": "<initial-access-token>"
}
```

These values are extracted from the deployment logs and attached both to `msg.payload` and as convenience properties on the outbound message.

### 8. Remove your instance
To remove an AAS deployment, click the trash icon next to the **AAS-Stack** node and then deploy the flow again.

This triggers `uninstall.sh`, which deletes the target namespace forcefully.

**Important:** the uninstall step removes the namespace created for the AAS instance, but it does **not** undo all cluster-level changes performed by `deploy.sh` such as the installed or repaired `ingress-nginx` controller. If you want complete cluster rollback, you must clean up those shared components manually.

---

## ⚙️ Configuration

Before deployment, provide the following values in the node editor:

1. **Instance name**  
   Target namespace for the deployment.

2. **Domain**  
   Bare hostname used to derive the public endpoints.

3. **kubeconfig**  
   Access configuration for the destination cluster.

4. **TLS private key**  
   Private key used to create the namespace TLS secret.

5. **TLS certificate**  
   Certificate paired with the supplied private key.

6. **Database mode**  
   Choose between `embedded` and `external`.

7. **External DB JDBC URL** *(external mode only)*

8. **External DB username** *(external mode only)*

9. **External DB password** *(external mode only)*

### Public endpoints created by the deployment

- **Auth Server** → `https://auth-server.<DOMAIN>`
- **Key Server / Keycloak** → `https://key-server.<DOMAIN>`

### Runtime output returned by the node

- `authServerUrl`
- `keyServerUrl`
- `keycloakAdminUsername`
- `keycloakAdminPassword`
- `iatToken`

---

## 📁 Directory Contents

```text
.
├── AAS/
├── Keycloak/
├── aas.html
├── aas.js
├── deploy.sh
├── package.json
└── uninstall.sh
```

- **AAS/**  
  Helm chart for the authentication and authorization service. It defines the service image, ingress, runtime properties, database environment variables, and secret-backed application settings.

- **Keycloak/**  
  Helm chart and realm bootstrap assets for the identity provider layer. This directory contains the Keycloak values and the imported `gaia-x` realm configuration used during deployment.

- **aas.js**  
  ORCE backend implementation. It validates the editor configuration, writes temporary kubeconfig / certificate / key files, invokes `deploy.sh`, parses deployment output, and returns the final URLs and tokens through the outbound message.

- **aas.html**  
  ORCE editor UI. It provides the front-end form for instance name, domain, kubeconfig, TLS files, database mode selection, and optional external PostgreSQL credentials.

- **deploy.sh**  
  Main deployment script. It prepares or repairs `ingress-nginx`, creates the target namespace and TLS secret, handles embedded or external PostgreSQL mode, templates Keycloak and AAS values, imports the realm, generates an initial access token, and installs the final AAS release.

- **uninstall.sh**  
  Teardown script. It force deletes the target namespace associated with the instance.

- **package.json**  
  Node.js / ORCE package metadata, dependencies, keywords, and engine requirements for the AAS deployer node.

---

## 📦 Dependencies

### Node package

```json
"node"    : ">=14.0.0",
"ORCE"    : ">=3.0.0",
"tmp"     : "^0.2.1"
```

### Deployment-time tools

```bash
kubectl
helm
openssl
jq
curl
sed
grep
base64
mktemp
tr
```

---

## 🔗 Links & References

- [XFSC ORCE](https://github.com/eclipse-xfsc/orchestration-engine)
- [NGINX Ingress Controller](https://kubernetes.github.io/ingress-nginx/)
- [Keycloak](https://www.keycloak.org/)

---

## License

This project is licensed under the Apache License 2.0.  
See the [LICENSE](../LICENSE) file for details.
