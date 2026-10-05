#!/bin/sh
# Take the pretend workspaces down. Deleting the Ingress is what deletes the
# Site on Ingressive — the controller reconciles the removal, so the hostname
# stops answering within a minute. The controller itself is left installed:
# it is the swap, not the probe.
#
#   KUBECONFIG=… sh cleanup.sh [--controller]   # --controller uninstalls it too
set -u
for n in envmux-probe-a envmux-probe-b envmux-probe-a-docs envmux-probe-ws; do
    kubectl delete ingress,service,deployment "$n" --ignore-not-found
done

if [ "${1:-}" = "--controller" ]; then
    helm uninstall ingressive-controller --namespace ingressive-system
    kubectl delete namespace ingressive-system --ignore-not-found
fi
