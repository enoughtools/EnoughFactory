using System.Text.Json;

using Envmux.Config;
using Envmux.Host;
using Envmux.Incus;
using Envmux.Session;

namespace Envmux.Tests;

/// <summary>
/// The envelope every Incus answer comes in, and the codes control flow reads.
/// </summary>
public class IncusResponseTests
{
    private static IncusResponse Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        return new IncusResponse(
            root.GetProperty("type").GetString()!,
            root.GetProperty("status_code").GetInt32(),
            root.TryGetProperty("operation", out var operation) ? operation.GetString()! : "",
            root.TryGetProperty("metadata", out var metadata) ? metadata.Clone() : default);
    }

    [Fact]
    public void AnAsyncResponseCarriesTheOperationsId()
    {
        var response = Parse(
            """
            {"type":"async","status":"Operation created","status_code":100,
             "operation":"/1.0/operations/9c3a2e1b-0000-4000-8000-000000000001","metadata":{}}
            """);

        Assert.True(response.IsAsync);
        Assert.Equal("9c3a2e1b-0000-4000-8000-000000000001", response.OperationId);
    }

    [Fact]
    public void ASyncResponseHasNoOperationToWaitFor()
    {
        var response = Parse("""{"type":"sync","status_code":200,"metadata":{}}""");

        Assert.False(response.IsAsync);
        Assert.Equal("", response.OperationId);
    }

    [Fact]
    public void ServerInfoSaysWhetherWeAreTrusted()
    {
        var response = Parse(
            """
            {"type":"sync","status_code":200,"metadata":{
              "auth":"trusted",
              "api_extensions":["instances","storage_pool_source_wipe"],
              "environment":{"server_version":"7.3","kernel_architecture":"x86_64","storage":"zfs"}}}
            """);

        var server = response.As<ServerInfo>()!;

        Assert.True(server.IsTrusted);
        Assert.Equal("7.3", server.Environment.ServerVersion);
        Assert.Equal("zfs", server.Environment.Storage);

        // Feature detection reads the extension list, never the version — the
        // version is a number, and what a daemon can do is a set.
        Assert.True(server.Has("instances"));
        Assert.False(server.Has("something_invented"));
    }

    [Fact]
    public void TheInstanceDriversAreOneStringWithASeparatorInIt()
    {
        // As the first real daemon reported it: Incus 7.0.1 on btrfs, able to
        // run both kinds. Whether a VM can be asked for is whether qemu is in
        // here, and a daemon that cannot says only "lxc".
        var both = Parse(
            """
            {"type":"sync","status_code":200,"metadata":{"auth":"trusted",
              "environment":{"server_version":"7.0.1","driver":"lxc | qemu","storage":"btrfs"}}}
            """).As<ServerInfo>()!;

        Assert.Equal("lxc | qemu", both.Environment.Driver);
        Assert.Contains("qemu", both.Environment.Driver, StringComparison.Ordinal);

        // Absent on a response that does not carry it, rather than null.
        var silent = Parse("""{"type":"sync","status_code":200,"metadata":{"auth":"trusted"}}""").As<ServerInfo>()!;

        Assert.Equal("", silent.Environment.Driver);
    }

    /// <summary>
    /// The storage drivers, in the shape a real daemon sends them.
    /// </summary>
    /// <remarks>
    /// Objects, with capitalised keys, where every other field on this API is
    /// snake_case and where a list of names would be the obvious guess. Guessing
    /// wrong threw during deserialisation and took out `host trust` after it had
    /// already pinned the fingerprint and said it had worked — so this is
    /// copied from incus 7.3 rather than written from the documentation.
    /// </remarks>
    [Fact]
    public void StorageDriversAreObjectsAndNotNames()
    {
        var server = Parse(
            """
            {"type":"sync","status_code":200,"metadata":{
              "auth":"trusted",
              "environment":{"server_version":"7.3","storage":"zfs","storage_supported_drivers":[
                {"Name":"dir","Version":"1","Remote":false},
                {"Name":"zfs","Version":"2.3.4","Remote":false},
                {"Name":"ceph","Version":"19.2.1","Remote":true}]}}}
            """).As<ServerInfo>()!;

        var drivers = server.Environment.StorageSupportedDrivers;

        Assert.Equal(3, drivers.Count);
        Assert.Equal("zfs", drivers[1].Name);
        Assert.Equal("2.3.4", drivers[1].Version);
        Assert.False(drivers[1].Remote);
        Assert.True(drivers[2].Remote);
    }

    /// <summary>
    /// A null in a config patch has to reach the wire.
    /// </summary>
    /// <remarks>
    /// Removing a key from an instance's config is done by patching it to null —
    /// an empty string leaves the variable set and empty, which is the `-h ""`
    /// failure in another costume. But the client's options carry
    /// <c>DefaultIgnoreCondition = WhenWritingNull</c>, and if that applies to
    /// dictionary values the null never leaves the process and the stale key
    /// stays forever. Asserted rather than assumed, because it was assumed once
    /// and was wrong.
    /// </remarks>
    [Fact]
    public void ANullConfigValueIsSerialised()
    {
        var config = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["environment.KEEP"] = "yes",
            ["environment.DROP"] = null,
        };

        var json = Envmux.Serialization.WireJson.Serialize(Envmux.Serialization.WireJson.Object(IncusJson.Options, ("config", config)), IncusJson.Options);

        Assert.Contains("\"environment.KEEP\":\"yes\"", json, StringComparison.Ordinal);
        Assert.Contains("\"environment.DROP\":null", json, StringComparison.Ordinal);
    }

    /// <summary>
    /// Adding a trusted certificate sends the token and no certificate at all.
    /// </summary>
    /// <remarks>
    /// This is the whole of how an existing Incus comes to trust envmux: a
    /// one-time token authorises the add, and the certificate field is left out
    /// so the daemon records the one presented on the TLS connection — the
    /// client's own. The field being <em>absent</em> rather than null is what
    /// makes that happen, so it is the thing worth pinning: a certificate
    /// serialised here, or even an explicit null the daemon read as "no cert,
    /// clear it", would add the wrong thing or nothing.
    /// </remarks>
    [Fact]
    public void AddingATrustedCertificateSendsTheTokenAndNoCertificate()
    {
        var json = JsonSerializer.Serialize(
            new CertificatesPost { Type = "client", Name = "envmux", TrustToken = "abc.def" },
            IncusJson.Options);

        Assert.Contains("\"type\":\"client\"", json, StringComparison.Ordinal);
        Assert.Contains("\"name\":\"envmux\"", json, StringComparison.Ordinal);
        Assert.Contains("\"trust_token\":\"abc.def\"", json, StringComparison.Ordinal);

        // Omitted, not null: WhenWritingNull drops it, and the daemon reads the
        // presented certificate precisely because the field is not there.
        Assert.DoesNotContain("certificate", json, StringComparison.Ordinal);
    }

    /// <summary>
    /// Creating a network keeps the Incus config keys exactly as written.
    /// </summary>
    /// <remarks>
    /// The online mirror of the seed's bridge: <c>POST /1.0/networks</c> with the
    /// same config the preseed carries. Its keys — <c>ipv4.address</c>,
    /// <c>ipv6.address</c> — are Incus config keys, not property names, and a
    /// naming policy that reached into the dictionary would turn them into keys
    /// the daemon has never heard of. The seed pins this offline; this pins it
    /// for the existing-Incus path, which builds the body from the same source.
    /// </remarks>
    [Fact]
    public void CreatingANetworkKeepsTheIncusConfigKeysIntact()
    {
        var json = JsonSerializer.Serialize(
            new NetworksPost
            {
                Name = HostConfig.DefaultNetwork,
                Type = "bridge",
                Description = "envmux sessions",
                Config = Seed.NetworkConfig(new HostConfig { Cidr = "10.42.0.1/24" }),
            },
            IncusJson.Options);

        Assert.Contains("\"name\":\"envmux0\"", json, StringComparison.Ordinal);
        Assert.Contains("\"type\":\"bridge\"", json, StringComparison.Ordinal);
        Assert.Contains("\"description\":\"envmux sessions\"", json, StringComparison.Ordinal);
        Assert.Contains("\"ipv4.address\":\"10.42.0.1/24\"", json, StringComparison.Ordinal);
        Assert.Contains("\"ipv6.address\":\"none\"", json, StringComparison.Ordinal);
    }

    /// <summary>A network created without a description does not send an empty one.</summary>
    [Fact]
    public void CreatingANetworkWithNoDescriptionOmitsTheField()
    {
        var json = JsonSerializer.Serialize(
            new NetworksPost
            {
                Name = HostConfig.DefaultNetwork,
                Type = "bridge",
                Config = new Dictionary<string, string>(StringComparer.Ordinal) { ["ipv4.address"] = "10.0.0.1/24" },
            },
            IncusJson.Options);

        Assert.DoesNotContain("description", json, StringComparison.Ordinal);
    }

    /// <summary>
    /// A failed operation carries its reason, and it must not be dropped.
    /// </summary>
    /// <remarks>
    /// A recorded exec whose operation fails outright produces no output files
    /// to explain itself — the reason is on the operation. Discarding it gives
    /// callers an empty string to interpolate, and "the feature would not
    /// install: " with nothing after the colon is the kind of message that costs
    /// an evening.
    /// </remarks>
    [Fact]
    public void AFailedOperationSaysWhy()
    {
        var operation = Parse(
            """
            {"type":"sync","status_code":200,"metadata":{
              "status":"Failure","status_code":400,
              "err":"Failed to run: /usr/bin/sh: exit status 1",
              "metadata":{}}}
            """).As<IncusOperation>()!;

        Assert.False(operation.Succeeded);
        Assert.Equal("Failed to run: /usr/bin/sh: exit status 1", operation.Err);

        // And no output files to explain it, which is why the reason matters.
        Assert.Empty(operation.Output());
    }

    /// <summary>
    /// A shape envmux cannot read is a message, not a stack trace.
    /// </summary>
    /// <remarks>
    /// Every model here is a partial view of what a daemon sends, so a daemon
    /// that changes a field nothing reads can still throw. What it must not do
    /// is escape as a raw JsonException: the command layer only catches its own
    /// exception types, so anything else reaches the user as a crash.
    /// </remarks>
    [Fact]
    public void AShapeItCannotReadIsAnIncusError()
    {
        var response = Parse(
            """
            {"type":"sync","status_code":200,"metadata":{
              "auth":"trusted",
              "environment":{"server_version":{"major":7,"minor":3}}}}
            """);

        var thrown = Assert.Throws<IncusException>(() => response.As<ServerInfo>());

        Assert.Contains("ServerInfo", thrown.Message, StringComparison.Ordinal);
        Assert.IsType<System.Text.Json.JsonException>(thrown.InnerException);
    }

    [Fact]
    public void AnUntrustedHostIsNotAnErrorButIsNotUsableEither()
    {
        var server = Parse("""{"type":"sync","status_code":200,"metadata":{"auth":"untrusted"}}""")
            .As<ServerInfo>()!;

        Assert.False(server.IsTrusted);
    }

    [Fact]
    public void AnInstancesAddressIsItsGlobalIpv4OnEth0()
    {
        var state = Parse(
            """
            {"type":"sync","status_code":200,"metadata":{
              "status":"Running","status_code":103,
              "network":{
                "lo":{"addresses":[{"family":"inet","address":"127.0.0.1","scope":"local"}]},
                "eth0":{"addresses":[
                  {"family":"inet6","address":"fe80::1","scope":"link"},
                  {"family":"inet","address":"10.100.0.5","netmask":"24","scope":"global"}]}}}}
            """).As<InstanceState>()!;

        Assert.True(state.IsRunning);
        Assert.Equal("10.100.0.5", state.Address);
    }

    [Fact]
    public void AnInstanceWithNoAddressYetHasNone()
    {
        // Running is not the same as reachable: the container is up before its
        // network is, and a connection string handed out in between fails in a
        // way that reads as the service being broken.
        var state = Parse(
            """
            {"type":"sync","status_code":200,"metadata":{
              "status":"Running","status_code":103,
              "network":{"lo":{"addresses":[{"family":"inet","address":"127.0.0.1","scope":"local"}]}}}}
            """).As<InstanceState>()!;

        Assert.Null(state.Address);
    }

    [Fact]
    public void OnlyTheCodesEndAnOperation()
    {
        // 200, 400 and 401 are finished; everything below them is still moving.
        Assert.True(IncusStatus.IsFinished(IncusStatus.Success));
        Assert.True(IncusStatus.IsFinished(IncusStatus.Failure));
        Assert.True(IncusStatus.IsFinished(IncusStatus.Cancelled));

        Assert.False(IncusStatus.IsFinished(IncusStatus.Running));
        Assert.False(IncusStatus.IsFinished(IncusStatus.Pending));
        Assert.False(IncusStatus.IsFinished(IncusStatus.OperationCreated));
    }

    [Fact]
    public void AnExecOperationHandsBackOneTerminalAndOneControlSocket()
    {
        // One bidirectional socket, not three: an interactive exec has a
        // terminal rather than separated streams. A response with "1" and "2"
        // in it is a non-interactive exec, which envmux never asks for.
        var operation = Parse(
            """
            {"type":"async","status_code":100,"operation":"/1.0/operations/abc","metadata":{
              "class":"websocket",
              "metadata":{"fds":{"0":"aaa","control":"bbb"}}}}
            """).As<IncusOperation>()!;

        var fds = operation.Fds();

        Assert.Equal("aaa", fds["0"]);
        Assert.Equal("bbb", fds["control"]);
        Assert.DoesNotContain("1", fds.Keys, StringComparer.Ordinal);
    }

    [Fact]
    public void AFinishedExecCarriesWhatItExitedWith()
    {
        var operation = Parse(
            """
            {"type":"sync","status_code":200,"metadata":{
              "status":"Success","status_code":200,"metadata":{"return":17}}}
            """).As<IncusOperation>()!;

        Assert.True(operation.Succeeded);
        Assert.Equal(17, operation.ReturnCode);
    }

    /// <summary>
    /// A network's leases, as <c>api.NetworkLease</c> declares them.
    /// </summary>
    /// <remarks>
    /// Objects and never URLs — this endpoint has no recursion to ask for — with
    /// both address families in one list. The field names are from
    /// <c>shared/api/network.go</c> in the Incus source rather than from a
    /// capture, which is worth knowing the day this disagrees with a daemon.
    /// Only three are modelled, and the rest have to be ignorable: the table is
    /// read to find out which addresses not to pin, and a field envmux has no
    /// name for is not a reason to stop reading it.
    /// </remarks>
    [Fact]
    public void ANetworksLeasesAreReadWithBothFamiliesInOneList()
    {
        var leases = Parse(
            """
            {"type":"sync","status_code":200,"metadata":[
              {"hostname":"ci-runner","hwaddr":"10:66:6a:12:34:56","address":"10.7.0.2","type":"dynamic","location":"none"},
              {"hostname":"ci-runner","hwaddr":"10:66:6a:12:34:56","address":"fd42:7::2","type":"dynamic","location":"none"},
              {"hostname":"proj-amber-fox","hwaddr":"10:66:6a:ab:cd:ef","address":"10.7.0.3","type":"static","location":"none"}]}
            """).As<List<NetworkLease>>()!;

        Assert.Equal(3, leases.Count);
        Assert.Equal("ci-runner", leases[0].Hostname);
        Assert.Equal("10.7.0.2", leases[0].Address);
        Assert.Equal("dynamic", leases[0].Type);
        Assert.Equal("fd42:7::2", leases[1].Address);
        Assert.Equal("static", leases[2].Type);
    }
}

/// <summary>
/// The two hyphenated keys and the one-word one, which no naming policy
/// produces and which are silently wrong if they are.
/// </summary>
public class ExecPostTests
{
    private static JsonElement Serialise(object body) =>
        JsonSerializer.SerializeToElement(body, IncusJson.Options);

    [Fact]
    public void TheHyphenatedKeysAreSpeltOnTheWire()
    {
        var body = Serialise(new ExecPost { Command = ["true"] });

        // A key that is silently wrong here is an exec that answers with three
        // sockets instead of one, and the symptom is a terminal that never draws.
        Assert.True(body.GetProperty("wait-for-websocket").GetBoolean());
        Assert.True(body.GetProperty("interactive").GetBoolean());
        Assert.False(body.GetProperty("record-output").GetBoolean());

        Assert.False(body.TryGetProperty("wait_for_websocket", out _));
        Assert.False(body.TryGetProperty("waitForWebsocket", out _));
    }

    [Fact]
    public void AResizeIsStringsAndASignalIsANumber()
    {
        // Incus' own InstanceExecControl uses different halves of one struct for
        // the two messages, and args are map[string]string even when they hold
        // numbers.
        var resize = Serialise(ExecControl.Resize(120, 40));

        Assert.Equal("window-resize", resize.GetProperty("command").GetString());
        Assert.Equal("120", resize.GetProperty("args").GetProperty("width").GetString());
        Assert.Equal("40", resize.GetProperty("args").GetProperty("height").GetString());
        Assert.False(resize.TryGetProperty("signal", out _));

        var signal = Serialise(ExecControl.Interrupt(Signals.Int));

        Assert.Equal("signal", signal.GetProperty("command").GetString());
        Assert.Equal(2, signal.GetProperty("signal").GetInt32());
    }

    [Fact]
    public void ASizeIsNeverZero()
    {
        // A pty sized 0x0 draws nothing, and a console that has not been read
        // yet reports zero.
        var resize = Serialise(ExecControl.Resize(0, -4));

        Assert.Equal("1", resize.GetProperty("args").GetProperty("width").GetString());
        Assert.Equal("1", resize.GetProperty("args").GetProperty("height").GetString());
    }
}

/// <summary>
/// The multiplexer, which is what stands between "the pty belongs to the
/// connection" and "a dropped connection must not kill a build".
/// </summary>
public class LatchTests
{
    [Fact]
    public void AttachingCreatesTheSessionIfThereIsNotOne()
    {
        // -A is the whole latch: attach to an existing session, or make it.
        var command = Latch.Shell("proj-sess-shell", "/bin/bash");

        Assert.Equal(
            ["tmux", "new-session", "-A", "-s", "proj-sess-shell", "/bin/bash"],
            command);
    }

    [Fact]
    public void ALatchIdIsSomethingTmuxCanTarget()
    {
        // tmux reads a dot as a pane separator and a colon as a window one, so a
        // name with either is a name that cannot be targeted.
        var id = Latch.Id("My Proj", "feat/login", "web:2");

        Assert.Equal("my-proj-feat-login-web-2", id);
        Assert.DoesNotContain('.', id);
        Assert.DoesNotContain(':', id);
    }

    [Fact]
    public void ATasksLogIsNamedForItsLatch() =>
        Assert.Equal("/var/log/envmux/proj-sess-web.log", Latch.LogPath("proj-sess-web"));

    [Fact]
    public void ListingParsesNamesAndIgnoresTmuxsOwnNoise()
    {
        var parsed = Latch.Parse("no server running on /tmp/tmux-1000/default\nproj-sess-web\nproj-sess-shell\n");

        Assert.Equal(["proj-sess-web", "proj-sess-shell"], parsed);
    }

    [Fact]
    public void TheProvisioningInstallsTheMultiplexerItDependsOn()
    {
        // Every exec goes through it, so a golden image without it produces "no
        // such file or directory" from a place that looks nothing like the cause.
        var script = Golden.Provision();

        Assert.Contains(Latch.Multiplexer, script, StringComparison.Ordinal);
        Assert.Contains(Latch.LogDirectory, script, StringComparison.Ordinal);

        // And the sshd an editor attaches through, since there is no Dev
        // Containers equivalent across a machine boundary.
        Assert.Contains("openssh-server", script, StringComparison.Ordinal);
    }
}

/// <summary>
/// What a session's instance is asked for, which is much less than a container
/// used to be.
/// </summary>
public class InstanceSpecTests
{
    private static Instance With(params (string Key, string Value)[] config) => new()
    {
        Name = "thing",
        Config = config.ToDictionary(c => c.Key, c => c.Value, StringComparer.Ordinal),
    };

    /// <summary>An image has a fingerprint and belongs to no session.</summary>
    [Fact]
    public void AnImageIsAnImage()
    {
        var image = With(
            (InstanceSpec.Keys.Schema, "2"),
            (InstanceSpec.Keys.Project, "five80"),
            (InstanceSpec.Keys.Image, "f68c3c95"));

        Assert.True(InstanceSpec.IsOurs(image));
        Assert.True(InstanceSpec.IsImage(image));
    }

    /// <summary>
    /// A session copied from one is still a session.
    /// </summary>
    /// <remarks>
    /// It carries the fingerprint because copying an instance copies its config.
    /// What it also carries, and an image never does, is a session label.
    /// </remarks>
    [Fact]
    public void ASessionCopiedFromAnImageIsNotAnImage()
    {
        var session = With(
            (InstanceSpec.Keys.Schema, "2"),
            (InstanceSpec.Keys.Project, "five80"),
            (InstanceSpec.Keys.Session, "final"),
            (InstanceSpec.Keys.Image, "f68c3c95"));

        Assert.True(InstanceSpec.IsOurs(session));
        Assert.False(InstanceSpec.IsImage(session));
    }

    /// <summary>A session that copied golden has no fingerprint at all.</summary>
    [Fact]
    public void APlainSessionIsNotAnImage()
    {
        var session = With(
            (InstanceSpec.Keys.Schema, "2"),
            (InstanceSpec.Keys.Project, "planno"),
            (InstanceSpec.Keys.Session, "demo"));

        Assert.False(InstanceSpec.IsImage(session));
    }

    /// <summary>Somebody else's container is nobody's business here.</summary>
    [Fact]
    public void AnInstanceEnvmuxDidNotMakeIsNotOurs()
    {
        var theirs = With(("user.something.else", "yes"));

        Assert.False(InstanceSpec.IsOurs(theirs));
        Assert.False(InstanceSpec.IsImage(theirs));
    }

    /// <summary>The labels an image is created with are the ones that identify it.</summary>
    [Fact]
    public void AnImageIsLabelledSoItCanBeFoundAgain()
    {
        var config = InstanceSpec.ForImage("five80", "f68c3c95", @"Z:\five80", DateTimeOffset.UnixEpoch, nesting: true);

        Assert.Equal("f68c3c95", config[InstanceSpec.Keys.Image]);
        Assert.Equal("five80", config[InstanceSpec.Keys.Project]);
        Assert.Equal(@"Z:\five80", config[InstanceSpec.Keys.Directory]);
        Assert.Equal("true", config[InstanceSpec.Nesting]);

        // And no session, which is what makes it an image rather than one.
        Assert.False(config.ContainsKey(InstanceSpec.Keys.Session));
    }

    /// <summary>Nesting is only there when a feature asked for it.</summary>
    [Fact]
    public void AnImageWithoutDockerIsNotNested()
    {
        var config = InstanceSpec.ForImage("planno", "abc", @"Z:\planno", DateTimeOffset.UnixEpoch, nesting: false);

        Assert.False(config.ContainsKey(InstanceSpec.Nesting));
    }

    private static SessionPlan Plan(string json = "{}", string session = "amber-fox") =>
        SessionPlan.Resolve(
            JsonSerializer.Deserialize<SessionConfig>(json, SessionConfig.JsonOptions)!,
            Directory.GetCurrentDirectory(),
            session);

    [Fact]
    public void AGoldenSessionIsACopyRatherThanAPull()
    {
        // On a ZFS pool a copy is a clone: near-instant, and near-zero disk
        // until something is written. That is the mechanism that makes another
        // dev machine cheap.
        var post = InstanceSpec.ForSession(Plan(), new HostConfig(), fromGolden: true, DateTimeOffset.UnixEpoch);

        Assert.Equal("copy", post.Source.Type);
        Assert.Equal(Golden.Source, post.Source.Source);
        Assert.Null(post.Source.Alias);
    }

    [Fact]
    public void WithoutGoldenItPullsAndSaysWhereFrom()
    {
        var post = InstanceSpec.ForSession(Plan(), new HostConfig(), fromGolden: false, DateTimeOffset.UnixEpoch);

        Assert.Equal("image", post.Source.Type);
        Assert.Equal(HostConfig.DefaultImage, post.Source.Alias);
        Assert.Equal(HostConfig.DefaultImageServer, post.Source.Server);
        Assert.Equal("simplestreams", post.Source.Protocol);
    }

    [Fact]
    public void APinnedAddressOverridesTheProfilesNic()
    {
        var post = InstanceSpec.ForSession(
            Plan(), new HostConfig(), fromGolden: true, DateTimeOffset.UnixEpoch, "10.100.0.4");

        var eth0 = post.Devices!["eth0"];

        Assert.Equal("nic", eth0["type"]);
        Assert.Equal(HostConfig.DefaultNetwork, eth0["network"]);
        Assert.Equal("10.100.0.4", eth0["ipv4.address"]);
    }

    [Fact]
    public void WithNoAddressItStillNamesTheBridgeAndLeavesTheAddressToDhcp()
    {
        // The nic is always set, so an instance never inherits the default
        // profile's bridge — which on an existing Incus is incusbr0, not ours.
        // Only the address is left off, for DHCP on the same bridge.
        var eth0 = InstanceSpec
            .ForSession(Plan(), new HostConfig(), fromGolden: true, DateTimeOffset.UnixEpoch)
            .Devices!["eth0"];

        Assert.Equal("nic", eth0["type"]);
        Assert.Equal(HostConfig.DefaultNetwork, eth0["network"]);
        Assert.False(eth0.ContainsKey("ipv4.address"));
    }

    [Fact]
    public void EverythingIsAttachedToTheNetworkTheHostsFileNames()
    {
        // A host pointed at a subnet the daemon already had. A session, its
        // services, and anything else that asks for the device all land on
        // that network — envmux0 is only what the name defaults to, and an
        // instance on it here would be on a bridge that does not exist.
        var host = new HostConfig { Provider = HostConfig.Incus, Network = "labbr0", Cidr = "10.7.0.1/24", DhcpRange = "" };
        var plan = Plan("""{"name":"proj","services":{"db":{"type":"postgres","password":"secret"}}}""");

        var session = InstanceSpec.ForSession(plan, host, fromGolden: true, DateTimeOffset.UnixEpoch, "10.7.0.2");
        var service = InstanceSpec.ForService(plan.Services.Single(), plan, host, DateTimeOffset.UnixEpoch, "10.7.0.3");

        Assert.Equal("labbr0", session.Devices!["eth0"]["network"]);
        Assert.Equal("10.7.0.2", session.Devices["eth0"]["ipv4.address"]);
        Assert.Equal("labbr0", service.Devices!["eth0"]["network"]);
        Assert.Equal("10.7.0.3", service.Devices["eth0"]["ipv4.address"]);

        var bare = InstanceSpec.Attached(host)["eth0"];

        Assert.Equal("labbr0", bare["network"]);
        Assert.Equal("eth0", bare["name"]);
        Assert.False(bare.ContainsKey("ipv4.address"));
    }

    [Fact]
    public void WhatIsTakenIsEveryPinnedNicAndEveryLease()
    {
        var instances = new[]
        {
            Pinned("proj-amber-fox", "eth0", "10.100.0.2"),

            // Not eth0, and still an address nobody else may have.
            Pinned("two-nics", "eth1", "10.100.0.3"),

            // On DHCP: a nic, and no address of its own to report.
            new Instance
            {
                Name = "leased",
                Devices = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal)
                {
                    ["eth0"] = new(StringComparer.Ordinal) { ["type"] = "nic", ["network"] = "envmux0" },
                },
            },

            // The golden instance and anything else riding the profile's nic.
            new Instance { Name = "no-devices" },
        };

        var leases = new[]
        {
            new NetworkLease { Hostname = "leased", Address = "10.100.0.117", Type = "dynamic" },
            new NetworkLease { Hostname = "leased", Address = "fd42::117", Type = "dynamic" },
            new NetworkLease { Hostname = "proj-amber-fox", Address = "10.100.0.2", Type = "static" },
            new NetworkLease { Hostname = "blank" },
        };

        var taken = InstanceSpec.TakenAddresses(instances, leases);

        Assert.Equal(
            ["10.100.0.117", "10.100.0.2", "10.100.0.3", "fd42::117"],
            taken.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void ALeaseSomebodyElseHoldsIsNotPinnedOver()
    {
        // The whole of lease awareness, end to end without a daemon: an adopted
        // bridge with no range, a tenant envmux cannot list holding .2 by DHCP,
        // and one session already pinned at .3.
        var host = new HostConfig
        {
            Provider = HostConfig.Incus,
            Network = "incusbr0",
            Cidr = "10.7.0.1/24",
            DhcpRange = "",
        };

        var taken = InstanceSpec.TakenAddresses(
            [Pinned("proj-amber-fox", "eth0", "10.7.0.3")],
            [new NetworkLease { Hostname = "ci-runner", Address = "10.7.0.2", Type = "dynamic" }]);

        Assert.Equal("10.7.0.4", host.FirstFreePinned(taken)?.ToString());
    }

    private static Instance Pinned(string name, string device, string address) => new()
    {
        Name = name,
        Devices = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal)
        {
            [device] = new(StringComparer.Ordinal)
            {
                ["type"] = "nic",
                ["network"] = "envmux0",
                ["ipv4.address"] = address,
            },
        },
    };

    [Fact]
    public void EverythingEnvmuxMakesIsLabelledAsItsOwn()
    {
        var plan = Plan("""{"name":"proj"}""");
        var post = InstanceSpec.ForSession(plan, new HostConfig(), true, DateTimeOffset.UnixEpoch);

        var instance = new Instance { Name = post.Name, Config = post.Config! };

        Assert.True(InstanceSpec.IsOurs(instance));
        Assert.Equal("proj", InstanceSpec.Label(instance, InstanceSpec.Keys.Project));
        Assert.Equal("amber-fox", InstanceSpec.Label(instance, InstanceSpec.Keys.Session));
        Assert.Equal(plan.Branch, InstanceSpec.Label(instance, InstanceSpec.Keys.Branch));
        Assert.Equal(plan.Directory, InstanceSpec.Label(instance, InstanceSpec.Keys.Directory));
    }

    [Fact]
    public void SomethingElseOnTheHostIsNotOurs() =>
        Assert.False(InstanceSpec.IsOurs(new Instance { Name = "somebody-elses-vm" }));

    [Fact]
    public void AServiceIsAnOciApplicationContainerWithItsEnvironmentInTheConfig()
    {
        var plan = Plan("""{"name":"proj","services":{"db":{"type":"postgres","password":"secret"}}}""");
        var service = plan.Services.Single();

        var post = InstanceSpec.ForService(service, plan, new HostConfig(), DateTimeOffset.UnixEpoch);

        // A service is published as a Docker image and there is no reason to
        // make anybody find a system-container equivalent.
        Assert.Equal("oci", post.Source.Protocol);
        Assert.Equal(service.Image, post.Source.Alias);

        // `environment.` is Incus' prefix for what the container's init sees,
        // which is how a service is configured.
        Assert.Equal("secret", post.Config!["environment.POSTGRES_PASSWORD"]);
        Assert.Equal("db", InstanceSpec.Label(new Instance { Config = post.Config }, InstanceSpec.Keys.Service));
    }
}

/// <summary>
/// The repository crossing the machine boundary, and the commits coming back.
/// </summary>
public class WorkspaceTests
{
    [Fact]
    public void TheSurveyReadsAllThreeAnswers()
    {
        var (head, ahead, dirty) = Workspace.ParseSurvey(
            "head=1f2e3d4c5b6a7988\nahead=3\ndirty=12\n");

        Assert.Equal("1f2e3d4c5b6a7988", head);
        Assert.Equal(3, ahead);
        Assert.Equal(12, dirty);
    }

    [Fact]
    public void ARepositoryWithNoCommitsYetSurveysAsNothing()
    {
        var (head, ahead, dirty) = Workspace.ParseSurvey("head=none\nahead=0\ndirty=0\n");

        Assert.Equal("none", head);
        Assert.Equal(0, ahead);
        Assert.Equal(0, dirty);
    }

    [Fact]
    public void OutputThatIsNotTheSurveyIsReadAsNothingRatherThanThrowing()
    {
        // The survey runs during teardown, over a pty, alongside whatever a
        // shell profile decided to print. A stray line must not be fatal.
        var (head, ahead, dirty) = Workspace.ParseSurvey("Welcome to Debian!\nhead=abc\nahead=notanumber\n");

        Assert.Equal("abc", head);
        Assert.Equal(0, ahead);
        Assert.Equal(0, dirty);
    }

    [Theory]
    [InlineData("/work", "'/work'")]
    [InlineData("/work/it's here", @"'/work/it'\''s here'")]
    [InlineData("a; rm -rf /", "'a; rm -rf /'")]
    [InlineData("$(whoami)", "'$(whoami)'")]
    public void EveryValueThatReachesAShellIsQuoted(string value, string expected)
    {
        // Every one of these is a workdir, a branch or an account name out of a
        // configuration file, and a configuration file is not a place to have
        // decided shell metacharacters are impossible.
        Assert.Equal(expected, Workspace.Quote(value));
    }
}

/// <summary>
/// The account inside an instance, which is much less than it was.
/// </summary>
public class BootstrapTests
{
    private const string Link = "/myproj_feat-login";

    [Fact]
    public void ItMakesAnAccountAndItIsNotRoot()
    {
        var script = Bootstrap.Script("matt", "/work", Link);

        Assert.Contains("useradd -m", script, StringComparison.Ordinal);
        Assert.Contains("chown 'matt' '/work'", script, StringComparison.Ordinal);
    }

    [Fact]
    public void RunningItTwiceIsNotAnError()
    {
        // An adopted instance runs it again, and a second run that failed on
        // "user already exists" would report the session as having no account.
        Assert.Contains("id -u 'matt' >/dev/null 2>&1 ||", Bootstrap.Script("matt", "/work", Link), StringComparison.Ordinal);
    }

    [Fact]
    public void ThereIsSomewhereForLatchedTasksToWrite()
    {
        var script = Bootstrap.Script("matt", "/work", Link);

        Assert.Contains(Latch.LogDirectory, script, StringComparison.Ordinal);

        // Sticky, so every account can write its own logs and none can remove
        // another's.
        Assert.Contains("chmod 1777", script, StringComparison.Ordinal);
    }

    [Fact]
    public void AnAwkwardUsernameIsQuotedRatherThanInterpolated() =>
        Assert.Contains("'a b'", Bootstrap.Script("a b", "/work", Link), StringComparison.Ordinal);

    /// <summary>
    /// The session-named link the editor opens, so a recents list full of
    /// sessions is not a recents list full of <c>work</c>.
    /// </summary>
    [Fact]
    public void TheWorkdirGetsASessionNamedLink()
    {
        var script = Bootstrap.Script("matt", "/work", Link);

        // After the directory exists, since a link to nothing is what the
        // editor would otherwise open on a fresh instance.
        var made = script.IndexOf("mkdir -p '/work'", StringComparison.Ordinal);
        var linked = script.IndexOf($"ln -sfn '/work' '{Link}'", StringComparison.Ordinal);

        Assert.True(made >= 0 && linked > made, script);
    }

    /// <summary>
    /// `-n`, or the second run makes /myproj_feat-login/work.
    /// </summary>
    /// <remarks>
    /// Without it, ln sees a link that resolves to a directory and does what it
    /// does with any directory: puts the new link inside it. A kept instance
    /// runs this again every time the session starts, so that is not a corner.
    /// </remarks>
    [Fact]
    public void RelinkingIsReplacementNotNesting()
    {
        var line = Bootstrap.Script("matt", "/work", Link)
            .Split('\n')
            .Single(l => l.Contains("ln -s", StringComparison.Ordinal));

        Assert.Contains("ln -sfn", line, StringComparison.Ordinal);

        // And only ever a link, or nothing. A real directory somebody made at
        // that name inside the instance is not this script's to remove.
        Assert.StartsWith($"if [ -L '{Link}' ] || [ ! -e '{Link}' ]; then", line, StringComparison.Ordinal);
    }

    /// <summary>The link is a config value like the workdir, and quoted like one.</summary>
    [Fact]
    public void TheLinkIsQuotedLikeEverythingElseThatReachesAShell() =>
        Assert.Contains("ln -sfn '/src dir' '/a_b'", Bootstrap.Script("matt", "/src dir", "/a_b"), StringComparison.Ordinal);
}

/// <summary>
/// The shell that launches a task into its latch. Every clause in it is there
/// because of a specific way tasks used to go wrong.
/// </summary>
public class LatchedTaskTests
{
    private static string Launch(string command)
    {
        var plan = SessionPlan.Resolve(
            JsonSerializer.Deserialize<SessionConfig>(
                $$"""{ "name": "proj", "tasks": { "web": {{JsonSerializer.Serialize(command)}} } }""",
                SessionConfig.JsonOptions)!,
            Directory.GetCurrentDirectory(),
            "sess");

        var task = new SessionTask(plan.Tasks.Single(), new SessionLog());
        task.Bind(null!, plan.InstanceName, "matt", Latch.Id(plan.Project, plan.Session, "web"));

        return task.LaunchScript();
    }

    [Fact]
    public void ItStartsDetachedSoTheProcessOutlivesTheConnection()
    {
        // -d, not -A. An interactive exec is a pty owned by its websocket, so a
        // task started down one dies the moment the connection does.
        var script = Launch("npm run dev");

        Assert.Contains("tmux new-session -d -s 'proj-sess-web'", script, StringComparison.Ordinal);
    }

    [Fact]
    public void ItSetsPipefailBeforeTheTee()
    {
        // Without it the status after the pipe is tee's, so every task in the
        // world exits zero and no restart policy ever fires.
        var script = Launch("false");

        var pipefail = script.IndexOf("pipefail", StringComparison.Ordinal);
        var tee = script.IndexOf("| tee -a", StringComparison.Ordinal);

        Assert.True(pipefail >= 0, "the launcher does not set pipefail");
        Assert.True(pipefail < tee, "pipefail is set after the pipe it applies to");
    }

    [Fact]
    public void TheExitCodeComesBackThroughTheLog()
    {
        // The process is detached inside tmux, so there is no exec whose exit
        // code could be read. A line the follower recognises is the only channel.
        var script = Launch("npm ci");

        Assert.Contains(SessionTask.ExitMarker, script, StringComparison.Ordinal);
        Assert.Contains(Latch.LogPath("proj-sess-web"), script, StringComparison.Ordinal);
    }

    [Fact]
    public void TheLogIsTruncatedAtEachStart()
    {
        // It is what the follower replays from the top. Appending would replay
        // every previous run of the task into the pane on every restart.
        Assert.Contains($": > '{Latch.LogPath("proj-sess-web")}'", Launch("npm ci"), StringComparison.Ordinal);
    }

    [Fact]
    public void TheCommandAndItsEnvironmentAreQuoted()
    {
        // The command is a value from a configuration file and it is composed
        // into a shell twice over — once for the inner bash, once for the outer
        // tmux invocation.
        var script = Launch("echo 'it works'");

        Assert.DoesNotContain("echo 'it works'\n", script, StringComparison.Ordinal);
        Assert.Contains("ENVMUX_TASK=", script, StringComparison.Ordinal);
    }
}
