#!/bin/sh
# Three pretend workspaces behind Ingressive on the dev cluster.
#
#   KUBECONFIG=… DOMAIN=its.matto.dev sh deploy.sh
#
# Assumes the Ingressive controller is installed (`.context/ingressive` is the
# recipe: namespace, credentials Secret, helm install) and DOMAIN is connected
# in the Ingressive console. Each workspace route is one Ingress with one host
# under DOMAIN and ingressClassName ingressive; the controller turns it into a
# Site, the paired connector dials out, Ingressive issues the certificate.
#
#   envmux-probe-a       port 3000   "workspace a"
#   envmux-probe-b       port 3000   "workspace b"   ← same port, its own hostname
#   envmux-probe-a-docs  port 5173   a's second route, its own hostname
#   envmux-probe-ws      port 8080   a websocket echo, for the HMR question
set -eu

: "${DOMAIN:?set DOMAIN to the domain connected in the Ingressive console}"

mk() { # mk <name> <port> <image> <args-json>
kubectl apply -f - <<EOF >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: {name: $1}
spec:
  replicas: 1
  selector: {matchLabels: {app: $1}}
  template:
    metadata: {labels: {app: $1}}
    spec:
      containers:
      - name: app
        image: $3
        args: $4
        ports: [{containerPort: $2}]
---
apiVersion: v1
kind: Service
metadata: {name: $1}
spec:
  selector: {app: $1}
  ports: [{port: $2, targetPort: $2}]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: {name: $1}
spec:
  ingressClassName: ingressive
  rules:
  - host: $1.$DOMAIN
    http:
      paths:
      - path: /
        pathType: Prefix
        backend: {service: {name: $1, port: {number: $2}}}
EOF
echo "  $1.$DOMAIN -> $1:$2"
}

mk envmux-probe-a      3000 hashicorp/http-echo:1.0    '["-listen=:3000","-text=workspace a via ingressive"]'
mk envmux-probe-b      3000 hashicorp/http-echo:1.0    '["-listen=:3000","-text=workspace b via ingressive (also port 3000)"]'
mk envmux-probe-a-docs 5173 hashicorp/http-echo:1.0    '["-listen=:5173","-text=workspace a, docs route, port 5173"]'
mk envmux-probe-ws     8080 jmalloc/echo-server:0.3.6  '[]'

echo "applied. Ingressive takes about a minute to have all four answering: sh verify.sh"
