using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

using Envmux.Host;

namespace Envmux.Tests;

/// <summary>
/// The root a workstation trusts once, and the leaf a session serves.
/// </summary>
/// <remarks>
/// Everything here is about a chain that has to build on a machine that has
/// never seen either half before, for a name that did not exist an hour ago.
/// The parts that need a trust store are not here — that is the one step
/// <c>envmux ca</c> asks about, and it belongs to the machine rather than to a
/// test.
/// </remarks>
public class AuthorityTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void TheRootIsAnAuthorityThatCanOnlySignLeaves()
    {
        using var root = Authority.Create(Now);

        var basic = root.Extensions.OfType<X509BasicConstraintsExtension>().Single();

        Assert.True(basic.CertificateAuthority);
        Assert.True(basic.HasPathLengthConstraint);

        // Zero, so nothing it signs can itself be an authority. That constraint
        // is the whole difference between a development root and a way to mint
        // anything at all.
        Assert.Equal(0, basic.PathLengthConstraint);
    }

    [Fact]
    public void TheRootMaySignAndMayNotServe()
    {
        using var root = Authority.Create(Now);

        var usage = root.Extensions.OfType<X509KeyUsageExtension>().Single();

        Assert.True(usage.KeyUsages.HasFlag(X509KeyUsageFlags.KeyCertSign));
        Assert.False(usage.KeyUsages.HasFlag(X509KeyUsageFlags.KeyEncipherment));
    }

    [Fact]
    public void ALeafCarriesEveryNameTheSessionAnswersOn()
    {
        using var root = Authority.Create(Now);

        var leaf = Authority.Issue(
            root,
            ["myproj-feat-login.envmux", "myproj-feat-login-db.envmux"],
            ["10.100.0.4"],
            Now);

        var names = leaf.Certificate.Extensions
            .OfType<X509SubjectAlternativeNameExtension>()
            .Single();

        Assert.Equal(
            ["myproj-feat-login.envmux", "myproj-feat-login-db.envmux", "localhost"],
            names.EnumerateDnsNames());

        Assert.Equal(
            [IPAddress.Parse("10.100.0.4"), IPAddress.Loopback, IPAddress.IPv6Loopback],
            names.EnumerateIPAddresses());
    }

    [Fact]
    public void ALeafCarriesLoopbackEvenWhenNothingAskedForIt()
    {
        // Most of what a session serves over TLS also talks to itself over TLS —
        // an app host reaching its own resource service, a health check, a proxy
        // — and all of those connect to loopback. Leaving it off means every one
        // of those paths needs validation turned off, which is the thing the
        // certificate exists to avoid.
        using var root = Authority.Create(Now);

        var leaf = Authority.Issue(root, ["myproj-feat-login.envmux"], [], Now);

        Assert.Contains("localhost", leaf.Names);
        Assert.Contains("127.0.0.1", leaf.Names);
    }

    [Fact]
    public void ALeafIsNotAnAuthorityAndSaysSo()
    {
        using var root = Authority.Create(Now);

        var leaf = Authority.Issue(root, ["myproj-feat-login.envmux"], [], Now);

        var basic = leaf.Certificate.Extensions.OfType<X509BasicConstraintsExtension>().Single();
        Assert.False(basic.CertificateAuthority);

        var usage = leaf.Certificate.Extensions.OfType<X509EnhancedKeyUsageExtension>().Single();
        Assert.Contains(usage.EnhancedKeyUsages.Cast<Oid>(), o => o.Value == "1.3.6.1.5.5.7.3.1");
    }

    [Fact]
    public void ALeafChainsToTheRootAndNothingElse()
    {
        // The whole point, and the one thing that cannot be checked by reading
        // the file: a machine that trusts the root accepts the leaf.
        using var root = Authority.Create(Now);

        var leaf = Authority.Issue(root, ["myproj-feat-login.envmux"], ["10.100.0.4"], Now);

        using var chain = new X509Chain();
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.VerificationTime = Now.UtcDateTime.AddDays(1);
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(X509CertificateLoader.LoadCertificate(root.RawData));

        Assert.True(chain.Build(leaf.Certificate), string.Join(
            ", ", chain.ChainStatus.Select(s => s.StatusInformation.Trim())));
    }

    [Fact]
    public void ALeafDoesNotOutliveItsRoot()
    {
        // A leaf good for longer than the thing that signed it stops working on
        // a date nothing in the session explains.
        using var root = Authority.Create(Now);

        var leaf = Authority.Issue(root, ["myproj-feat-login.envmux"], [], Now);

        Assert.True(leaf.Certificate.NotAfter <= root.NotAfter);
    }

    [Fact]
    public void ALeafIsUnderEveryBrowsersCeiling()
    {
        // Chrome exempts a locally-installed root from the 398-day limit and
        // Safari does not. Sitting under the lower of the two costs nothing,
        // because a session mints a fresh leaf every time it starts.
        using var root = Authority.Create(Now);

        var leaf = Authority.Issue(root, ["myproj-feat-login.envmux"], [], Now);

        Assert.True(leaf.Certificate.NotAfter - leaf.Certificate.NotBefore < TimeSpan.FromDays(398));
    }

    [Fact]
    public void TwoLeavesAreNeverTheSameCertificate()
    {
        using var root = Authority.Create(Now);

        var one = Authority.Issue(root, ["a.envmux"], [], Now);
        var two = Authority.Issue(root, ["a.envmux"], [], Now);

        Assert.NotEqual(one.Certificate.SerialNumber, two.Certificate.SerialNumber);
        Assert.NotEqual(one.Password, two.Password);
    }

    [Fact]
    public void TheBundleOpensWithTheGeneratedPasswordAndKeepsTheKey()
    {
        // What a .NET server is handed: Kestrel loads this file with this
        // password, and a bundle without the private key in it is a server that
        // starts and then cannot complete a handshake.
        using var root = Authority.Create(Now);

        var leaf = Authority.Issue(root, ["myproj-feat-login.envmux"], [], Now);

        var loaded = X509CertificateLoader.LoadPkcs12Collection(leaf.Pkcs12, leaf.Password);

        Assert.Contains(loaded, c => c.HasPrivateKey);

        // The root travels with it, so a server presents a chain rather than an
        // orphan the client has to have seen before.
        Assert.Contains(loaded, c => c.Subject == root.Subject);
    }

    [Fact]
    public void TheWrongPasswordDoesNotOpenTheBundle()
    {
        using var root = Authority.Create(Now);

        var leaf = Authority.Issue(root, ["myproj-feat-login.envmux"], [], Now);

        Assert.ThrowsAny<System.Security.Cryptography.CryptographicException>(
            () => X509CertificateLoader.LoadPkcs12Collection(leaf.Pkcs12, "not it"));
    }
}
