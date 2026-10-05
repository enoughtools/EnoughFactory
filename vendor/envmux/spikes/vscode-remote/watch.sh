#!/bin/sh
cd "$(dirname "$0")"
LOG="$1"; PAT="$2"; MAX="${3:-240}"; START=$(wc -l < "$LOG" 2>/dev/null || echo 0); T=0
while [ $T -lt $MAX ]; do sleep 3; T=$((T+3)); if tail -n +$((START+1)) "$LOG" 2>/dev/null | grep -qE "$PAT"; then break; fi; done
echo "(watched ${T}s)"
