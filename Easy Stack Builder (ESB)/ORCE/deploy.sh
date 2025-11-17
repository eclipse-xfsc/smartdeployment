#!/usr/bin/env bash
# Refactored deployment script for XFSC Orchestration Engine
# Usage:
#   $0 SUFFIX KUBECONFIG HOST CERTFILE PVTKEYFILE [IMAGE_TAG] [USERNAME PASSWORD]
# Examples:
#   $0 demo ~/.kube/config example.com cert.crt key.key
#   $0 demo ~/.kube/config example.com cert.crt key.key 2.0.0 user pass

set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 SUFFIX KUBECONFIG HOST CERTFILE PVTKEYFILE [IMAGE_TAG] [USERNAME PASSWORD]

Positional arguments:
  SUFFIX       Unique suffix for namespacing (e.g. "demo")
  KUBECONFIG   Path to kubeconfig
  HOST         Hostname for ingress
  CERTFILE     TLS certificate file
  PVTKEYFILE   TLS private key file

Optional arguments:
  IMAGE_TAG    Container image tag (default: 1.0.8)
  USERNAME     Admin username (requires PASSWORD)
  PASSWORD     Admin password (requires USERNAME)

If USERNAME and PASSWORD are both provided, adminAuth is enabled.
If neither is provided, adminAuth is omitted.
EOF
  exit 1
}

# Validate argument count
if [ $# -lt 5 ] || [ $# -gt 8 ]; then
  usage
fi

# Required args
SUFFIX=$1
KUBECONFIG=$2
HOST=$3
CERTFILE=$4
PVTKEYFILE=$5

# Defaults
IMAGE_TAG="1.0.8"
USERNAME=""
PASSWORD=""

# Parse optional args
case $# in
  6)
    IMAGE_TAG=$6
    ;;
  7)
    USERNAME=$6
    PASSWORD=$7
    ;;
  8)
    IMAGE_TAG=$6
    USERNAME=$7
    PASSWORD=$8
    ;;
esac

# Validate auth pair
if { [ -n "$USERNAME" ] && [ -z "$PASSWORD" ]; } || { [ -z "$USERNAME" ] && [ -n "$PASSWORD" ]; }; then
  echo "Error: both USERNAME and PASSWORD must be provided together." >&2
  exit 1
fi
# 1. create ingressclass 


# 2. Namespace
kubectl --kubeconfig $KUBECONFIG create namespace xfsc-orce-$SUFFIX --dry-run=client -o yaml \
  | kubectl --kubeconfig $KUBECONFIG apply -f -

# 3. ServiceAccount
kubectl --kubeconfig $KUBECONFIG create serviceaccount xfsc-orce-sa -n xfsc-orce-$SUFFIX --dry-run=client -o yaml \
  | kubectl --kubeconfig $KUBECONFIG apply -f -

# 4. ClusterRole
kubectl --kubeconfig $KUBECONFIG apply -f - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: xfsc-orce-$SUFFIX-deployer
rules:
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get","list","create","delete"]
- apiGroups: [""]
  resources: ["configmaps","services"]
  verbs: ["get","list","create","patch","delete"]
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get","list","create","delete"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses","ingressclasses"]
  verbs: ["get","list","create","patch"]
EOF

# 5. ClusterRoleBinding
kubectl --kubeconfig $KUBECONFIG apply -f - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: xfsc-orce-$SUFFIX-deployer-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: xfsc-orce-$SUFFIX-deployer
subjects:
- kind: ServiceAccount
  name: xfsc-orce-sa
  namespace: xfsc-orce-$SUFFIX
EOF

# 6. ConfigMap (settings.js)

auth() {
  export NODE_RED_HASH=$(node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 8));" $PASSWORD)
  kubectl --kubeconfig $KUBECONFIG apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: xfsc-orce-settings
  namespace: xfsc-orce-$SUFFIX
data:
  settings.js: |
    module.exports = {
      httpAdminRoot: "/$SUFFIX",
      httpNodeRoot: "/$SUFFIX",
      flowFile: "flows.json",
      httpStatic: [{path: "/data/dynamicsrc/", root: "/$SUFFIX/dynamicsrc/"}],
      flowFilePretty: true,
      uiPort: process.env.PORT || 1880,
      adminAuth: {
        type: "credentials",
        users: [{
            username: "$USERNAME",
            password: "$NODE_RED_HASH",
            permissions: "*"
        }]
      },
      uiPort: process.env.PORT || 1880,
      diagnostics: {
        enabled: true,
        ui: true,
      },
      runtimeState: {
        enabled: false,
        ui: false,
      },
      logging: {
        console: {
          level: "info",
          metrics: false,
          audit: false,
        },
      },
      exportGlobalContextKeys: false,
      externalModules: {
      },
      editorTheme: {
        page: {
          title: "XFSC Orchestration Engine",
          css: '/data/guided-style.css',
          scripts: '/data/guided-script.js'
        },
        palette: {
        },
      
        projects: {
          enabled: false,
          workflow: {
            mode: "manual",
          },
        },
        codeEditor: {
          lib: "monaco",
          options: {
          },
        },
      },
      functionExternalModules: true,
      functionGlobalContext: {
      },
      debugMaxLength: 1000,
      mqttReconnectTime: 15000,
      serialReconnectTime: 15000,
    };
EOF
}

noauth() {
    kubectl --kubeconfig $KUBECONFIG apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: xfsc-orce-settings
  namespace: xfsc-orce-$SUFFIX
data:
  settings.js: |
    module.exports = {
      httpAdminRoot: "/$SUFFIX",
      httpNodeRoot: "/$SUFFIX",
      flowFile: "flows.json",
      httpStatic: [{path: "/data/dynamicsrc/", root: "/$SUFFIX/dynamicsrc/"}],
      flowFilePretty: true,
      uiPort: process.env.PORT || 1880,
      diagnostics: {
        enabled: true,
        ui: true,
      },
      runtimeState: {
        enabled: false,
        ui: false,
      },
      logging: {
        console: {
          level: "info",
          metrics: false,
          audit: false,
        },
      },
      exportGlobalContextKeys: false,
      externalModules: {
      },
      editorTheme: {
        page: {
          title: "XFSC Orchestration Engine",
          css: '/data/guided-style.css',
          scripts: '/data/guided-script.js'
        },
        palette: {
        },
      
        projects: {
          enabled: false,
          workflow: {
            mode: "manual",
          },
        },
        codeEditor: {
          lib: "monaco",
          options: {
          },
        },
      },
      functionExternalModules: true,
      functionGlobalContext: {
      },
      debugMaxLength: 1000,
      mqttReconnectTime: 15000,
      serialReconnectTime: 15000,
    };
EOF
}

if [ -n "$USERNAME" ] && [ -n "$PASSWORD" ]; then
  auth
else
  noauth
fi

# 7. Deployment
kubectl --kubeconfig $KUBECONFIG apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: xfsc-orce
  namespace: xfsc-orce-$SUFFIX
  labels:
    app: xfsc-orce
spec:
  replicas: 1
  selector:
    matchLabels:
      app: xfsc-orce
  template:
    metadata:
      labels:
        app: xfsc-orce
    spec:
      serviceAccountName: xfsc-orce-sa
      containers:
      - name: orce
        image: leanea/facis-xfsc-orce:${IMAGE_TAG}
        ports:
        - containerPort: 1880
        volumeMounts:
        - name: settings
          mountPath: /data/settings.js
          subPath: settings.js
      volumes:
      - name: settings
        configMap:
          name: xfsc-orce-settings
EOF

# 8. Service
kubectl --kubeconfig $KUBECONFIG apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: xfsc-orce-service-$SUFFIX
  namespace: xfsc-orce-$SUFFIX
spec:
  type: ClusterIP
  selector:
    app: xfsc-orce
  ports:
  - port: 80
    targetPort: 1880
    protocol: TCP
    name: http
EOF

# 9. TLS Secret
kubectl --kubeconfig $KUBECONFIG create secret tls orce-tls-secret \
  --namespace xfsc-orce-$SUFFIX \
  --cert=$CERTFILE \
  --key=$PVTKEYFILE \
  --dry-run=client -o yaml \
  | kubectl --kubeconfig $KUBECONFIG apply -f -

# 10. Ingress
kubectl --kubeconfig $KUBECONFIG delete validatingwebhookconfiguration ingress-nginx-admission --ignore-not-found
kubectl --kubeconfig $KUBECONFIG apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: orce-cluster-ingress
  namespace: xfsc-orce-$SUFFIX
  annotations:
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
spec:
  ingressClassName: nginx-orce-cluster
  rules:
  - host: "$HOST"
    http:
      paths:
      - path: /$SUFFIX
        pathType: Prefix
        backend:
          service:
            name: xfsc-orce-service-$SUFFIX
            port:
              number: 80
  tls:
  - hosts: ["$HOST"]
    secretName: orce-tls-secret
EOF
sleep 3
kubectl --kubeconfig $KUBECONFIG patch ingress orce-cluster-ingress -n xfsc-orce-$SUFFIX \
  -p '{"metadata": {"annotations": {"reconcile-timestamp": "'$(date +%s)'"}}}'
