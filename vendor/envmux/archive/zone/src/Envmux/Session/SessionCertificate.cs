using System.Text;
using Envmux.Host;

namespace Envmux.Session;

/// <summary>
/// The session's own certificate, inside the session's own instance.
/// </summary>
/// <remarks>
/// <para>
/// A session has an address and a name, and this gives that name a certificate
/// signed by the root in <c>~/.envmux</c> — so
/// <c>https://myproj-feat-login.envmux:5001</c> is trusted from this workstation
/// with nothing clicked through, and trusted from inside the instance too,
/// because the root goes into the instance's own store on the way past.
/// </para>
/// <para>
/// Both halves matter and they are easy to confuse. The workstation half is what
/// makes a browser open the page. The instance half is what makes an app host
/// reach its own resource service, a health check reach its own endpoint, and
/// <c>npm</c> reach a dev server, over TLS that validates rather than TLS that
/// has been told not to.
/// </para>
/// <para>
/// Written to <c>/etc/envmux/tls</c> rather than into the workspace: it is
/// per-machine rather than per-repository, it must not end up in a commit, and
/// the workspace is deleted and re-cloned when a session is restarted.
/// </para>
/// </remarks>
internal static class SessionCertificate
{
    /// <summary>Where the session's key material lives inside the instance.</summary>
    public const string Directory = "/etc/envmux/tls";

    public const string CertificateFile = $"{Directory}/session.crt";
    public const string KeyFile = $"{Directory}/session.key";
    public const string ChainFile = $"{Directory}/fullchain.crt";
    public const string BundleFile = $"{Directory}/session.pfx";
    public const string RootFile = $"{Directory}/ca.crt";

    /// <summary>Where the root has to land for the rest of the system to believe it.</summary>
    /// <remarks>
    /// Debian's <c>update-ca-certificates</c> reads <c>/usr/local/share/ca-certificates</c>
    /// and rebuilds <c>/etc/ssl/certs/ca-certificates.crt</c> from it. That
    /// bundle is what OpenSSL, curl, git and .NET on Linux all read, so putting
    /// the root there is the one action that covers nearly everything at once —
    /// and the reason there is no <c>SSL_CERT_FILE</c> in the environment below,
    /// which would replace the system bundle rather than add to it.
    /// </remarks>
    private const string AnchorDirectory = "/usr/local/share/ca-certificates";

    private const string SystemAnchor = $"{AnchorDirectory}/envmux-root.crt";

    /// <summary>
    /// The shell that installs the root and the leaf into a running instance.
    /// </summary>
    /// <remarks>
    /// <para>
    /// PEM goes in through a quoted heredoc, which is safe because PEM is
    /// base64 and dashes and a quoted heredoc interprets nothing. The PKCS#12
    /// bundle is binary, so it goes the same way as base64 and is decoded on
    /// arrival — rather than over the files API, which would be a second
    /// transport for the same three files.
    /// </para>
    /// <para>
    /// Idempotent, because an adopted instance runs it again with a freshly
    /// signed leaf. Everything is written whole rather than appended.
    /// </para>
    /// </remarks>
    public static string Script(Authority.Leaf leaf, string rootPem, string user)
    {
        var script = new StringBuilder();

        script.Line("set -eu");
        script.Line($"mkdir -p {Workspace.Quote(Directory)}");

        Heredoc(script, RootFile, rootPem.TrimEnd() + "\n");
        Heredoc(script, CertificateFile, leaf.CertificatePem);
        Heredoc(script, KeyFile, leaf.KeyPem);
        Heredoc(script, ChainFile, leaf.CertificatePem.TrimEnd() + "\n" + rootPem.TrimEnd() + "\n");

        script.Line($"base64 -d > {Workspace.Quote(BundleFile)} <<'ENVMUX_TLS_PFX'");
        script.Line(Wrap(Convert.ToBase64String(leaf.Pkcs12)));
        script.Line("ENVMUX_TLS_PFX");

        // The session account reads all of it, including the key: everything
        // that serves TLS in here runs as that account, and a key only root can
        // read is a key nothing can use. This instance has one account on it
        // and goes away with the session.
        script.Line($"chown -R {Workspace.Quote(user + ":")} {Workspace.Quote(Directory)}");
        script.Line($"chmod 0755 {Workspace.Quote(Directory)}");
        script.Line($"chmod 0644 {Workspace.Quote(CertificateFile)} {Workspace.Quote(ChainFile)} {Workspace.Quote(RootFile)}");
        script.Line($"chmod 0600 {Workspace.Quote(KeyFile)} {Workspace.Quote(BundleFile)}");

        // And into the system store, so everything in the instance that speaks
        // TLS to something else in the instance validates rather than being
        // told not to. Best effort: an image without update-ca-certificates
        // still gets a session that serves a certificate this workstation
        // trusts, which is the half that cannot be worked around from inside.
        script.Line($"mkdir -p {Workspace.Quote(AnchorDirectory)}");
        script.Line($"cp {Workspace.Quote(RootFile)} {Workspace.Quote(SystemAnchor)}");
        script.Line($"chmod 0644 {Workspace.Quote(SystemAnchor)}");
        script.Line("command -v update-ca-certificates >/dev/null 2>&1 && update-ca-certificates >/dev/null 2>&1 || true");

        script.Line($"printf '%s\\n' {Workspace.Quote(string.Join(", ", leaf.Names))}");

        return script.ToString();
    }

    /// <summary>
    /// What a session's processes read to find their own certificate.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The <c>ENVMUX_TLS_*</c> half is the general answer: paths, in variables
    /// named after what is at them, for a Caddy or a vite config or an nginx
    /// template to point at.
    /// </para>
    /// <para>
    /// <c>Kestrel__Certificates__Default__*</c> is the one framework-shaped
    /// exception, and it earns the exception because it is free. Every ASP.NET
    /// Core application reads unprefixed environment variables into its
    /// configuration, so setting those two makes every .NET server in the
    /// session — an API, an Aspire dashboard, a Blazor app — present this
    /// session's certificate on its HTTPS endpoints without a line of code or a
    /// <c>dotnet dev-certs</c> that nothing outside the instance would trust
    /// anyway. Nothing that is not ASP.NET Core reads them, so a project that is
    /// not .NET pays nothing for them being set.
    /// </para>
    /// <para>
    /// <c>NODE_EXTRA_CA_CERTS</c> because node is the one common runtime that
    /// ignores the system bundle the script above just rebuilt.
    /// </para>
    /// </remarks>
    public static IReadOnlyDictionary<string, string> Environment(Authority.Leaf leaf) =>
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["ENVMUX_TLS_DIR"] = Directory,
            ["ENVMUX_TLS_CERT"] = CertificateFile,
            ["ENVMUX_TLS_KEY"] = KeyFile,
            ["ENVMUX_TLS_CHAIN"] = ChainFile,
            ["ENVMUX_TLS_PFX"] = BundleFile,
            ["ENVMUX_TLS_PASSWORD"] = leaf.Password,
            ["ENVMUX_TLS_CA"] = RootFile,
            ["Kestrel__Certificates__Default__Path"] = BundleFile,
            ["Kestrel__Certificates__Default__Password"] = leaf.Password,
            ["NODE_EXTRA_CA_CERTS"] = RootFile,
        };

    /// <summary>Write a file whole, interpreting nothing on the way in.</summary>
    private static void Heredoc(StringBuilder script, string path, string content)
    {
        script.Line($"cat > {Workspace.Quote(path)} <<'ENVMUX_TLS_PEM'");
        script.Line(content.ReplaceLineEndings("\n").TrimEnd());
        script.Line("ENVMUX_TLS_PEM");
    }

    /// <summary>
    /// Base64 in lines, because one very long line is not portable.
    /// </summary>
    /// <remarks>
    /// A PKCS#12 bundle is a few kilobytes, which is one line that some of what
    /// carries it — a pty, a shell's input buffer — will wrap or truncate. Both
    /// GNU and BusyBox <c>base64 -d</c> ignore newlines, so breaking it is free.
    /// </remarks>
    private static string Wrap(string base64)
    {
        var wrapped = new StringBuilder(base64.Length + (base64.Length / 76) + 2);

        for (var i = 0; i < base64.Length; i += 76)
        {
            wrapped.Append(base64, i, Math.Min(76, base64.Length - i)).Append('\n');
        }

        return wrapped.ToString().TrimEnd('\n');
    }
}
