#!/bin/sh
# From the workstation, over the public internet, with nothing installed:
#   1. each workspace hostname resolves to Ingressive's edge
#   2. each is served over TLS with a certificate a browser trusts, and lands on
#      the right workspace — two of them share port 3000 behind one edge
#   3. a websocket upgrade goes through (dev servers' HMR)
#   4. the controller wrote the hostname back to the Ingress
#
#   DOMAIN=its.matto.dev sh verify.sh
set -u
: "${DOMAIN:?set DOMAIN}"
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok    %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; }

echo "1. DNS: every workspace hostname is the edge"
edge=$(nslookup edge.ingressive.cloud 2>/dev/null | awk '/^Address:/{a=$2} END{print a}')
for h in envmux-probe-a envmux-probe-b envmux-probe-a-docs envmux-probe-ws; do
    got=$(nslookup "$h.$DOMAIN" 2>/dev/null | awk '/^Address:/{a=$2} END{print a}')
    if [ -n "$got" ] && [ "$got" = "$edge" ]; then ok "$h.$DOMAIN -> $got (edge)"; else bad "$h.$DOMAIN -> [${got:-none}] (edge is $edge)"; fi
done

echo
echo "2. TLS, trusted by this machine, to the right workspace"
for spec in "envmux-probe-a:workspace a via ingressive" "envmux-probe-b:workspace b via ingressive (also port 3000)" "envmux-probe-a-docs:workspace a, docs route, port 5173"; do
    h=${spec%%:*}; want=${spec#*:}
    body=$(curl -s --max-time 15 "https://$h.$DOMAIN/" 2>/dev/null | head -1); rc=$?
    if [ "$rc" = 0 ] && [ "$body" = "$want" ]; then ok "https://$h.$DOMAIN/ -> \"$body\""; else bad "https://$h.$DOMAIN/ -> curl $rc \"$body\" (wanted \"$want\")"; fi
done
issuer=$(echo | openssl s_client -connect "envmux-probe-a.$DOMAIN:443" -servername "envmux-probe-a.$DOMAIN" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null | sed 's/issuer=//')
san=$(echo | openssl s_client -connect "envmux-probe-a.$DOMAIN:443" -servername "envmux-probe-a.$DOMAIN" 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null | tail -1 | tr -s ' ')
if [ -n "$issuer" ]; then ok "certificate: $issuer; SAN$san"; else bad "no certificate read"; fi

echo
echo "3. WebSocket upgrade through the edge"
status=$(curl -s --max-time 10 -i -N --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "https://envmux-probe-ws.$DOMAIN/" 2>/dev/null | head -1 | tr -d '\r')
case $status in *101*) ok "$status" ;; *) bad "wanted 101, got: ${status:-nothing}" ;; esac

echo
echo "4. The controller wrote the hostname back"
for h in envmux-probe-a envmux-probe-b; do
    addr=$(kubectl get ingress "$h" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)
    if [ "$addr" = "$h.$DOMAIN" ]; then ok "ingress/$h ADDRESS $addr"; else bad "ingress/$h ADDRESS [${addr:-empty}]"; fi
done

echo
echo "5. Latency from here, 5 requests (tcp + TLS + edge + connector + pod)"
for _ in 1 2 3 4 5; do curl -s --max-time 15 -o /dev/null -w '  %{time_total}s (tls %{time_appconnect}s)\n' "https://envmux-probe-a.$DOMAIN/"; done

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
