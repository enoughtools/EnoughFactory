using System.Buffers;

namespace Envmux.Backends.DockerEngine;

/// <summary>
/// What a Docker backend needs to know: the <c>docker</c> block of its record.
/// </summary>
/// <remarks>
/// Optional fields, so a record that says only that it is a Docker
/// one is complete. There is no block of addresses, no route and no resolver
/// rule to write down, because a session on this backend publishes nothing: it
/// is reached through the SOCKS relay (<see cref="EngineRelay"/>). Nothing here
/// is a secret. The seam owns the record this sits in; this is only its shape.
/// </remarks>
/// <param name="Endpoint">
/// Where the engine listens, as <c>DOCKER_HOST</c> would spell it. Null finds
/// it the way the CLI does (<see cref="EngineEndpoint.Resolve(string?)"/>), which
/// is the better thing to record: a machine switched from one Docker to another
/// keeps working, and a record carried to a Mac does not name a pipe.
/// </param>
/// <param name="GoldenTag">
/// The golden image to run, when it is one somebody published rather than the
/// one built here. Null — the usual — is <c>envmux-golden:&lt;build&gt;</c>, built
/// locally. Read it through <see cref="DockerImages.GoldenReference(DockerBackendConfig)"/>, never directly.
/// </param>
/// <param name="ManagedGoldenImage">
/// One immutable image already prepared by the supervising application. It is
/// resolved for this process only, never written into a host or project record.
/// </param>
internal sealed record DockerBackendConfig(string? Endpoint = null, string? GoldenTag = null, string? ManagedGoldenImage = null)
{
    private static readonly SearchValues<char> ImageIdCharacters = SearchValues.Create("0123456789abcdef");

    /// <summary>Resolve a per-launch image only when the private engine contract is active.</summary>
    /// <remarks>
    /// An ordinary CLI invocation ignores this variable, even when malformed.
    /// Managed launches name a complete image ID, never a mutable tag to pull
    /// or a Dockerfile to execute. The manager owns preparing that image.
    /// </remarks>
    public DockerBackendConfig ResolveManaged(Func<string, string?> environment)
    {
        if (!string.Equals(environment("ENVMUX_MANAGED_DOCKER"), "1", StringComparison.Ordinal))
        {
            return this with { ManagedGoldenImage = null };
        }

        var image = environment("ENVMUX_MANAGED_GOLDEN_IMAGE");
        if (string.IsNullOrEmpty(image))
        {
            return this with { ManagedGoldenImage = null };
        }

        if (image.Length != 71 || !image.StartsWith("sha256:", StringComparison.Ordinal) ||
            image.AsSpan(7).ContainsAnyExcept(ImageIdCharacters))
        {
            throw new BackendException("ENVMUX_MANAGED_GOLDEN_IMAGE must name an immutable sha256 image ID prepared on the managed engine.");
        }

        return this with { ManagedGoldenImage = image };
    }
}
