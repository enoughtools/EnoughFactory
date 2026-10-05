using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;

using Envmux.Commands;

namespace Envmux.Host;

/// <summary>
/// The one script that makes an Incus host ready for an envmux workstation.
/// </summary>
/// <remarks>
/// <para>
/// Onboarding a remote was a conversation: is the API listening on the network,
/// which of the machine's addresses is the LAN one, is forwarding on, is Docker
/// there — because Docker sets the FORWARD policy to DROP and routed traffic to
/// an Incus bridge dies in it without a word — and then
/// <c>incus config trust add</c>, and the token carried back by hand. Every one
/// of those is a question with a command for an answer, so they are one script:
/// run it on the host, and the last line it prints is everything
/// <c>envmux install --token</c> needs.
/// </para>
/// <para>
/// It is a script and not something envmux does over the API because none of it
/// <em>can</em> be done over the API — until the token exists the daemon does not
/// know us, and the firewall and <c>sysctl</c> are not the daemon's to change
/// at all. And it is printed, to be read, rather than fetched and piped into a
/// shell: it changes a firewall as root, and the person whose machine that is
/// gets to see what it will do first. <c>--check</c> exists for the same reason.
/// </para>
/// <para>
/// What it will not do is as deliberate as what it does. It never changes a
/// <c>core.https_address</c> somebody set; it never adds a second mechanism
/// where the host's owner already has one that accepts the bridge (the first
/// real remote did: a oneshot unit of their own, doing exactly this); and it
/// does not guess at a firewall it does not recognise.
/// </para>
/// </remarks>
internal static class HostPrep
{
    /// <summary>What the token's line starts with — the last line the script prints.</summary>
    public const string TokenMarker = "ENVMUX-TOKEN: ";

    /// <summary>
    /// The script.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Wrapped in <c>bash -s &lt;&lt;'…'</c> so that it can be pasted into a
    /// terminal as well as run from a file: pasted bare, its <c>set -e</c> would
    /// become the login shell's and its first <c>exit</c> would close the
    /// session the person is reading it in.
    /// </para>
    /// <para>
    /// The firewall is matched by the bridge's <em>interface</em>, not by the
    /// range. That is what people who have already solved this did, it survives
    /// the range being changed, and iptables accepts a rule naming an interface
    /// that does not exist yet — so this can run before <c>envmux install</c>
    /// has created the network.
    /// </para>
    /// </remarks>
    /// <param name="network">The Incus network sessions attach to, which is also the bridge interface's name.</param>
    /// <param name="cidr">Its range — <see cref="HostConfig.Cidr"/>. Said, not used: a person should see what is being let through.</param>
    /// <param name="clientName">What this workstation is called in <c>incus config trust list</c>.</param>
    /// <param name="check">Bake <c>--check</c> in, for a script that cannot be passed arguments because it is being pasted.</param>
    /// <exception cref="ArgumentException">A parameter is not something that can safely be written into a shell script.</exception>
    public static string Script(string network, string cidr, string clientName, bool check = false)
    {
        if (network.Length is 0 or > 15 || !network.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.'))
        {
            throw new ArgumentException($"'{network}' is not an Incus network name", nameof(network));
        }

        if (clientName.Length is 0 or > 64 ||
            clientName.StartsWith('-') ||
            !clientName.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.'))
        {
            throw new ArgumentException(
                $"'{clientName}' is not a client name: letters, digits, '-', '_' and '.', not starting with '-'",
                nameof(clientName));
        }

        return Template
            .ReplaceLineEndings("\n")
            .Replace("__BRIDGE__", network, StringComparison.Ordinal)
            .Replace("__RANGE__", Range(cidr), StringComparison.Ordinal)
            .Replace("__NAME__", clientName, StringComparison.Ordinal)
            .Replace("__CHECK__", check ? "1" : "0", StringComparison.Ordinal)
            .Replace("__COMMAND__", CommandName.Current, StringComparison.Ordinal);
    }

    /// <summary>The range as a network — <c>10.100.0.0/24</c> for a bridge at <c>10.100.0.1/24</c>.</summary>
    private static string Range(string cidr)
    {
        var parts = cidr.Split('/');

        if (parts.Length != 2 ||
            !IPAddress.TryParse(parts[0], out var address) ||
            address.AddressFamily != AddressFamily.InterNetwork ||
            !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var prefix) ||
            prefix is < 8 or > 30)
        {
            throw new ArgumentException($"'{cidr}' is not an IPv4 range like {HostConfig.DefaultCidr}", nameof(cidr));
        }

        var range = new HostConfig { Cidr = cidr }.Range;
        return $"{range.BaseAddress}/{range.PrefixLength.ToString(CultureInfo.InvariantCulture)}";
    }

    /// <summary>
    /// The token, from whatever the script printed.
    /// </summary>
    /// <remarks>
    /// The last marked line, with a terminal's carriage returns taken off — over
    /// <c>ssh -t</c> every line ends in one. Null unless what follows the marker
    /// really is a token, which is also what makes a <c>--check</c> run, whose
    /// last line says there is none, come back as null rather than as a string
    /// to be sent to a daemon.
    /// </remarks>
    public static string? TokenFrom(string output)
    {
        var line = output
            .Split('\n')
            .Select(l => l.Trim())
            .LastOrDefault(l => l.StartsWith(TokenMarker, StringComparison.Ordinal));

        var text = line?[TokenMarker.Length..].Trim();

        return TrustToken.TryParse(text, out _) ? text : null;
    }

    /// <summary>
    /// The <c>ssh</c> invocation that runs the script on a host, as arguments.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Built and nothing more: no password, key or agent is touched here. ssh
    /// asks for whatever it needs, of the person, on the terminal it is given.
    /// </para>
    /// <para>
    /// The script travels as an argument, base64 so that no quoting survives to
    /// go wrong, and <em>not</em> down stdin as <c>bash -s</c> would have it.
    /// stdin has to stay the terminal: the script runs <c>sudo</c>, sudo reads
    /// the password from the tty, and <c>-t</c> only allocates one when ssh's
    /// own stdin is one. Piped, the script would either get no tty at all or —
    /// forced with <c>-tt</c> — be typed into it, where sudo would read the
    /// next line of the script as the password.
    /// </para>
    /// <para>
    /// A target beginning with <c>-</c> is refused rather than passed on, since
    /// ssh would read it as an option; <c>-oProxyCommand=…</c> is a command.
    /// </para>
    /// </remarks>
    /// <param name="target"><c>user@host</c>, or a <c>Host</c> from the person's ssh config.</param>
    /// <param name="script">From <see cref="Script"/>.</param>
    /// <param name="check">Pass <c>--check</c> to it.</param>
    public static IReadOnlyList<string> SshCommandLine(string target, string script, bool check)
    {
        if (target.Length == 0 || target.StartsWith('-') || target.Any(c => char.IsWhiteSpace(c) || char.IsControl(c)))
        {
            throw new ArgumentException($"'{target}' is not an ssh destination like user@host", nameof(target));
        }

        var encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(script.ReplaceLineEndings("\n")));

        return
        [
            "ssh",
            "-t",
            target,
            $"bash -c \"$(printf %s {encoded} | base64 -d)\" envmux-prepare{(check ? " --check" : "")}",
        ];
    }

    private const string Template =
        """
        # envmux host prepare: gets this Incus host ready for an envmux workstation.
        #
        #   network  __BRIDGE__  (__RANGE__)
        #   client   __NAME__
        #
        # Paste it into a shell on the Incus host, or save it and run `bash prepare.sh [--check]`.
        # Safe to run twice. With --check it reads and reports, and changes nothing.
        # The last line it prints is the token: __COMMAND__ install --token <that>
        bash -s -- "$@" <<'ENVMUX_PREPARE'
        set -euo pipefail

        BRIDGE='__BRIDGE__'
        RANGE='__RANGE__'
        NAME='__NAME__'
        CHECK=__CHECK__
        if [ "${1:-}" = "--check" ]; then CHECK=1; fi

        ok()   { printf '  ok     %s\n' "$*"; }
        info() { printf '  info   %s\n' "$*"; }
        warn() { printf '  WARN   %s\n' "$*"; }
        act()  { if [ "$CHECK" = 1 ]; then printf '  would  %s\n' "$*"; else printf '  doing  %s\n' "$*"; fi; }
        fail() { printf '  FAILED %s\n' "$*" >&2; exit 1; }

        printf 'envmux host prepare: network %s (%s), client %s\n' "$BRIDGE" "$RANGE" "$NAME"
        if [ "$CHECK" = 1 ]; then printf '  --check: nothing will be changed\n'; fi

        # 1. Incus, and whether this account may drive it.
        command -v incus >/dev/null 2>&1 ||
          fail "incus is not installed here. This prepares a machine that already runs Incus."
        incus info </dev/null >/dev/null 2>&1 ||
          fail "this account cannot talk to the Incus daemon. Add it to the incus-admin group (sudo usermod -aG incus-admin \"\$USER\", then log in again) or run this as root."
        ok "incus $(incus version </dev/null 2>/dev/null | awk '/^Server/ { print $NF }') answers this account"

        # 2. The API on the network. Set only when nobody has set it.
        listen=$(incus config get core.https_address </dev/null)
        if [ -z "$listen" ]; then
          act "set core.https_address to :8443, so the API is reachable from the network"
          if [ "$CHECK" = 0 ]; then incus config set core.https_address :8443 </dev/null; fi
        else
          ok "incus already listens on $listen (left as it is)"
          case "$listen" in
            127.*|localhost*|'[::1]'*) warn "that is loopback only: a workstation cannot reach it. Yours to change: incus config set core.https_address :8443" ;;
          esac
        fi

        # 3. Which addresses a workstation might use. Bridges and container plumbing left out.
        lan=$(ip -4 -o addr show scope global 2>/dev/null | awk -v bridge="$BRIDGE" '
          $2 == bridge || $2 ~ /^(docker|br-|veth|incusbr|lxdbr|virbr|cni|flannel|cali)/ { next }
          { split($4, a, "/"); printf "%s%s (%s)", sep, a[1], $2; sep = ", " }') || true
        info "this host's addresses: ${lan:-none found}"

        # 4. Forwarding, and whatever firewall sits on the FORWARD path. Reading a firewall
        #    needs root as much as changing one does, so this is the one place root is asked for.
        forward=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo 0)

        if [ "$(id -u)" = 0 ]; then
          root=(bash -s --)
        else
          command -v sudo >/dev/null 2>&1 || fail "the firewall can only be read as root, and there is no sudo here. Run this as root."
          printf '\n  The firewall can only be read and changed as root, so sudo is asked for once, here,\n'
          printf '  for this and nothing else: net.ipv4.ip_forward, Docker'"'"'s DOCKER-USER chain, ufw.\n'
          if [ "$CHECK" = 1 ]; then printf '  With --check it only reads.\n'; fi
          printf '\n'
          root=(sudo bash -s --)
        fi

        "${root[@]}" "$BRIDGE" "$RANGE" "$CHECK" "$forward" <<'ENVMUX_ROOT'
        set -euo pipefail
        BRIDGE=$1; RANGE=$2; CHECK=$3; FORWARD=$4
        UNIT="envmux-forward-$BRIDGE.service"

        ok()   { printf '  ok     %s\n' "$*"; }
        info() { printf '  info   %s\n' "$*"; }
        warn() { printf '  WARN   %s\n' "$*"; }
        act()  { if [ "$CHECK" = 1 ]; then printf '  would  %s\n' "$*"; else printf '  doing  %s\n' "$*"; fi; }

        if [ "$FORWARD" = 1 ]; then
          ok "net.ipv4.ip_forward is on"
        else
          act "turn on net.ipv4.ip_forward, and keep it on in /etc/sysctl.d/90-envmux-forward.conf"
          if [ "$CHECK" = 0 ]; then
            printf 'net.ipv4.ip_forward = 1\n' > /etc/sysctl.d/90-envmux-forward.conf
            sysctl -q -w net.ipv4.ip_forward=1
          fi
        fi

        if command -v iptables >/dev/null 2>&1; then
          chain=$(iptables -w -S FORWARD 2>/dev/null || true)
          user=$(iptables -w -S DOCKER-USER 2>/dev/null || true)
          policy=$(awk 'NR == 1 { print $3 }' <<<"$chain")
          case "$chain" in
            *"-j DOCKER-USER"*) info "FORWARD policy is ${policy:-unknown}, and Docker sends forwarded traffic through DOCKER-USER first" ;;
            *) info "FORWARD policy is ${policy:-unknown}" ;;
          esac

          if [ -n "$user" ]; then
            in=$(grep -Ec -- "-i $BRIDGE( .*)? -j ACCEPT" <<<"$user" || true)
            out=$(grep -Ec -- "-o $BRIDGE( .*)? -j ACCEPT" <<<"$user" || true)
            keeper=$(grep -ls -- "$BRIDGE" /etc/systemd/system/*.service /etc/iptables/rules.v4 2>/dev/null | grep -v -- "$UNIT" | head -n 1 || true)

            if [ "$in" -gt 0 ] && [ "$out" -gt 0 ] && [ -n "$keeper" ]; then
              ok "DOCKER-USER already accepts traffic in from and out to $BRIDGE, already handled by $keeper (left alone)"
            elif [ "$in" -gt 0 ] && [ "$out" -gt 0 ] && [ -f "/etc/systemd/system/$UNIT" ]; then
              ok "DOCKER-USER already accepts $BRIDGE both ways, kept across reboots by $UNIT"
            else
              if [ "$in" -gt 0 ] && [ "$out" -gt 0 ]; then
                info "DOCKER-USER accepts $BRIDGE both ways now, and nothing was found that puts that back after a reboot"
              else
                info "Docker drops forwarded traffic it did not set up, and DOCKER-USER does not accept $BRIDGE (in: $in, out: $out)"
              fi
              act "accept traffic in from and out to $BRIDGE in DOCKER-USER, kept across reboots by $UNIT"
              if [ "$CHECK" = 0 ]; then
                cat > "/etc/systemd/system/$UNIT" <<UNITFILE
        [Unit]
        Description=envmux: let routed traffic for $BRIDGE ($RANGE) past Docker's FORWARD rules
        After=docker.service network-online.target
        Wants=network-online.target

        [Service]
        Type=oneshot
        RemainAfterExit=yes
        ExecStart=/bin/sh -c 'iptables -w -N DOCKER-USER 2>/dev/null || true'
        ExecStart=/bin/sh -c 'iptables -w -C DOCKER-USER -i $BRIDGE -j ACCEPT 2>/dev/null || iptables -w -I DOCKER-USER -i $BRIDGE -j ACCEPT'
        ExecStart=/bin/sh -c 'iptables -w -C DOCKER-USER -o $BRIDGE -j ACCEPT 2>/dev/null || iptables -w -I DOCKER-USER -o $BRIDGE -j ACCEPT'
        ExecStop=/bin/sh -c 'iptables -w -D DOCKER-USER -i $BRIDGE -j ACCEPT 2>/dev/null || true'
        ExecStop=/bin/sh -c 'iptables -w -D DOCKER-USER -o $BRIDGE -j ACCEPT 2>/dev/null || true'

        [Install]
        WantedBy=multi-user.target
        UNITFILE
                systemctl daemon-reload
                systemctl enable --quiet "$UNIT"
                systemctl restart "$UNIT"
              fi
            fi
          elif [ "$policy" = DROP ]; then
            warn "FORWARD policy is DROP and it is not Docker's doing. envmux will not guess at this firewall: allow forwarding in from and out to $BRIDGE in it."
          else
            ok "no Docker rules on the FORWARD path"
          fi
        else
          info "no iptables here, so no Docker rules to get past"
        fi

        firewall=$(if command -v ufw >/dev/null 2>&1; then ufw status 2>/dev/null || true; fi)
        if grep -q '^Status: active' <<<"$firewall"; then
          if grep -Eq "on $BRIDGE( |$)" <<<"$firewall"; then
            ok "ufw is active and already has a route rule for $BRIDGE"
          else
            act "ufw is active: ufw route allow in on $BRIDGE, and out on $BRIDGE (ufw keeps its own rules across reboots)"
            if [ "$CHECK" = 0 ]; then
              ufw route allow in on "$BRIDGE" >/dev/null
              ufw route allow out on "$BRIDGE" >/dev/null
            fi
          fi
        else
          ok "ufw is not active"
        fi
        ENVMUX_ROOT

        # 5. The token, last, so that it is the last line whatever came before.
        if [ "$CHECK" = 1 ]; then
          act "mint a one-time trust token for '$NAME' (incus config trust add $NAME) and print it as the last line"
          printf '\n__COMMAND__ host prepare --check: nothing was changed and no token was minted.\n'
          printf 'ENVMUX-TOKEN: none (--check)\n'
          exit 0
        fi

        if ! minted=$(incus config trust add "$NAME" </dev/null 2>&1); then
          fail "incus would not mint a token for '$NAME': $minted"
        fi
        token=$(printf '%s\n' "$minted" | awk 'NF { last = $NF } END { print last }')
        [ -n "$token" ] || fail "incus config trust add printed nothing that looks like a token"

        printf '\nThis host is ready. On the workstation:  __COMMAND__ install --token <the token below>\n'
        printf 'The token lets one client in, once. It says where this daemon listens and which certificate it has,\n'
        printf 'so there is no address to type and no fingerprint to compare.\n'
        printf 'ENVMUX-TOKEN: %s\n' "$token"
        ENVMUX_PREPARE

        """;
}
