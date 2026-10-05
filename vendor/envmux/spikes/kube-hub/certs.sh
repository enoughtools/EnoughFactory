#!/bin/sh
# Mint the hub's server certificate and one client certificate from the CA
# envmux already has (~/.envmux/envmux-ca.{crt,key}, the root `envmux ca`
# trusts on this machine). Nothing new is trusted anywhere: the browser and
# curl already believe this root, and the hub is told to believe it for clients.
#
#   sh certs.sh [client-name]
#
# Writes into ./certs — every private key there is git-ignored.
set -eu

# Git Bash rewrites an argument that starts with a slash into a Windows path,
# which turns -subj /O=envmux into C:/Program Files/Git/O=envmux. Off, for
# the whole script; nothing here wants a path converted.
export MSYS_NO_PATHCONV=1

# Windows-style paths (Z:/…), because openssl here is a Windows binary and with
# path conversion off it would be handed /z/… and not find it.
here=$(cd "$(dirname "$0")" && pwd)
command -v cygpath >/dev/null 2>&1 && here=$(cygpath -m "$here")
ca="$HOME/.envmux"
command -v cygpath >/dev/null 2>&1 && ca=$(cygpath -m "$ca")
out="$here/certs"
client=${1:-$(whoami)}

mkdir -p "$out"
cp "$ca/envmux-ca.crt" "$out/ca.crt"

# The hub answers for every session name at once, so its certificate is a
# wildcard on the zone. A per-session certificate (what envmux issues today)
# would work too, one server block each; the wildcard is what makes the proof
# short.
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$out/hub.key" -subj "/O=envmux/CN=envmux hub" -out "$out/hub.csr"

printf 'subjectAltName=DNS:*.envmux,DNS:envmux\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' > "$out/hub.ext"

openssl x509 -req -in "$out/hub.csr" -CA "$out/ca.crt" -CAkey "$ca/envmux-ca.key" \
    -CAcreateserial -days 30 -sha384 -extfile "$out/hub.ext" -out "$out/hub.crt"

# The client certificate is the thing that turns a public IP into a private
# one: without it the handshake does not complete and no request is ever seen.
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$out/client.key" -subj "/O=envmux/CN=$client" -out "$out/client.csr"

printf 'extendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE\n' > "$out/client.ext"

openssl x509 -req -in "$out/client.csr" -CA "$out/ca.crt" -CAkey "$ca/envmux-ca.key" \
    -CAcreateserial -days 30 -sha384 -extfile "$out/client.ext" -out "$out/client.crt"

# For a browser: one file to import into the personal store. `envmux ca` put the
# root in; this is the other half of "pre-installed".
# -legacy: RC2/3DES rather than AES-256/PBKDF2, because the Windows certificate
# store and schannel refuse the modern defaults an OpenSSL 3 export uses.
openssl pkcs12 -export -legacy -inkey "$out/client.key" -in "$out/client.crt" \
    -name "envmux $client" -passout pass:envmux -out "$out/client.pfx"

rm -f "$out"/*.csr "$out"/*.ext "$out"/*.srl

echo "hub:    $(openssl x509 -in "$out/hub.crt" -noout -subject -ext subjectAltName | tr '\n' ' ')"
echo "client: $(openssl x509 -in "$out/client.crt" -noout -subject)"
echo "pfx:    $out/client.pfx (password: envmux)"
