#!/bin/sh
# Restart the shim (node) and, on Windows, the message-mode pipe relay (.NET).
cd "$(dirname "$0")"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'node.exe' -and \$_.CommandLine -like '*shim.mjs*') -or \$_.Name -eq 'relay.exe' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1
sleep 1
(node shim.mjs > shim.out 2>&1 &)
(./relay/bin/Release/net10.0-windows/relay.exe > relay.out 2>&1 &)
sleep 2
tail -2 shim.out; cat relay.out; exit 0
