#!/bin/sh
# From the workstation, prove the three claims against the hub deploy.sh put up:
#   1. the hub answers DNS for *.envmux with its own public IP
#   2. a client holding a certificate from the envmux CA reaches each session by
#      name, on the same public IP and port, and lands on the right one
#   3. a client without one gets nothing, and an unknown name gets 421
#
#   sh verify.sh
#
# openssl s_client rather than curl for the TLS legs: Git Bash ships a
# schannel-built curl that cannot load a PEM client certificate ("Failed to
# import cert file", 0x80092002) and rejects an OpenSSL 3 PFX
# (SEC_E_UNKNOWN_CREDENTIALS). openssl is OpenSSL-backed and speaks to the hub
# exactly as a browser with the PFX installed will. -servername is the SNI the
# hub routes on; it stands in for the NRPT rule that would point .envmux there.
set -u
export MSYS_NO_PATHCONV=1

here=$(cd "$(dirname "$0")" && pwd)
certs="$here/certs"
ip=$(cat "$here/hub.ip")
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok    %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; }
w()   { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf %s "$1"; fi; }

# mtls <name> <port> [with-cert]: HTTP status on stdout; response in .resp, body in .body
mtls() {
    cert=""
    [ "${3:-cert}" = cert ] && cert="-cert $(w "$certs/client.crt") -key $(w "$certs/client.key")"
    printf 'GET / HTTP/1.1\r\nHost: %s:%s\r\nConnection: close\r\n\r\n' "$1" "$2" |
      timeout 20 openssl s_client -connect "$ip:$2" -servername "$1" -CAfile "$(w "$certs/ca.crt")" $cert -quiet \
      > "$here/.resp" 2>/dev/null
    code=$(awk '/^HTTP\//{print $2; exit}' "$here/.resp")
    awk 'hdr && NF{print} /^\r?$/{hdr=1}' "$here/.resp" | tr -d '\r' > "$here/.body"
    printf %s "${code:-000}"
}

echo "hub: $ip"
echo
echo "1. DNS from the cluster, over the public internet"
for name in a.envmux b.envmux anything-at-all.envmux; do
    got=$(nslookup -type=A "$name" "$ip" 2>/dev/null | awk '/^Address:/{a=$2} END{print a}')
    if [ "$got" = "$ip" ]; then ok "$name -> $got"; else bad "$name -> [${got:-no answer}] (wanted $ip)"; fi
done

echo
echo "2. mTLS: the right session, by name, on a shared public IP and port"
for spec in "a.envmux:3000:session a, port 3000" "b.envmux:3000:session b, port 3000" "a.envmux:5173:session a, port 5173 (docs)"; do
    name=${spec%%:*}; rest=${spec#*:}; port=${rest%%:*}; want=${rest#*:}
    code=$(mtls "$name" "$port"); body=$(head -1 "$here/.body")
    if [ "$code" = 200 ] && [ "$body" = "$want" ]; then ok "https://$name:$port -> $code \"$body\""; else bad "https://$name:$port -> $code \"$body\" (wanted \"$want\")"; fi
done
mtls a.envmux 3000 >/dev/null
who=$(awk -F': ' 'tolower($1)=="x-envmux-client"{print $2}' "$here/.resp" | tr -d '\r')
if [ -n "$who" ]; then ok "the hub saw the client as: $who"; else bad "no client identity header"; fi

echo
echo "3. Refusals"
code=$(mtls a.envmux 3000 nocert)
if [ "$code" = 400 ]; then ok "no client certificate -> 400 (No required SSL certificate was sent)"; else bad "no client certificate -> $code (wanted 400)"; fi
code=$(mtls c.envmux 3000)
if [ "$code" = 421 ]; then ok "unknown session name -> 421"; else bad "unknown session name -> $code (wanted 421)"; fi
# A stranger: no CA to verify the hub with, no client certificate. curl is fine
# for this one because there is no certificate to load.
code=$(curl -s --max-time 10 --resolve "a.envmux:3000:$ip" "https://a.envmux:3000/" -o /dev/null -w '%{http_code}' 2>/dev/null); rc=$?
if [ "$rc" != 0 ]; then ok "a stranger (no CA, no cert) -> refused (curl exit $rc)"; else bad "a stranger got $code"; fi

echo
echo "4. Latency from here: tcp + TLS 1.3 with client cert + request, 5 times"
for _ in 1 2 3 4 5; do
    S=$(date +%s%N); mtls a.envmux 3000 >/dev/null; E=$(date +%s%N); echo "  $(( (E-S)/1000000 )) ms"
done

rm -f "$here/.body" "$here/.resp"
echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
