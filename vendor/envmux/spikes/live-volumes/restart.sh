#!/bin/sh
# Rebuild the workstation half and put it back up. The spike's inner loop.
set -e

# Extra server arguments, quoted for Start-Process: sh restart.sh --live claude/projects
EXTRA=""
for a in "$@"; do EXTRA="$EXTRA,'$a'"; done
here=$(cd "$(dirname "$0")" && pwd)

# taskkill rather than Stop-Process: synchronous, and it does not hang when the
# process is mid-request the way the PowerShell path was seen to.
taskkill //IM envmux-live.exe //F >/dev/null 2>&1 || true
sleep 1

dotnet build -c Release -v q --nologo "$here/server" >/dev/null

powershell.exe -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath '$(cygpath -w "$here/server/bin/Release/net10.0/envmux-live.exe")' -ArgumentList '--session','livespike','--port','8079','--token','spiketoken1234','--verbose'$EXTRA -RedirectStandardOutput '$(cygpath -w "$here/live.out")' -RedirectStandardError '$(cygpath -w "$here/live.log")'"
sleep 1
head -6 "$here/live.out"
