using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

using Envmux.Host;
using Envmux.Incus;

namespace Envmux.Tests;

/// <summary>
/// The certificate is generated on this machine, written into a disk image, and
/// then used to authenticate against a host that has never met it. Everything
/// about it has to be right the first time.
/// </summary>
public class ClientCertificateTests
{
    [Fact]
    public void ItIsAnEcCertificateOnTheCurveIncusUses()
    {
        using var certificate = ClientCertificate.Create(DateTimeOffset.UtcNow);
        using var key = certificate.GetECDsaPublicKey();

        Assert.NotNull(key);
        Assert.Equal(384, key.KeySize);
    }

    [Fact]
    public void ItSaysItIsAClientAndNotAnAuthority()
    {
        using var certificate = ClientCertificate.Create(DateTimeOffset.UtcNow);

        var basic = certificate.Extensions.OfType<X509BasicConstraintsExtension>().Single();
        Assert.False(basic.CertificateAuthority);

        var usage = certificate.Extensions.OfType<X509EnhancedKeyUsageExtension>().Single();
        Assert.Contains(usage.EnhancedKeyUsages.Cast<Oid>(), o => o.Value == "1.3.6.1.5.5.7.3.2");
    }

    [Fact]
    public void ItIsBackdatedSoAHostWithNoClockYetStillAcceptsIt()
    {
        // The VM's clock is not set when it first reads the seed. A certificate
        // that is not yet valid at that moment is rejected, and the symptom is a
        // host that installed perfectly and refuses the only client it trusts.
        var now = DateTimeOffset.UtcNow;
        using var certificate = ClientCertificate.Create(now);

        Assert.True(certificate.NotBefore.ToUniversalTime() < now.UtcDateTime);
    }

    [Fact]
    public void ItLastsLongEnoughNotToNeedRotatingOnAHostWithNoShell()
    {
        var now = DateTimeOffset.UtcNow;
        using var certificate = ClientCertificate.Create(now);

        Assert.True(certificate.NotAfter.ToUniversalTime() > now.AddYears(9).UtcDateTime);
    }

    [Fact]
    public void WhatIsWrittenIsWhatComesBackWithAKeyAttached()
    {
        var directory = Directory.CreateTempSubdirectory("envmux-cert");
        var certificatePath = Path.Combine(directory.FullName, "envmux-cli.crt");
        var keyPath = Path.Combine(directory.FullName, "envmux-cli.key");

        try
        {
            using var created = ClientCertificate.Create(DateTimeOffset.UtcNow);
            ClientCertificate.Write(created, certificatePath, keyPath);

            using var loaded = ClientCertificate.Load(certificatePath, keyPath);

            Assert.Equal(created.RawDataMemory.ToArray(), loaded.RawDataMemory.ToArray());

            // The whole reason Load goes through PKCS#12 rather than handing
            // back what CreateFromPemFile produced: on Windows the PEM form
            // yields a key SChannel cannot use for client authentication, the
            // handshake completes without sending the certificate, and the host
            // answers `auth: untrusted` as though nothing had ever been seeded.
            Assert.True(loaded.HasPrivateKey);

            using var signer = loaded.GetECDsaPrivateKey();
            Assert.NotNull(signer);
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    [Fact]
    public void TheKeyIsWrittenSeparatelyAndTheCertificateHalfIsWhatTheSeedCarries()
    {
        var directory = Directory.CreateTempSubdirectory("envmux-cert");
        var certificatePath = Path.Combine(directory.FullName, "envmux-cli.crt");
        var keyPath = Path.Combine(directory.FullName, "envmux-cli.key");

        try
        {
            using var created = ClientCertificate.Create(DateTimeOffset.UtcNow);
            ClientCertificate.Write(created, certificatePath, keyPath);

            var pem = ClientCertificate.Pem(certificatePath);

            Assert.StartsWith("-----BEGIN CERTIFICATE-----", pem, StringComparison.Ordinal);
            Assert.EndsWith("-----END CERTIFICATE-----", pem, StringComparison.Ordinal);

            // The private half must never reach the seed, which is written into
            // a disk image and copied around.
            Assert.DoesNotContain("PRIVATE KEY", pem, StringComparison.Ordinal);
            Assert.Contains("PRIVATE KEY", File.ReadAllText(keyPath), StringComparison.Ordinal);
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    [Fact]
    public void TheFingerprintIsTheSha256OfTheDerAsIncusWritesIt()
    {
        using var certificate = ClientCertificate.Create(DateTimeOffset.UtcNow);

        var fingerprint = ClientCertificate.Fingerprint(certificate);

        Assert.Equal(64, fingerprint.Length);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(certificate.RawData)), fingerprint);
        Assert.DoesNotContain(":", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void AMissingCertificateSaysHowToMakeOne()
    {
        var thrown = Assert.Throws<CertificateException>(
            () => ClientCertificate.Load(
                Path.Combine(Path.GetTempPath(), "nothing-here.crt"),
                Path.Combine(Path.GetTempPath(), "nothing-here.key")));

        Assert.Contains("envmux host cert", thrown.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("AA:BB:CC", "aabbcc")]
    [InlineData("aa bb cc", "aabbcc")]
    [InlineData(" AABBCC ", "aabbcc")]
    public void FingerprintsAreCompareableHoweverTheyWereWrittenDown(string given, string expected) =>
        Assert.Equal(expected, IncusClient.Normalise(given));
}
