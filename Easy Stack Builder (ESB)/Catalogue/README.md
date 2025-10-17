[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](../LICENSE)

# Federated Catalogue

An automated orchestration workspace that deploys a [Federated Catalogue](https://github.com/eclipse-xfsc/federated-catalogue) instance to a Kubernetes cluster.

---

## 🚀 Overview

The Federated Catalogue (CAT) is a core component of the XFSC Toolbox that enables discovery and access to resources, assets, and participants through their Self-Descriptions. These Self-Descriptions, written in JSON-LD, are either stored as raw documents or integrated into a graph that supports advanced cross-entity queries. The goal is to empower users to find the most relevant services and monitor their evolution over time.

Key components of the Federated Catalogue include:
- Self-Description Storage and Lifecycle
- Self-Description Graph
- REST Interface
- Self-Description Verification
- Schema Management

This module allows you to set up and interact with the Federated Catalogue visually inside the ORCE environment. You don’t need to write any code or handle any complex API integration manually—just install the Node-RED node for Federated Catalogue, drop it into your flow, and configure the endpoint and query.

Thanks to ORCE’s orchestration features, deploying a Federated Catalogue instance and querying it happens in just a few clicks. Upload your configs, drag your node, and start querying the Gaia-X catalogue ecosystem—all inside your Node-RED UI.

---

## ⚡️ Click-to-Deploy

---
## 🛠️ How to Use

### 1. Prepare the environment and prerequisites
You'll need:
1.1. A Kubernetes cluster to host the child instances
1.2. A local ORCE as the parent to host the initial developing environment

### 1.1. Kubernetes
"Orchestration Engine" node requires a working Kubernetes cluster with ingress installed on it. Initiate a K8s cluster and install nginx-ingress on it using this command.
```bash
export KUBECONFIG=`<YOUR KUBECONFIG PATH>`
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.3/deploy/static/provider/cloud/deploy.yaml
```
You can learn more by reading the [official documentation](https://kubernetes.github.io/ingress-nginx/deploy/)
After this step, you can proceed to step 1.2 (Installing a local ORCE)


### 1.2. Local ORCE
Install ORCE as described in the [ORCE page](https://github.com/eclipse-xfsc/orchestration-engine):
```bash
docker run -d --name xfsc-orce-instance -p 1880:1880 leanea/xfsc-orce:1.0.8
```
Go to [http://localhost:1880](http://localhost:1880).

### Install Federated Catalogue Node
Click on "New Node" in the sidebar.

![new button](./docImage/add-new-node.jpg?raw=true)

Upload `node-red-leanea-federated-catalogue-1.0.2.tgz` from this repository and install. Refresh to activate the node.


### 2. Install your node
click on the "Install" tab. Then on the upload icon.The node will be successfully installed.
![step two (flow)](./docImage/newstep.png?raw=true)

### 3. Create your flow
Drag in an Inject node, the **Federated Catalogue** node, and a Debug node. Connect them:

![step three (flow)](./docImage/create-your-flow.png?raw=true)

### 4. Name your instance and configure the node
Double-click on the Federated Catalogue node to open the edit dialog.
In this step, you must choose a **Catalogue Name**. This will become your instance’s unique identifier, so it must be:
- Unique (not used by any other instance)
- Free of special characters (letters and numbers only)
For example, if you name it `mycatalogue`, it will be used internally for instance referencing and must remain distinct.
![step four (flow)](./docImage/step2.png?raw=true)

### 5. Provide your kubeconfig file
In this tab, you need to provide the **kubeconfig** file of your target Kubernetes cluster.
This file allows the Federated Catalogue node to access your Kubernetes environment and deploy the catalogue instance correctly.
![step five (flow)](./docImage/step3.png?raw=true)

### 6. Provide domain address and TLS credentials
In this tab, you must enter the **domain address** where the catalogue will be accessible. You’ll also need to upload your **TLS certificate** and **private key**.

The final accessible URL is formed by combining this domain with the catalogue instance name you set earlier. For example:
- Instance Name: `mycatalogue`
- Domain: `example.com`
- Resulting URL: `example.com/mycatalogue`
Make sure your TLS credentials match the provided domain.
![step six (flow)](./docImage/step4.png?raw=true)

### 7. Configure Keycloak credentials
In this tab, you can set your **Keycloak username and password** or any authentication values you prefer. Additionally, you will define a user that the Federated Catalogue instance will use when authenticating through Keycloak.

Make sure the user has proper roles assigned, as required by your catalogue’s access policy.
![step seven (flow)](./docImage/step5.png?raw=true)

### 8. Information tab
After the service is successfully deployed, you can switch to the **Information** tab.
Here, the final URL of your deployed catalogue instance will be shown—ready to be copied and used for access or integration.
Click **Done** and then **Deploy**. Activate the Inject node.
![step eight (flow)](./docImage/step7.png?raw=true)
You should see JSON output in the Debug panel, showing catalogue entries.

---

## ⚙️ Configuration

Before running:

1. **Catalogue URL**  
   Set the URL of your federated catalogue instance.

2. **Query Parameters**  
   Provide any filters or search strings in the node editor or in `msg.payload`.

3. **Authorization Token (optional)**  
   Some catalogue endpoints require auth headers (Bearer token).

---

## 📁 Directory Contents
```
.
├── node-red-leanea-federated-catalogue-1.0.2.tgz
├── FederatedCatalogue.html
├── FederatedCatalogue.js
├── package.json
```

- **node-red-leanea-federated-catalogue-1.0.2.tgz**  
  Installable node package.

- **FederatedCatalogue.html**  
  Node-RED UI form.

- **FederatedCatalogue.js**  
  Backend logic to send API requests and return results.

- **package.json**  
  Metadata and dependencies.

---

## 📦 Dependencies

```json
"node": ">=14.0.0",
"node-red": ">=3.0.0"
```

---

## 🔗 Links & References

- [Federated Catalogue - XFSC](https://github.com/eclipse-xfsc/federated-catalogue)


---

## 📝 License

This project is licensed under the Apache License 2.0. See the [LICENSE](../LICENSE) file for details.
