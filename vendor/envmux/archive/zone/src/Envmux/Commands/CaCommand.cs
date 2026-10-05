using Envmux.Host;

namespace Envmux.Commands;

/// <summary>
/// The root this machine trusts, so what a session serves over TLS is believed.
/// </summary>
/// <remarks>
/// <para>
/// The counterpart to <see cref="SshCommand"/>, and the same shape: one thing
/// made in <c>~/.envmux</c>, one thing written outside it, both idempotent.
/// <c>ssh</c> sets this machine up to <em>reach</em> sessions; this sets it up
/// to <em>believe</em> them.
/// </para>
/// <para>
/// Separate from the session for one reason: adding a certificate authority to
/// a person's trust store is the only thing envmux does that changes what this
/// whole machine will believe, from anywhere, until it is taken back out. A
/// session makes the root and signs with it silently, because a key in envmux's
/// own directory does nothing on its own. Trusting it is asked for.
/// </para>
/// </remarks>
internal static class CaCommand
{
    public static int Run(bool print, bool remove)
    {
        var had = Authority.Exists;
        var root = Authority.Ensure(DateTimeOffset.UtcNow);

        if (print)
        {
            // The PEM itself, for a machine where the person who can write the
            // trust store is not the person running envmux — and for Firefox,
            // Java and everything else that keeps a store of its own.
            Console.WriteLine(Authority.Pem());
            return 0;
        }

        if (remove)
        {
            return Removed(root);
        }

        var change = Authority.Trust(root);

        Console.WriteLine($"  root    {Tilde(Authority.CertificatePath)} ({(had ? "already here" : "created")})");
        Console.WriteLine($"  name    {Authority.SubjectName}");
        Console.WriteLine($"  sha256  {Authority.Fingerprint(root)}");
        Console.WriteLine(
            $"  expires {root.NotAfter.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture)}");

        switch (change)
        {
            case AuthorityChange.Applied:
                Console.WriteLine("  store   added to this account's trusted roots");
                break;

            case AuthorityChange.Unchanged:
                Console.WriteLine("  store   already trusted by this account");
                break;

            default:
                Console.WriteLine("  store   not written — envmux only writes a trust store on Windows");
                Console.WriteLine();
                Console.WriteLine($"  Add {Tilde(Authority.CertificatePath)} to this machine's store yourself:");
                Console.WriteLine("    macOS  security add-trusted-cert -d -k ~/Library/Keychains/login.keychain-db <file>");
                Console.WriteLine("    Linux  sudo cp <file> /usr/local/share/ca-certificates/envmux-root.crt");
                Console.WriteLine("           sudo update-ca-certificates");
                return 0;
        }

        Console.WriteLine();
        Console.WriteLine("  Sessions started from now on serve a certificate for their own name, signed by");
        Console.WriteLine("  this root, and this machine believes it. Running ones pick one up when they are");
        Console.WriteLine("  started again.");
        Console.WriteLine();

        // Said every time rather than only the first, because the browser this
        // does not cover is the one somebody will be looking at when they
        // conclude the whole thing did not work.
        Console.WriteLine("  Firefox and Java keep stores of their own and are not covered.");
        Console.WriteLine($"  `{CommandName.Current} ca --print` writes the certificate for importing into one.");

        return 0;
    }

    private static int Removed(System.Security.Cryptography.X509Certificates.X509Certificate2 root)
    {
        var change = Authority.Distrust(root);

        Console.WriteLine(change switch
        {
            AuthorityChange.Applied => "  store   removed from this account's trusted roots",
            AuthorityChange.Unchanged => "  store   was not trusted by this account",
            _ => "  store   not written — envmux only writes a trust store on Windows",
        });

        Console.WriteLine();
        Console.WriteLine($"  {Tilde(Authority.CertificatePath)} is still there, and sessions still use it —");
        Console.WriteLine("  a browser will warn about them now. Delete the file to stop signing with it.");

        return 0;
    }

    private static string Tilde(string path)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        return home.Length > 0 && path.StartsWith(home, StringComparison.OrdinalIgnoreCase)
            ? "~" + path[home.Length..].Replace('\\', '/')
            : path;
    }
}
