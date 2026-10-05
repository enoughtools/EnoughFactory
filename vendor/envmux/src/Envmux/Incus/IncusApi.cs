using System.Globalization;

namespace Envmux.Incus;

/// <summary>
/// The calls this design actually makes, and the waiting they need.
/// </summary>
/// <remarks>
/// <para>
/// Hand-written rather than generated from <c>doc/rest-api.yaml</c>. The
/// generated client would be several thousand lines describing clustering,
/// projects, storage buckets and network zones — none of which this uses — and
/// the interesting part of talking to Incus is not the shape of the requests but
/// the asynchronous protocol underneath them, which a generator does not model
/// at all.
/// </para>
/// <para>
/// Every mutating call answers <c>202</c> with an operation URL and does the
/// work afterwards. Nothing here returns before that operation has finished, so
/// a caller never has to know which calls are async — they all read as though
/// they were not.
/// </para>
/// </remarks>
internal sealed class IncusApi(IncusClient client)
{
    /// <summary>
    /// How long a single <c>/wait</c> blocks server-side before answering.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Not the overall deadline. The endpoint returns the operation as it stands
    /// when this elapses, so a longer value is fewer round trips and a shorter
    /// one is a more responsive cancel. Twenty seconds is short enough that
    /// Ctrl-C during an image pull is felt immediately.
    /// </para>
    /// <para>
    /// And comfortably inside the client's own timeout, which matters more than
    /// it looks: asking the server to block for exactly as long as the client
    /// will wait is a race, and a slow operation would lose it about as often as
    /// it won — surfacing as a pull that "timed out" while it was in fact still
    /// running.
    /// </para>
    /// </remarks>
    private const int WaitSeconds = 20;

    public IncusClient Client => client;

    /// <summary>What the host is, and whether it knows us.</summary>
    public async Task<ServerInfo> ServerAsync(CancellationToken ct = default) =>
        (await client.GetAsync(IncusClient.V1, ct).ConfigureAwait(false)).As<ServerInfo>()
        ?? throw new IncusException("the host answered GET /1.0 with nothing");

    /// <summary>
    /// Whether this daemon is IncusOS rather than an Incus on somebody's Debian.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Asked, and deliberately not parsed. The <c>/os/</c> surface is proxied
    /// through Incus and its shape is not documented; the debug endpoints under
    /// it carry no stability guarantee at all. That it answers is a fact worth
    /// having — it is the difference between a host that can be updated and
    /// rebuilt the way this design assumes and one that cannot — and every field
    /// inside it is a guess.
    /// </para>
    /// <para>
    /// A plain Incus answers 404 here, which is not an error: it is the answer.
    /// </para>
    /// </remarks>
    public async Task<bool> IsIncusOsAsync(CancellationToken ct = default)
    {
        try
        {
            await client.GetAsync(IncusClient.Os, ct).ConfigureAwait(false);
            return true;
        }
        catch (IncusException)
        {
            return false;
        }
    }

    /// <summary>
    /// Wait for an operation to finish, and throw with its own message if it failed.
    /// </summary>
    /// <remarks>
    /// <c>status_code</c> and never <c>status</c>: the string is a label that has
    /// been reworded between releases, and code that compares it breaks on an
    /// upgrade in a way that looks like the operation failing.
    /// </remarks>
    public async Task<IncusOperation> AwaitAsync(
        IncusResponse response,
        Action<string>? report = null,
        CancellationToken ct = default)
    {
        var operation = await SettleAsync(response, report, ct).ConfigureAwait(false);

        return operation.Succeeded
            ? operation
            : throw new IncusException(
                operation.Err.Length > 0
                    ? operation.Err
                    : $"an operation ended as {operation.Status}")
            {
                Code = operation.StatusCode,
            };
    }

    /// <summary>
    /// Wait for an operation to finish, however it finishes.
    /// </summary>
    /// <remarks>
    /// The same wait as <see cref="AwaitAsync"/> without the verdict, for the one
    /// caller that has a use for a failure: a recorded exec's non-zero exit is a
    /// result, not an error, and the output that explains it is attached to the
    /// operation that "failed".
    /// </remarks>
    /// <param name="response">What the request that started it answered.</param>
    /// <param name="report">Told each time the operation's description changes.</param>
    /// <param name="ct">Cancellation.</param>
    public async Task<IncusOperation> SettleAsync(
        IncusResponse response,
        Action<string>? report = null,
        CancellationToken ct = default)
    {
        if (!response.IsAsync)
        {
            return new IncusOperation { StatusCode = IncusStatus.Success, Metadata = response.Metadata };
        }

        var id = response.OperationId;
        if (id.Length == 0)
        {
            throw new IncusException("the host started an operation without saying which one");
        }

        var last = "";

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            var wait = await client.GetAsync(
                $"{IncusClient.V1}/operations/{id}/wait?timeout={WaitSeconds.ToString(CultureInfo.InvariantCulture)}",
                ct).ConfigureAwait(false);

            var operation = wait.As<IncusOperation>()
                ?? throw new IncusException($"operation {id} answered /wait with nothing");

            if (report is not null && operation.Description.Length > 0 && operation.Description != last)
            {
                last = operation.Description;
                report(operation.Description);
            }

            if (IncusStatus.IsFinished(operation.StatusCode))
            {
                return operation;
            }
        }
    }

    /// <summary>Start an operation and wait for it, which is what nearly every call wants.</summary>
    private async Task<IncusOperation> DoAsync(
        Task<IncusResponse> call,
        Action<string>? report = null,
        CancellationToken ct = default) =>
        await AwaitAsync(await call.ConfigureAwait(false), report, ct).ConfigureAwait(false);

    // Networks — one object, and the range lives in it.

    public async Task<IncusNetworkInfo?> NetworkAsync(string name, CancellationToken ct = default)
    {
        try
        {
            return (await client.GetAsync($"{IncusClient.V1}/networks/{name}", ct).ConfigureAwait(false))
                .As<IncusNetworkInfo>();
        }
        catch (IncusException e) when (e.IsNotFound)
        {
            return null;
        }
    }

    /// <summary>
    /// Every address a network has handed out or has promised to somebody.
    /// </summary>
    /// <remarks>
    /// <para>
    /// What makes pinning safe on a network envmux did not create. Its own
    /// bridge keeps a band below the DHCP range that only envmux writes into,
    /// so looking at the instances it can see was enough. An adopted network
    /// promises no such band, and has tenants this client may not be able to
    /// list at all — instances in other projects — whose addresses show up
    /// here and nowhere else.
    /// </para>
    /// <para>
    /// No <c>recursion</c> on this one: the endpoint only ever answers with the
    /// leases themselves, never with URLs to them. A network that is not there
    /// has no leases, which is an empty list rather than an error — the caller
    /// that cares whether the network exists has already asked.
    /// </para>
    /// </remarks>
    public async Task<IReadOnlyList<NetworkLease>> LeasesAsync(string network, CancellationToken ct = default)
    {
        try
        {
            return (await client.GetAsync($"{IncusClient.V1}/networks/{network}/leases", ct).ConfigureAwait(false))
                .As<List<NetworkLease>>() ?? [];
        }
        catch (IncusException e) when (e.IsNotFound)
        {
            return [];
        }
    }

    /// <summary>
    /// Every address on a network that a new instance must not be pinned at.
    /// </summary>
    /// <remarks>
    /// Both sources, asked here so that everything which pins — a session, a
    /// service, the utility instance — asks the same way. Which of them wins is
    /// <see cref="InstanceSpec.TakenAddresses"/>; which address comes out of it
    /// is <see cref="Host.HostConfig.FirstFreePinned"/>.
    /// </remarks>
    public async Task<IReadOnlyCollection<string>> TakenAddressesAsync(string network, CancellationToken ct = default) =>
        InstanceSpec.TakenAddresses(
            await InstancesAsync(ct).ConfigureAwait(false),
            await LeasesAsync(network, ct).ConfigureAwait(false));

    /// <summary>
    /// Replace a network's configuration.
    /// </summary>
    /// <remarks>
    /// A range change is this one call, plus restarting whatever is attached —
    /// and plus the Windows route and NRPT rule, which is the half that gets
    /// forgotten. <see cref="Host.Windows.WindowsNetwork"/> owns that half so it
    /// cannot be.
    /// </remarks>
    public Task PutNetworkAsync(
        string name,
        IReadOnlyDictionary<string, string> config,
        CancellationToken ct = default) =>
        DoAsync(client.PutAsync($"{IncusClient.V1}/networks/{name}", WireJson.Object(Incus.IncusJson.Options, ("config", config)), ct), null, ct);

    /// <summary>
    /// Create a network — the <c>envmux0</c> bridge, on a daemon that has none.
    /// </summary>
    /// <remarks>
    /// The Hyper-V path gets this from the seed; the existing-Incus path makes
    /// the same call the seed's preseed makes, online. Creating one that is
    /// already there is an error to Incus and the desired state here, so it is
    /// caught — a daemon that already carries <c>envmux0</c> is one this has
    /// already run against.
    /// </remarks>
    public async Task<bool> CreateNetworkAsync(NetworksPost network, CancellationToken ct = default)
    {
        try
        {
            await DoAsync(client.PostAsync($"{IncusClient.V1}/networks", network, ct), null, ct)
                .ConfigureAwait(false);

            return true;
        }
        catch (IncusException e) when (e.Message.Contains("already exists", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
    }

    /// <summary>
    /// Remove a network — the <c>envmux0</c> bridge, when a host is reset.
    /// </summary>
    /// <remarks>
    /// Synchronous, the mirror of <see cref="CreateNetworkAsync"/>. On the
    /// existing-Incus path this is the one piece of the daemon reset touches
    /// that envmux itself created; a network that is already gone is the wanted
    /// end state, so a 404 is success rather than a failure.
    /// </remarks>
    /// <returns>True if it was removed, false if it was not there.</returns>
    public async Task<bool> DeleteNetworkAsync(string name, CancellationToken ct = default)
    {
        try
        {
            await client.DeleteAsync($"{IncusClient.V1}/networks/{name}", null, ct).ConfigureAwait(false);
            return true;
        }
        catch (IncusException e) when (e.IsNotFound)
        {
            return false;
        }
    }

    // Trust. One call, and only on the existing-Incus path — a Hyper-V host has
    // the certificate seeded before it boots.

    /// <summary>
    /// Add this client to the daemon's trust store, with a token it minted.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A synchronous call, not an operation: certificate changes take effect at
    /// once. It is made on a connection the daemon does not yet trust, which the
    /// endpoint allows precisely because the token proves the add was authorised
    /// by someone who could reach the daemon's own CLI.
    /// </para>
    /// <para>
    /// Adding a certificate the daemon already has is caught and reported as
    /// already-trusted, so running the existing-Incus install twice is not an
    /// error the second time.
    /// </para>
    /// </remarks>
    /// <returns>True if it was added, false if the daemon already trusted it.</returns>
    public async Task<bool> AddTrustedCertificateAsync(string token, CancellationToken ct = default)
    {
        var body = new CertificatesPost
        {
            Type = "client",
            Name = "envmux",
            TrustToken = token,
        };

        try
        {
            await client.PostAsync($"{IncusClient.V1}/certificates", body, ct).ConfigureAwait(false);
            return true;
        }
        catch (IncusException e) when (e.Message.Contains("already", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
    }

    /// <summary>
    /// Take a certificate out of the daemon's trust store, by its fingerprint.
    /// </summary>
    /// <remarks>
    /// The reset counterpart to <see cref="AddTrustedCertificateAsync"/>. On a
    /// daemon envmux does not own, reset removes only the entry it added — the
    /// one named <c>envmux</c> — and leaves every other client the daemon trusts
    /// alone. The fingerprint is the client certificate's own, which is how
    /// Incus keys its trust store; a fingerprint the daemon does not carry is
    /// already the end state, so a 404 is success.
    /// </remarks>
    /// <returns>True if it was removed, false if the daemon did not trust it.</returns>
    public async Task<bool> RemoveTrustedCertificateAsync(string fingerprint, CancellationToken ct = default)
    {
        try
        {
            await client.DeleteAsync($"{IncusClient.V1}/certificates/{fingerprint}", null, ct)
                .ConfigureAwait(false);
            return true;
        }
        catch (IncusException e) when (e.IsNotFound)
        {
            return false;
        }
    }

    // Instances.

    public async Task<IReadOnlyList<Instance>> InstancesAsync(CancellationToken ct = default) =>
        (await client.GetAsync($"{IncusClient.V1}/instances?recursion=1", ct).ConfigureAwait(false))
            .As<List<Instance>>() ?? [];

    public async Task<Instance?> InstanceAsync(string name, CancellationToken ct = default)
    {
        try
        {
            return (await client.GetAsync($"{IncusClient.V1}/instances/{name}", ct).ConfigureAwait(false))
                .As<Instance>();
        }
        catch (IncusException e) when (e.IsNotFound)
        {
            return null;
        }
    }

    public async Task<InstanceState?> StateAsync(string name, CancellationToken ct = default)
    {
        try
        {
            return (await client.GetAsync($"{IncusClient.V1}/instances/{name}/state", ct).ConfigureAwait(false))
                .As<InstanceState>();
        }
        catch (IncusException e) when (e.IsNotFound)
        {
            return null;
        }
    }

    public Task CreateAsync(InstancesPost body, Action<string>? report = null, CancellationToken ct = default) =>
        DoAsync(client.PostAsync($"{IncusClient.V1}/instances", body, ct), report, ct);

    public Task StartAsync(string name, CancellationToken ct = default) =>
        StateAsync(name, new InstanceStatePut { Action = "start" }, ct);

    /// <summary>
    /// Stop an instance, giving it a moment to do so on its own.
    /// </summary>
    /// <remarks>
    /// <c>force</c> with a timeout is not a contradiction: Incus waits the
    /// timeout for a clean shutdown and only then insists. Without force a
    /// container whose init ignores the signal never stops at all, and teardown
    /// hangs on it.
    /// </remarks>
    public async Task StopAsync(string name, int timeoutSeconds = 10, CancellationToken ct = default)
    {
        try
        {
            await StateAsync(
                name,
                new InstanceStatePut { Action = "stop", Timeout = timeoutSeconds, Force = true },
                ct).ConfigureAwait(false);
        }
        catch (IncusException e) when (e.IsNotFound || IsAlreadyStopped(e))
        {
            // Stopping a stopped instance is an error to Incus and the desired
            // outcome to everything here — teardown, prune, and rebuilding a
            // golden all reach this with the instance already down.
        }
    }

    /// <summary>Whether a refusal was "it is already in that state".</summary>
    private static bool IsAlreadyStopped(IncusException e) =>
        e.Message.Contains("already stopped", StringComparison.OrdinalIgnoreCase) ||
        e.Message.Contains("not running", StringComparison.OrdinalIgnoreCase);

    private Task<IncusOperation> StateAsync(string name, InstanceStatePut body, CancellationToken ct) =>
        DoAsync(client.PutAsync($"{IncusClient.V1}/instances/{name}/state", body, ct), null, ct);

    /// <summary>Remove an instance. Stopping it first is the caller's business.</summary>
    public async Task<bool> DeleteAsync(string name, CancellationToken ct = default)
    {
        try
        {
            await DoAsync(client.DeleteAsync($"{IncusClient.V1}/instances/{name}", null, ct), null, ct)
                .ConfigureAwait(false);

            return true;
        }
        catch (IncusException e) when (e.IsNotFound)
        {
            return false;
        }
    }

    /// <summary>
    /// Add a device to an instance, or replace the one of that name.
    /// </summary>
    /// <remarks>
    /// A <c>PATCH</c> rather than a <c>PUT</c>: it merges, so the nic and
    /// whatever else the instance carries are left alone, and a device that is
    /// already there under this name is rewritten rather than refused — which is
    /// what a proxy device pointing at a workstation address that moved wants.
    /// Works on a running instance; the device is live when the call returns.
    /// </remarks>
    public Task SetDeviceAsync(
        string instance,
        string device,
        IReadOnlyDictionary<string, string> config,
        CancellationToken ct = default) =>
        DoAsync(
            client.PatchAsync(
                $"{IncusClient.V1}/instances/{instance}",
                new
                {
                    devices = new Dictionary<string, IReadOnlyDictionary<string, string>>(StringComparer.Ordinal)
                    {
                        [device] = config,
                    },
                },
                ct),
            null,
            ct);

    // Snapshots, which are how the golden instance becomes many.

    public Task SnapshotAsync(string instance, string snapshot, CancellationToken ct = default) =>
        DoAsync(
            client.PostAsync(
                $"{IncusClient.V1}/instances/{instance}/snapshots",
                new SnapshotsPost { Name = snapshot },
                ct),
            null,
            ct);

    public async Task<IReadOnlyList<string>> SnapshotsAsync(string instance, CancellationToken ct = default)
    {
        try
        {
            var urls = (await client.GetAsync($"{IncusClient.V1}/instances/{instance}/snapshots", ct)
                .ConfigureAwait(false)).As<List<string>>() ?? [];

            return [.. urls.Select(u => u[(u.LastIndexOf('/') + 1)..])];
        }
        catch (IncusException e) when (e.IsNotFound)
        {
            return [];
        }
    }

    // Files. Not the envelope: a pull is the file itself, and its type is in a
    // header rather than in a body.

    /// <summary>What kind of thing is at a path inside an instance.</summary>
    public const string TypeHeader = "X-Incus-type";

    public const string ModeHeader = "X-Incus-mode";
    public const string UidHeader = "X-Incus-uid";
    public const string GidHeader = "X-Incus-gid";
    public const string WriteHeader = "X-Incus-write";

    /// <summary>Read a file out of an instance.</summary>
    /// <returns>Its bytes, or null when there is no such path.</returns>
    public async Task<byte[]?> PullAsync(string instance, string path, CancellationToken ct = default)
    {
        try
        {
            var (body, _) = await client.GetRawAsync(
                $"{IncusClient.V1}/instances/{instance}/files?path={Uri.EscapeDataString(path)}", ct)
                .ConfigureAwait(false);

            return body;
        }
        catch (IncusException e) when (e.IsNotFound)
        {
            return null;
        }
    }

    /// <summary>Write a file into an instance, creating or replacing it.</summary>
    public Task PushAsync(
        string instance,
        string path,
        ReadOnlyMemory<byte> content,
        string mode = "0644",
        int uid = 0,
        int gid = 0,
        CancellationToken ct = default) =>
        client.PostRawAsync(
            $"{IncusClient.V1}/instances/{instance}/files?path={Uri.EscapeDataString(path)}",
            content,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [TypeHeader] = "file",
                [ModeHeader] = mode,
                [UidHeader] = uid.ToString(CultureInfo.InvariantCulture),
                [GidHeader] = gid.ToString(CultureInfo.InvariantCulture),
                [WriteHeader] = "overwrite",
            },
            ct);

    /// <summary>
    /// Wait for an instance to be running and to have taken an address.
    /// </summary>
    /// <remarks>
    /// Running is not the same as reachable: the container is up before its
    /// network is, and a connection string handed out in between fails in a way
    /// that reads as the service being broken. A pinned address makes this
    /// unnecessary, which is why pinning is the default for anything envmux
    /// creates.
    /// </remarks>
    public async Task<string?> AwaitAddressAsync(
        string name,
        TimeSpan timeout,
        CancellationToken ct = default)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;

        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();

            if (await StateAsync(name, ct).ConfigureAwait(false) is { IsRunning: true, Address: { } address })
            {
                return address;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(250), ct).ConfigureAwait(false);
        }

        return null;
    }
}
