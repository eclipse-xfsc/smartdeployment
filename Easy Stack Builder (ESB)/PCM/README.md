<img width="1919" height="993" alt="image" src="https://github.com/user-attachments/assets/7d515712-2435-439e-a09b-5b080829128c" />[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../LICENSE)

# PCM

An automated Personal Credential Manager workspace that deploys a PCM Cloud environment to a Kubernetes cluster by reusing an existing OCM stack and building a domain-specific web UI image on demand.

---

## Table of Contents
- [🚀 Overview](#-overview)
- [⚡️ Click-to-Deploy](#%EF%B8%8F-click-to-deploy)
- [🛠️ How to Use](#%EF%B8%8F-how-to-use)
  - [1. Prepare the environment and prerequisites](#1-prepare-the-environment-and-prerequisites)
    - [1.1. Kubernetes](#11-kubernetes)
    - [1.2. Local ORCE](#12-local-orce)
    - [1.3. Existing OCM instance](#13-existing-ocm-instance)
  - [2. Create your flow](#2-create-your-flow)
  - [3. Name your instance, bind it to OCM, and choose your domain](#3-name-your-instance-bind-it-to-ocm-and-choose-your-domain)
  - [4. Upload kubeconfig and TLS credentials](#4-upload-kubeconfig-and-tls-credentials)
  - [5. Provide registry repository and credentials for the dynamic web UI build](#5-provide-registry-repository-and-credentials-for-the-dynamic-web-ui-build)
  - [6. Click done and then deploy](#6-click-done-and-then-deploy)
  - [7. Your instance is up!](#7-your-instance-is-up)
- [⚙️ Configuration](#%EF%B8%8F-configuration)
- [📁 Directory Contents](#-directory-contents)
- [📦 Dependencies](#-dependencies)
- [🔗 Links & References](#-links--references)
- [License](#license)

---

## 🚀 Overview

PCM is a streamlined workspace for provisioning a Cloud Personal Credential Manager environment on any compliant Kubernetes cluster with minimal manual setup. Instead of standing up every identity and wallet dependency from scratch, this workspace attaches a new PCM namespace to an already-running OCM installation and automates the deployment of the PCM-facing components needed for a browser-based cloud wallet experience. The included ORCE node captures the deployment parameters, writes the required materials to temporary files, and then invokes the packaged shell automation to install the workspace.

The deployment logic combines Kubernetes, Helm, Docker, and ORCE into a single low-code workflow. A target namespace is created, TLS is configured, service charts are installed, account-service database objects are prepared inside the shared OCM PostgreSQL instance, and the new PCM workspace is wired to the existing OCM services such as Keycloak, Vault, NATS, DIDComm, storage, signing, retrieval, and credential verification.

A special part of this workspace is the **web-ui_image_build** directory. The PCM web UI must contain deployment-time environment values such as the public domain, so the chosen solution is to rebuild the image whenever a new PCM instance is created. During deployment, the script rewrites the production environment file for the web UI, builds a fresh container image, tags it as `custom-webui`, pushes it to the registry you specify, and then deploys the Web-UI chart so that the cluster pulls that exact image. Because of this dynamic build approach, a writable image registry together with its repository, username, and password are required inputs for every deployment.

Whether you need a browser-based cloud wallet for demonstrations, ecosystem testing, or end-to-end SSI flows on top of XFSC services, PCM gives you a repeatable way to spin up the environment without manually stitching together charts, secrets, ingress resources, and image builds. By combining full automation, a graphical interface, and script-driven deployment logic, PCM accelerates the setup and management of a complete cloud wallet workspace.

---

## ⚡️ Click-to-Deploy

---

## 🛠️ How to Use

### 1. Prepare the environment and prerequisites
You'll need:

1.1. A Kubernetes cluster to host the PCM instance  
1.2. A local ORCE as the parent environment to host the initial development flow  
1.3. An already-running OCM instance that PCM can reuse for shared services and secrets

### 1.1. Kubernetes
The PCM workspace requires a working Kubernetes cluster with an ingress controller installed. Initialize your cluster and install nginx-ingress with the following commands:

```bash
export KUBECONFIG=<YOUR_KUBECONFIG_PATH>
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.3/deploy/static/provider/cloud/deploy.yaml
```

You can learn more by reading the [official documentation](https://kubernetes.github.io/ingress-nginx/deploy/).

After this step, you can proceed to step 1.2 (Installing a local ORCE).

### 1.2. Local ORCE
As described on the [ORCE page](https://github.com/eclipse-xfsc/orchestration-engine), you can install ORCE on your local machine with this command:

```bash
docker run -d --name xfsc-orce-instance -p 1880:1880 ecofacis/xfsc-orce:2.0.12
```

After pulling and starting the image, go to [http://localhost:1880](http://localhost:1880) to access your local Orchestration Engine.

Now install the PCM deployer node into ORCE. If you already have a packaged `.tgz` artifact for this directory, upload it through **New Node** in the left sidebar and install it. If you are working directly from source, package the node first and then upload the resulting archive. Refresh the page after installation.
![upload node](./docImages/step1.jpg?raw=true)

![upload node](./docImages/step2.jpg?raw=true)

If everything is installed correctly, proceed to step 2.

### 1.3. Existing OCM instance
PCM does **not** deploy as a completely isolated stack. It expects an existing OCM namespace and reuses the services, secrets, and backing infrastructure from that environment. In practice, the PCM deployment connects to the OCM namespace for at least the following dependencies:

- PostgreSQL
- Keycloak
- Vault
- NATS
- DIDComm connector
- Storage service
- Signer
- Credential retrieval service
- Credential verification service

Before creating the PCM flow, make sure you already have a healthy OCM instance and that you know its namespace name. You will enter that namespace as the **OCM instance name** in the PCM node editor.

### 2. Create your flow
Drag and drop an **inject** node, the **PCMCloud** node, and a **debug** node. Connect them so the PCMCloud node can be triggered by the inject node and any deployment output can be inspected through the debug node.

### 3. Name your instance, bind it to OCM, and choose your domain
Double click the node to open the edit dialog.

Provide:

- **Instance name** – the namespace and logical identifier for the new PCM deployment
- **OCM instance name** – the namespace of the already-running OCM workspace PCM should integrate with
- **Domain** – the bare hostname suffix used for the deployed routes

The main web endpoint is exposed under the `cloud-wallet` subdomain of the domain you provide. For example, if the domain is `example.com`, the PCM web UI is deployed at `https://cloud-wallet.example.com`.

### 4. Upload kubeconfig and TLS credentials
In the node editor, upload:

- the target cluster **kubeconfig**
- the **TLS private key**
- the **TLS certificate**

These files are required so the deployment script can talk to the destination cluster and create the wildcard TLS secret used by the PCM ingress resources.

### 5. Provide registry repository and credentials for the dynamic web UI build
PCM builds its web UI image dynamically during deployment time. The selected domain has to be injected into the web UI configuration before the image is built, so the deployment script patches the production environment, rebuilds the image, pushes it to your registry, and then points the Helm chart at that freshly built image.

Because of that, you must provide:

- **Registry repository** – for example `docker.io/<your-user>/custom-webui`
- **Registry username**
- **Registry password**

This is not optional in the current design: the dynamic build strategy depends on a registry that the deployment script can log into and push to.

![upload node](./docImages/step3_pcm.jpg?raw=true)

### 6. Click done and then deploy
Click **Done** in the node editor and then click **Save & Deploy** in the ORCE editor. Finally, trigger the flow with the inject node.

When triggered, the PCM node writes the provided kubeconfig and TLS materials to temporary files, runs `deploy.sh`, creates the namespace, installs the Helm charts, prepares the backing database objects, rebuilds and pushes the web UI image, and finishes by installing the PCM-facing services into the target namespace.

### 7. Your instance is up!
After the deployment completes and the node status changes to **deployed**, you can access the environment using the generated public routes.

Typical endpoints include:

- `https://cloud-wallet.<your-domain>` – PCM web UI
- `https://cloud-wallet.<your-domain>/api/...` – PCM-facing API routes
- `https://auth-cloud-wallet.<your-domain>` – Keycloak-facing authentication URL expected by the front end

- ***Instance Removal:*** Delete the PCM node from your flow and deploy the changes. On node removal, `uninstall.sh` is triggered and deletes the target namespace. This cleans up the namespaced PCM instance resources, but it does **not** fully reverse every cross-namespace or cluster-level change initiated by `deploy.sh`.

---

## ⚙️ Configuration

Before deployment, provide the following in the node UI:

1. **Instance Name**  
   The namespace / deployment identifier for the PCM instance.

2. **OCM Instance Name**  
   The namespace of the already-running OCM workspace that PCM should reuse.

3. **Domain Address**  
   The bare hostname used to generate the public URLs.

4. **Kubeconfig**  
   Access to the destination Kubernetes cluster.

5. **TLS Credentials**  
   The certificate and private key used to create the `xfsc-wildcard` TLS secret.

6. **Registry Repository**  
   The image repository that will receive the dynamically rebuilt web UI image.

7. **Registry Username / Password**  
   Credentials used for `docker login`, image push, and image-pull secret generation.

---

## 📁 Directory Contents

```text
.
├── orce-esb-pcmcloud-0.0.3.tgz
├── package.json
├── pcmcloud.html
├── pcmcloud.js
├── deploy.sh
├── uninstall.sh
├── Kong Service/
├── Configuration Service/
├── Plugin Discovery Service/
├── Account Service/
├── Web-UI Service/
└── web-ui_image_build/
    └── cloud-wallet-web-ui/
```

- **package.json**  
  Defines the ORCE package metadata, runtime requirements, and the `pcmcloud` node entry.

- **pcmcloud.js**  
  Back-end logic of the PCMCloud node. It validates required configuration, writes temporary files for kubeconfig and TLS assets, calls `deploy.sh` on deploy, and calls `uninstall.sh` when the node is removed.

- **pcmcloud.html**  
  Front-end definition of the ORCE node editor. It exposes the instance name, OCM namespace, domain, kubeconfig, TLS files, and registry credentials.

- **deploy.sh**  
  Main automation script. It creates the namespace and TLS secret, reowns Helm resources when needed, installs the Configuration, Kong, Plugin Discovery, Account, and Web-UI charts, prepares the PCM account database in the shared OCM PostgreSQL instance, copies required secrets from the OCM namespace, dynamically rebuilds the web UI image, pushes it to the provided registry, and configures the Keycloak client used by the front end.

- **uninstall.sh**  
  Removes the PCM instance by deleting the target namespace.

- **Kong Service/**  
  Helm chart values and templates for the API gateway and plugin-related ingress path.

- **Configuration Service/**  
  Helm chart values and templates for the configuration API consumed by the PCM web UI.

- **Plugin Discovery Service/**  
  Helm chart values and templates for plugin discovery and dynamic plugin route integration.

- **Account Service/**  
  Helm chart values and templates for the cloud wallet account API and its integration with OCM dependencies.

- **Web-UI Service/**  
  Helm chart values and templates for the deployed front-end service, including the image reference and ingress configuration.

- **web-ui_image_build/**  
  Source tree and Docker build assets for the PCM web UI image. This subtree is used during deployment to create a fresh, domain-aware front-end image for each deployment target.

---

## 📦 Dependencies

Runtime node requirements:

```json
"node"    : ">=14.0.0",
"ORCE"    : ">=3.0.0",
"tmp"     : "^0.2.1"
```

Deployment toolchain requirements:

- Kubernetes cluster with ingress controller
- `kubectl`
- `helm`
- `docker`
- A writable image registry
- A running OCM stack to supply shared services and secrets

---

## 🔗 Links & References

- [XFSC ORCE](https://github.com/eclipse-xfsc/orchestration-engine)
- [Cloud Personal Credential Manager specification](https://eclipse.dev/xfsc/pcmcloud/pcmcloud/)
- [Personal Credential Manager specification](https://eclipse.dev/xfsc/pcme1/pcme1/)

---

## License

This project is licensed under the Apache License 2.0.  
See the [LICENSE](../LICENSE) file for details.
