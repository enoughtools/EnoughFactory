namespace Envmux.Backends.DockerEngine;

/// <summary>
/// What a Docker backend needs to know: the <c>docker</c> block of its record.
/// </summary>
/// <remarks>
/// Two fields, both optional, so a record that says only that it is a Docker
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
internal sealed record DockerBackendConfig(string? Endpoint = null, string? GoldenTag = null);
