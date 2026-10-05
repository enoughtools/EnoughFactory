#!/bin/sh
# Stand up the hub and two pretend sessions on the dev cluster.
#
#   KUBECONFIG=… sh deploy.sh
#
# What goes up:
#   sess-a, sess-b, sess-a-docs   pretend session workloads: each answers its own
#                                 name over plain HTTP, two of them on port 3000
#                                 to make the collision the hub has to resolve
#   envmux-hub (Service)          one public IP, UDP 53 + TCP 3000 + TCP 5173
#   envmux-hub (Deployment)       coredns answering *.envmux -> that public IP,
#                                 and nginx terminating mTLS with the envmux CA,
#                                 routing by server name to the session behind it
set -eu

here=$(cd "$(dirname "$0")" && pwd)
certs="$here/certs"
[ -f "$certs/hub.crt" ] || { echo "deploy.sh: run certs.sh first" >&2; exit 1; }

# The hub's Service first: the DNS answer has to be the address the load
# balancer gives it, and that is only known once the Service exists.
kubectl apply -f - <<'EOF' >/dev/null
apiVersion: v1
kind: Service
metadata:
  name: envmux-hub
  labels: {app: envmux-hub}
spec:
  type: LoadBalancer
  selector: {app: envmux-hub}
  ports:
  - {name: dns, port: 53, protocol: UDP, targetPort: 5353}
  - {name: app3000, port: 3000, protocol: TCP, targetPort: 3000}
  - {name: app5173, port: 5173, protocol: TCP, targetPort: 5173}
EOF

ip=""
for _ in $(seq 24); do
    ip=$(kubectl get svc envmux-hub -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
    [ -n "$ip" ] && break
    sleep 5
done
[ -n "$ip" ] || { echo "deploy.sh: no external IP for envmux-hub after 120 s" >&2; exit 1; }
echo "hub public IP: $ip"
echo "$ip" > "$here/hub.ip"

# Pretend sessions. Two on 3000 on purpose.
for spec in "sess-a:3000:session a, port 3000" "sess-b:3000:session b, port 3000" "sess-a-docs:5173:session a, port 5173 (docs)"; do
    name=${spec%%:*}; rest=${spec#*:}; port=${rest%%:*}; text=${rest#*:}
    kubectl apply -f - <<EOF >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: {name: $name}
spec:
  replicas: 1
  selector: {matchLabels: {app: $name}}
  template:
    metadata: {labels: {app: $name}}
    spec:
      containers:
      - name: echo
        image: hashicorp/http-echo:1.0
        args: ["-listen=:$port", "-text=$text"]
        ports: [{containerPort: $port}]
---
apiVersion: v1
kind: Service
metadata: {name: $name}
spec:
  selector: {app: $name}
  ports: [{port: $port, targetPort: $port}]
EOF
done

# The certificates, as a Secret the hub mounts. In envmux proper these are the
# per-session leaf and the same root; here one wildcard for the whole zone.
kubectl create secret generic envmux-hub-tls \
    --from-file=tls.crt="$certs/hub.crt" --from-file=tls.key="$certs/hub.key" --from-file=ca.crt="$certs/ca.crt" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# DNS: every name under the zone is the hub. The hub then tells sessions apart
# by the name the client asked for in the TLS handshake.
kubectl create configmap envmux-hub-dns --from-literal=Corefile="
envmux:5353 {
    template IN A envmux {
        answer \"{{ .Name }} 60 IN A $ip\"
    }
    log
    errors
}
" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# mTLS at the edge, one server block per (port, session name). A client with no
# certificate from our CA never gets past the handshake; a client naming a
# session that does not exist gets 421 from the default block. The upstream is
# plain HTTP to the session's ClusterIP service — inside the cluster, where the
# session pod is the only thing on that name.
kubectl create configmap envmux-hub-nginx --from-literal=nginx.conf="
events {}
http {
    ssl_certificate        /tls/tls.crt;
    ssl_certificate_key    /tls/tls.key;
    ssl_client_certificate /tls/ca.crt;
    ssl_verify_client      on;
    ssl_protocols          TLSv1.3;

    server { listen 3000 ssl default_server; server_name _; return 421; }
    server { listen 5173 ssl default_server; server_name _; return 421; }

    server {
        listen 3000 ssl; server_name a.envmux;
        location / { proxy_pass http://sess-a:3000; proxy_set_header Host \$host; add_header X-Envmux-Client \$ssl_client_s_dn always; }
    }
    server {
        listen 3000 ssl; server_name b.envmux;
        location / { proxy_pass http://sess-b:3000; proxy_set_header Host \$host; add_header X-Envmux-Client \$ssl_client_s_dn always; }
    }
    server {
        listen 5173 ssl; server_name a.envmux;
        location / { proxy_pass http://sess-a-docs:5173; proxy_set_header Host \$host; add_header X-Envmux-Client \$ssl_client_s_dn always; }
    }
}
" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

kubectl apply -f - <<'EOF' >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: {name: envmux-hub}
spec:
  replicas: 1
  selector: {matchLabels: {app: envmux-hub}}
  template:
    metadata: {labels: {app: envmux-hub}}
    spec:
      containers:
      - name: dns
        image: coredns/coredns:1.12.1
        args: ["-conf", "/etc/coredns/Corefile"]
        ports: [{containerPort: 5353, protocol: UDP}]
        volumeMounts: [{name: dns, mountPath: /etc/coredns}]
      - name: edge
        image: nginx:1.27-alpine
        ports: [{containerPort: 3000}, {containerPort: 5173}]
        volumeMounts:
        - {name: nginx, mountPath: /etc/nginx/nginx.conf, subPath: nginx.conf}
        - {name: tls, mountPath: /tls, readOnly: true}
      volumes:
      - {name: dns, configMap: {name: envmux-hub-dns}}
      - {name: nginx, configMap: {name: envmux-hub-nginx}}
      - {name: tls, secret: {secretName: envmux-hub-tls}}
EOF

kubectl rollout status deployment/envmux-hub --timeout=120s
kubectl rollout status deployment/sess-a --timeout=120s >/dev/null
kubectl rollout status deployment/sess-b --timeout=120s >/dev/null
kubectl rollout status deployment/sess-a-docs --timeout=120s >/dev/null
echo "up. now: sh verify.sh"
