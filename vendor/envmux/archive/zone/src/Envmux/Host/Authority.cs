using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Envmux.Host;

/// <summary>What happened when the root was asked for, or asked to be trusted.</summary>
internal enum AuthorityChange
{
    /// <summary>It was already there, or already trusted.</summary>
    Unchanged,

    /// <summary>It was made, or added to this machine's store.</summary>
    Applied,

    /// <summary>This platform has no store envmux can write, so nothing was.</summary>
    Unsupported,
}

/// <summary>
/// A certificate for the address a session already has.
/// </summary>
/// <remarks>
/// <para>
/// Every session answers on a name of its own — <c>myproj-feat-login.envmux</c>
/// — and half of what a modern toolchain does over HTTP it refuses to do over
/// HTTP: an Aspire dashboard, a service worker, <c>crypto.subtle</c>, a cookie
/// marked <c>Secure</c>. Under Docker that was somebody else's problem, because
/// everything came back on <c>localhost</c> and browsers treat loopback as
/// secure whatever the scheme. An address of its own takes that exemption away.
/// </para>
/// <para>
/// So the same trade envmux already makes for the host is made again here. The
/// host's client certificate is generated on this machine and written into the
/// install image, so the host trusts envmux before it boots. This is that in the
/// other direction: one root on this machine, added once to its store, and a
/// leaf minted per session and written into the instance — so what a session
/// serves is trusted before it is started, with no per-project certificate to
/// generate, no <c>NODE_TLS_REJECT_UNAUTHORIZED=0</c>, and no click-through.
/// </para>
/// <para>
/// The root's key never leaves <c>~/.envmux</c>. What travels into an instance
/// is a leaf good for that session's names and nothing else, valid for about a
/// year, and the root's public half so things inside the instance trust each
/// other too.
/// </para>
/// </remarks>
internal static class Authority
{
    public const string CertificateFileName = "envmux-ca.crt";
    public const string KeyFileName = "envmux-ca.key";

    /// <summary>
    /// A decade for the root, which is how long a workstation lasts.
    /// </summary>
    /// <remarks>
    /// The same reasoning as the client certificate: this is a development
    /// credential for one machine, and rotating it means visiting the trust
    /// store again. The leaves are short and the root is not.
    /// </remarks>
    public static readonly TimeSpan RootLifetime = TimeSpan.FromDays(3650);

    /// <summary>
    /// Thirteen months, which is under every browser's ceiling.
    /// </summary>
    /// <remarks>
    /// Chrome exempts a locally-installed root from the 398-day limit and Safari
    /// does not. Sitting under the lower of the two costs nothing — a session
    /// mints a fresh leaf every time it starts — and means the answer to "why
    /// does this one browser say invalid" is never this.
    /// </remarks>
    public static readonly TimeSpan LeafLifetime = TimeSpan.FromDays(397);

    /// <summary>
    /// The name a person will see in a certificate viewer and in their store.
    /// </summary>
    /// <remarks>
    /// It says where it came from and what it is for, because the one thing
    /// somebody does with an unexpected root in their store is try to work out
    /// whether they can remove it.
    /// </remarks>
    public const string SubjectName = "envmux local development root";

    public static string CertificatePath => Path.Combine(HostConfig.Directory, CertificateFileName);

    public static string KeyPath => Path.Combine(HostConfig.Directory, KeyFileName);

    public static bool Exists => File.Exists(CertificatePath) && File.Exists(KeyPath);

    /// <summary>
    /// The root, made on first use and read every time after.
    /// </summary>
    /// <remarks>
    /// Making it is silent and needs nobody's permission — it is a file in
    /// envmux's own directory and it does nothing until something trusts it.
    /// <em>Trusting</em> it is the part that asks, and that is
    /// <c>envmux ca</c>.
    /// </remarks>
    public static X509Certificate2 Ensure(DateTimeOffset now)
    {
        if (Exists)
        {
            return Load();
        }

        var root = Create(now);
        Write(root);

        return root;
    }

    /// <summary>Make a root: a CA that may sign leaves and nothing else.</summary>
    /// <remarks>
    /// secp384r1 for the same reason the client certificate uses it — it is what
    /// this codebase already generates — and a path length of zero, so a leaf
    /// signed by it can never itself be a CA. That constraint is the whole
    /// difference between a development root and a way to mint anything.
    /// </remarks>
    public static X509Certificate2 Create(DateTimeOffset now)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP384);

        var request = new CertificateRequest(
            $"CN={SubjectName}, O=envmux", key, HashAlgorithmName.SHA384);

        request.CertificateExtensions.Add(
            new X509BasicConstraintsExtension(certificateAuthority: true, true, 0, critical: true));

        request.CertificateExtensions.Add(
            new X509KeyUsageExtension(
                X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign,
                critical: true));

        request.CertificateExtensions.Add(
            new X509SubjectKeyIdentifierExtension(request.PublicKey, false));

        return request.CreateSelfSigned(now.AddMinutes(-1), now.Add(RootLifetime));
    }

    /// <summary>Write the root and its key beside the host config, as PEM.</summary>
    public static void Write(X509Certificate2 root)
    {
        Directory.CreateDirectory(HostConfig.Directory);

        File.WriteAllText(CertificatePath, root.ExportCertificatePem() + Environment.NewLine);

        using var key = root.GetECDsaPrivateKey()
            ?? throw new CertificateException("the generated root has no EC private key");

        File.WriteAllText(KeyPath, key.ExportPkcs8PrivateKeyPem() + Environment.NewLine);
        Restrict(KeyPath);
    }

    /// <summary>Read the root back, key and all.</summary>
    public static X509Certificate2 Load()
    {
        if (!Exists)
        {
            throw new CertificateException(
                $"there is no root at {CertificatePath}. Run `{Commands.CommandName.Current} ca` to make one.");
        }

        try
        {
            return X509Certificate2.CreateFromPemFile(CertificatePath, KeyPath);
        }
        catch (CryptographicException e)
        {
            throw new CertificateException($"the root at {CertificatePath} could not be read: {e.Message}", e);
        }
    }

    /// <summary>The root's PEM, for writing into an instance's trust store.</summary>
    public static string Pem() => File.ReadAllText(CertificatePath).ReplaceLineEndings("\n").Trim();

    /// <summary>A leaf, its key, and the PKCS#12 bundle a .NET server wants.</summary>
    /// <param name="Certificate">The leaf, public half only.</param>
    /// <param name="CertificatePem">The leaf as PEM.</param>
    /// <param name="KeyPem">Its private key as PKCS#8 PEM.</param>
    /// <param name="Pkcs12">Leaf, key and root in one file, encrypted with <paramref name="Password"/>.</param>
    /// <param name="Password">Generated per session; it never leaves the instance.</param>
    /// <param name="Names">Every name and address the leaf is good for.</param>
    internal sealed record Leaf(
        X509Certificate2 Certificate,
        string CertificatePem,
        string KeyPem,
        byte[] Pkcs12,
        string Password,
        IReadOnlyList<string> Names);

    /// <summary>
    /// Sign a leaf for the names a session answers on.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Named subjects only — no wildcard over the zone. A leaf that could stand
    /// in for <c>*.envmux</c> would be one session able to impersonate every
    /// other, which is a strictly worse trust boundary than the one the zone
    /// already has, and it would live in a container running whatever the
    /// project's lockfile pulled in.
    /// </para>
    /// <para>
    /// <c>localhost</c> and the loopback addresses are on it because most of
    /// what a session serves over TLS also talks to itself over TLS — an Aspire
    /// app host reaching its own resource service, a health check, a proxy — and
    /// those connect to loopback. Leaving them off means every one of those
    /// paths needs validation turned off, which is the thing this exists to
    /// avoid.
    /// </para>
    /// </remarks>
    public static Leaf Issue(
        X509Certificate2 root,
        IReadOnlyList<string> hostnames,
        IReadOnlyList<string> addresses,
        DateTimeOffset now)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        var request = new CertificateRequest(
            $"CN={(hostnames.Count > 0 ? hostnames[0] : "envmux session")}", key, HashAlgorithmName.SHA256);

        request.CertificateExtensions.Add(
            new X509BasicConstraintsExtension(certificateAuthority: false, false, 0, critical: true));

        request.CertificateExtensions.Add(
            new X509KeyUsageExtension(
                X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment,
                critical: true));

        request.CertificateExtensions.Add(
            new X509EnhancedKeyUsageExtension(
                [new Oid("1.3.6.1.5.5.7.3.1", "Server Authentication"),
                 new Oid("1.3.6.1.5.5.7.3.2", "Client Authentication")],
                false));

        var subject = new SubjectAlternativeNameBuilder();
        var names = new List<string>();

        foreach (var hostname in hostnames.Concat(["localhost"]).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            subject.AddDnsName(hostname);
            names.Add(hostname);
        }

        foreach (var address in addresses.Concat(["127.0.0.1", "::1"]).Distinct(StringComparer.Ordinal))
        {
            if (IPAddress.TryParse(address, out var parsed))
            {
                subject.AddIpAddress(parsed);
                names.Add(address);
            }
        }

        request.CertificateExtensions.Add(subject.Build());
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));

        // Not before the root is, and not after it stops being — a leaf that
        // outlives its issuer is one that stops working on a date nothing in
        // the session explains.
        var start = now.AddMinutes(-1);
        var end = now.Add(LeafLifetime);

        if (end > root.NotAfter)
        {
            end = root.NotAfter;
        }

        using var signed = request.Create(root, start, end, Serial());
        using var pair = signed.CopyWithPrivateKey(key);

        var password = Session.Generated.Password();

        // Leaf and root together, so a server loading this presents the chain
        // rather than an orphan a client has to already have seen.
        var chain = new X509Certificate2Collection();
        chain.Add(pair);
        chain.Add(X509CertificateLoader.LoadCertificate(root.RawData));

        return new Leaf(
            X509CertificateLoader.LoadCertificate(signed.RawData),
            signed.ExportCertificatePem() + "\n",
            key.ExportPkcs8PrivateKeyPem() + "\n",
            chain.Export(X509ContentType.Pkcs12, password)
                ?? throw new CertificateException("the session certificate could not be bundled as PKCS#12"),
            password,
            names);
    }

    /// <summary>Add the root to this machine's store, or say why it could not be.</summary>
    /// <remarks>
    /// <para>
    /// The current user's store rather than the machine's, so this needs no
    /// elevation and affects nobody else who logs into the workstation. Chrome,
    /// Edge, <c>curl</c> through SChannel and .NET all read it; Firefox keeps
    /// its own and has to be told separately, which <c>envmux ca</c> says.
    /// </para>
    /// <para>
    /// On Windows the store itself puts up a confirmation dialog the first time.
    /// That is Windows asking whether you meant to trust a new root, which is
    /// exactly the right question, so it is left alone rather than worked
    /// around.
    /// </para>
    /// </remarks>
    public static AuthorityChange Trust(X509Certificate2 root)
    {
        if (!OperatingSystem.IsWindows())
        {
            return AuthorityChange.Unsupported;
        }

        if (IsTrusted(root))
        {
            return AuthorityChange.Unchanged;
        }

        try
        {
            using var store = new X509Store(StoreName.Root, StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadWrite);

            // The public half on its own. Putting the key in the trust store
            // would be storing the thing that signs beside the decision to
            // believe what it signed.
            store.Add(X509CertificateLoader.LoadCertificate(root.RawData));

            return AuthorityChange.Applied;
        }
        catch (CryptographicException e)
        {
            throw new CertificateException(
                $"the root could not be added to this machine's store: {e.Message}", e);
        }
    }

    /// <summary>Whether this machine already believes the root.</summary>
    public static bool IsTrusted(X509Certificate2 root)
    {
        if (!OperatingSystem.IsWindows())
        {
            return false;
        }

        try
        {
            using var store = new X509Store(StoreName.Root, StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadOnly);

            return store.Certificates
                .Find(X509FindType.FindByThumbprint, root.Thumbprint, validOnly: false)
                .Count > 0;
        }
        catch (CryptographicException)
        {
            // A store that will not open is a store that does not trust it.
            return false;
        }
    }

    /// <summary>Take the root back out of this machine's store.</summary>
    public static AuthorityChange Distrust(X509Certificate2 root)
    {
        if (!OperatingSystem.IsWindows())
        {
            return AuthorityChange.Unsupported;
        }

        try
        {
            using var store = new X509Store(StoreName.Root, StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadWrite);

            var found = store.Certificates
                .Find(X509FindType.FindByThumbprint, root.Thumbprint, validOnly: false);

            if (found.Count == 0)
            {
                return AuthorityChange.Unchanged;
            }

            store.RemoveRange(found);
            return AuthorityChange.Applied;
        }
        catch (CryptographicException e)
        {
            throw new CertificateException(
                $"the root could not be removed from this machine's store: {e.Message}", e);
        }
    }

    /// <summary>The SHA-256 fingerprint, spelled the way the rest of envmux spells them.</summary>
    public static string Fingerprint(X509Certificate2 certificate) =>
        Convert.ToHexStringLower(SHA256.HashData(certificate.RawData));

    /// <summary>A serial number nothing else will have.</summary>
    private static byte[] Serial()
    {
        var serial = RandomNumberGenerator.GetBytes(16);

        // Positive, because a leading bit set makes it a negative integer in
        // DER and some clients say so.
        serial[0] &= 0x7f;

        return serial;
    }

    /// <summary>Take the key file away from everyone but its owner, where that means anything.</summary>
    private static void Restrict(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        try
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
            // The directory's own permissions are the real protection.
        }
    }
}
