#!/bin/sh
# Take everything deploy.sh (and the earlier probes) put on the cluster back down.
#   KUBECONFIG=… sh cleanup.sh
set -u
kubectl delete deployment envmux-hub sess-a sess-b sess-a-docs envmux-lbprobe --ignore-not-found
kubectl delete service envmux-hub sess-a sess-b sess-a-docs envmux-lbprobe --ignore-not-found
kubectl delete configmap envmux-hub-dns envmux-hub-nginx --ignore-not-found
kubectl delete secret envmux-hub-tls --ignore-not-found
kubectl delete pod envmux-probe --ignore-not-found --wait=false
rm -f "$(dirname "$0")/hub.ip"
echo "down. certs/ is left in place; delete it yourself if you want the keys gone."
