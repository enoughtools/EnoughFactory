using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Envmux.Host;

/// <summary>The certificate could not be made, read, or used.</summary>
internal sealed class CertificateException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>
/// The client certificate, generated offline and injected into the install seed.
/// </summary>
/// <remarks>
/// <para>
/// This is what removes the trust-token exchange from the design. Incus'
/// documented path is: bring the host up, ask it for a token, hand the token
/// back with a certificate, and be trusted from then on. Pre-seeding the
/// certificate into <c>incus.json</c> means the host is created already
/// trusting this key — there is no window in which an untrusted client is
/// talking to it, and no token to lose.
/// </para>
/// <para>
/// Generated here rather than by <c>openssl</c>, because openssl is not on a
/// Windows workstation and the build has to be repeatable from a clean machine.
/// The same certificate and the same key work unchanged from a macOS or Linux
/// client later — it is a file, not a platform credential.
/// </para>
/// </remarks>
internal static class ClientCertificate
{
    /// <summary>
    /// A decade. This is a development credential for one workstation.
    /// </summary>
    /// <remarks>
    /// Short-lived certificates want rotation, and rotation on a host with no
    /// shell means rebuilding the seed and reinstalling. The trade is made
    /// deliberately in the direction of not doing that.
    /// </remarks>
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(3650);

    public const string SubjectName = "envmux-cli";

    /// <summary>
    /// Make a new key and a self-signed certificate for it.
    /// </summary>
    /// <remarks>
    /// secp384r1, which .NET calls nistP384: the curve Incus' own tooling
    /// generates, so nothing downstream has to be argued with about it.
    /// </remarks>
    public static X509Certificate2 Create(DateTimeOffset now)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP384);

        var request = new CertificateRequest(
            $"CN={SubjectName}", key, HashAlgorithmName.SHA384);

        request.CertificateExtensions.Add(
            new X509BasicConstraintsExtension(certificateAuthority: false, false, 0, critical: true));

        // Incus checks that the certificate is usable as a TLS client and
        // nothing else. Saying so keeps it from ever being mistaken for a
        // server certificate or a signing one.
        request.CertificateExtensions.Add(
            new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, critical: true));

        request.CertificateExtensions.Add(
            new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.2", "Client Authentication")], false));

        request.CertificateExtensions.Add(
            new X509SubjectKeyIdentifierExtension(request.PublicKey, false));

        // A minute of backdating, because a VM whose clock has not been set yet
        // rejecting the certificate that was meant to bring it up is a failure
        // with no way to see the cause.
        return request.CreateSelfSigned(now.AddMinutes(-1), now.Add(Lifetime));
    }

    /// <summary>Write the certificate and its key beside the host config, as PEM.</summary>
    /// <remarks>
    /// Two files rather than one PFX, because the certificate half is what goes
    /// into the seed as text and the key half must never leave this machine.
    /// Keeping them apart makes it obvious which is which.
    /// </remarks>
    public static void Write(X509Certificate2 certificate, string certificatePath, string keyPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(certificatePath)!);

        File.WriteAllText(certificatePath, certificate.ExportCertificatePem() + Environment.NewLine);

        using var key = certificate.GetECDsaPrivateKey()
            ?? throw new CertificateException("the generated certificate has no EC private key");

        File.WriteAllText(keyPath, key.ExportPkcs8PrivateKeyPem() + Environment.NewLine);
        Restrict(keyPath);
    }

    /// <summary>
    /// Load the certificate and key as something SChannel will actually use.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The single most expensive thing to discover by experiment on Windows.
    /// <see cref="X509Certificate2.CreateFromPemFile(string, string?)"/> produces
    /// a certificate whose private key lives in a managed key object, and
    /// SChannel — which is what <c>HttpClient</c> hands the handshake to — can
    /// only use a key it can find through CNG. The handshake completes, the
    /// client certificate is simply never sent, and the server answers
    /// <c>auth: untrusted</c> as though the certificate had never been seeded.
    /// </para>
    /// <para>
    /// Exporting to PKCS#12 and loading that back is what puts the key somewhere
    /// SChannel can reach. It is a no-op cost on Linux and macOS, so it is done
    /// unconditionally rather than behind a platform check that would then only
    /// ever be exercised on one platform.
    /// </para>
    /// </remarks>
    public static X509Certificate2 Load(string certificatePath, string keyPath)
    {
        if (!File.Exists(certificatePath) || !File.Exists(keyPath))
        {
            throw new CertificateException(
                $"there is no client certificate at {certificatePath}. Run `envmux host cert` to make one.");
        }

        try
        {
            using var pem = X509Certificate2.CreateFromPemFile(certificatePath, keyPath);
            return X509CertificateLoader.LoadPkcs12(pem.Export(X509ContentType.Pkcs12), null);
        }
        catch (CryptographicException e)
        {
            throw new CertificateException(
                $"the client certificate at {certificatePath} could not be loaded: {e.Message}", e);
        }
    }

    /// <summary>The PEM text the seed carries, with no trailing blank line.</summary>
    public static string Pem(string certificatePath) =>
        File.ReadAllText(certificatePath).ReplaceLineEndings("\n").Trim();

    /// <summary>
    /// The SHA-256 fingerprint, as Incus writes them: lowercase hex, no colons.
    /// </summary>
    public static string Fingerprint(X509Certificate2 certificate) =>
        Convert.ToHexStringLower(SHA256.HashData(certificate.RawData));

    /// <summary>
    /// Take the key file away from everyone but its owner.
    /// </summary>
    /// <remarks>
    /// Best effort, and silent when it cannot: on Windows the file already
    /// inherits an ACL from a per-user directory, and a failure to tighten it
    /// further is not a reason to refuse to create a certificate at all.
    /// </remarks>
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
