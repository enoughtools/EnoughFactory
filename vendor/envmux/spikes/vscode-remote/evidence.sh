#!/bin/sh
# Collect what happened: the shim's view, the extension's log, and the instance's view.
cd "$(dirname "$0")"
export DOCKER_HOST=npipe:////./pipe/envmux-docker MSYS_NO_PATHCONV=1
echo "### shim.log (requests since launch)"; grep -vE "GET /containers/[^/]+/json|GET /_ping" shim.log | tail -${1:-60}
echo; echo "### containers"; docker ps -a --filter label=devcontainer.local_folder --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Label "devcontainer.local_folder"}}'
ID=$(docker ps -q --filter "label=devcontainer.local_folder=C:\Users\Matt\envmux-demo" | head -1)
if [ -n "$ID" ]; then
  echo; echo "### inside $ID"; docker exec "$ID" sh -c 'hostname; ls -la /workspaces/envmux-demo; echo; ls ~/.vscode-server/bin 2>/dev/null; echo; ps -eo pid,user,etime,args | grep -E "vscode|code-server|node " | grep -v grep | cut -c1-160'
fi
LOG=$(ls -dt "$APPDATA"/Code/logs/*/window*/exthost/ms-vscode-remote.remote-containers 2>/dev/null | head -1)
echo; echo "### extension log: $LOG"; [ -n "$LOG" ] && ls -t "$LOG" | head -3 && tail -${2:-40} "$LOG/$(ls -t "$LOG" | head -1)"
