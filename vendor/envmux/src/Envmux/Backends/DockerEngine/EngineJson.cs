using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Envmux.Backends.DockerEngine;

/// <summary>
/// The engine's own JSON, written from and read into the flattened shapes in
/// <see cref="IDockerEngine"/>.
/// </summary>
/// <remarks>
/// <para>
/// By hand — <see cref="JsonObject"/> out, <see cref="JsonElement"/> in — and
/// not through a serializer. The engine's names are PascalCase with exceptions,
/// its maps are keyed by things like <c>5173/tcp</c>, and half of what is read
/// is two or three levels down; a model per level would be more code than this
/// and would break on the first field a newer engine changes the type of. It
/// also keeps this path free of reflection, which is what a trimmed build wants.
/// </para>
/// <para>
/// Pure, so the shapes can be asserted without an engine.
/// </para>
/// </remarks>
internal static class EngineJson
{
    /// <summary>The body of <c>POST /containers/create</c>.</summary>
    public static JsonObject CreateBody(ContainerCreate spec)
    {
        var body = new JsonObject { ["Image"] = spec.Image };

        if (spec.Entrypoint is not null)
        {
            body["Entrypoint"] = Strings(spec.Entrypoint);
        }

        if (spec.Cmd is not null)
        {
            body["Cmd"] = Strings(spec.Cmd);
        }

        // Set, NetworkMode is somebody else's network stack — container:<name>
        // joins a session's namespace — and the engine refuses a container that
        // then claims a hostname, ports or an endpoint of its own. So none are
        // written, whatever else the spec says.
        var borrowed = spec.NetworkMode is { Length: > 0 };

        if (!borrowed)
        {
            AddIfSet(body, "Hostname", spec.Hostname);
        }

        AddIfSet(body, "User", spec.User);
        AddIfSet(body, "WorkingDir", spec.WorkingDir);

        if (spec.Tty)
        {
            // A terminal with nothing holding its input open reads EOF at once,
            // and a shell as PID 1 exits on it.
            body["Tty"] = true;
            body["OpenStdin"] = true;
        }

        if (spec.Env.Count > 0)
        {
            body["Env"] = Strings(spec.Env.Select(pair => $"{pair.Key}={pair.Value}"));
        }

        if (spec.Labels.Count > 0)
        {
            body["Labels"] = Map(spec.Labels);
        }

        var host = new JsonObject { ["Init"] = spec.Init };

        if (spec.Ports.Count > 0 && !borrowed)
        {
            // Two halves, and the engine wants both: the port is exposed by the
            // container, and bound on the host. One container port may be bound
            // on several addresses, so the bindings are a list under one key.
            var exposed = new JsonObject();
            var bindings = new JsonObject();

            foreach (var port in spec.Ports)
            {
                var key = PortKey(port.ContainerPort, port.Protocol);

                if (!exposed.ContainsKey(key))
                {
                    exposed[key] = new JsonObject();
                    bindings[key] = new JsonArray();
                }

                bindings[key]!.AsArray().Add((JsonNode)new JsonObject
                {
                    ["HostIp"] = port.HostIp,
                    ["HostPort"] = port.HostPort.ToString(CultureInfo.InvariantCulture),
                });
            }

            body["ExposedPorts"] = exposed;
            host["PortBindings"] = bindings;
        }

        if (spec.Mounts.Count > 0)
        {
            var mounts = new JsonArray();

            foreach (var mount in spec.Mounts)
            {
                var entry = new JsonObject { ["Type"] = mount.Type };

                // A tmpfs has no source, and the engine refuses one that says it does.
                if (mount.Source.Length > 0)
                {
                    entry["Source"] = mount.Source;
                }

                entry["Target"] = mount.Target;
                entry["ReadOnly"] = mount.ReadOnly;
                if (mount.Type == "bind" && mount.Propagation is { Length: > 0 } propagation)
                {
                    entry["BindOptions"] = new JsonObject { ["Propagation"] = propagation };
                }
                mounts.Add((JsonNode)entry);
            }

            host["Mounts"] = mounts;
        }

        if (borrowed)
        {
            host["NetworkMode"] = spec.NetworkMode;
        }
        else if (spec.Network is { Length: > 0 } network)
        {
            host["NetworkMode"] = network;

            var endpoint = new JsonObject();

            if (spec.NetworkAliases.Count > 0)
            {
                endpoint["Aliases"] = Strings(spec.NetworkAliases);
            }

            body["NetworkingConfig"] = new JsonObject
            {
                ["EndpointsConfig"] = new JsonObject { [network] = endpoint },
            };
        }

        if (spec.ExtraHosts.Count > 0)
        {
            host["ExtraHosts"] = Strings(spec.ExtraHosts);
        }

        if (spec.CapAdd.Count > 0)
        {
            host["CapAdd"] = Strings(spec.CapAdd);
        }

        if (spec.SecurityOpt.Count > 0)
        {
            host["SecurityOpt"] = Strings(spec.SecurityOpt);
        }

        if (spec.Sysctls.Count > 0)
        {
            host["Sysctls"] = Map(spec.Sysctls);
        }

        if (spec.GroupAdd.Count > 0)
        {
            host["GroupAdd"] = Strings(spec.GroupAdd);
        }

        if (spec.AutoRemove)
        {
            host["AutoRemove"] = true;
        }

        if (spec.MemoryBytes is { } memory)
        {
            host["Memory"] = memory;
        }

        if (spec.NanoCpus is { } cpus)
        {
            host["NanoCpus"] = cpus;
        }

        body["HostConfig"] = host;
        return body;
    }

    /// <summary>The body of <c>POST /containers/{id}/exec</c>.</summary>
    /// <param name="consoleSize">Whether the engine is new enough (API 1.42) to take a size at birth.</param>
    public static JsonObject ExecBody(ExecCreate spec, bool consoleSize = true)
    {
        var body = new JsonObject
        {
            ["Cmd"] = Strings(spec.Cmd),
            ["Tty"] = spec.Tty,
            ["AttachStdin"] = spec.AttachStdin,
            ["AttachStdout"] = true,
            ["AttachStderr"] = true,
        };

        AddIfSet(body, "User", spec.User);
        AddIfSet(body, "WorkingDir", spec.WorkingDir);

        if (spec.Env is { Count: > 0 } env)
        {
            body["Env"] = Strings(env.Select(pair => $"{pair.Key}={pair.Value}"));
        }

        if (consoleSize && spec.Tty && spec.ConsoleSize is { } size)
        {
            // Height first. The engine's order, and the opposite of everyone's intuition.
            body["ConsoleSize"] = new JsonArray(size.Rows, size.Columns);
        }

        return body;
    }

    /// <summary>The <c>filters</c> query value that selects by label: every one given must match.</summary>
    public static string? LabelFilter(IReadOnlyDictionary<string, string>? labels)
    {
        if (labels is null || labels.Count == 0)
        {
            return null;
        }

        var filter = new JsonObject
        {
            ["label"] = Strings(labels.Select(pair => pair.Value.Length == 0 ? pair.Key : $"{pair.Key}={pair.Value}")),
        };

        return filter.ToJsonString();
    }

    /// <summary><c>GET /containers/{id}/json</c>, flattened.</summary>
    /// <remarks>
    /// <para>
    /// <b>Ports.</b> While the container runs they are read from
    /// <c>NetworkSettings.Ports</c>, which is what the engine actually bound.
    /// Stopped, that map is empty, so they are read from
    /// <c>HostConfig.PortBindings</c>, which is what it was created with —
    /// the answer "would this container publish what the session now declares"
    /// needs whether or not it is up.
    /// </para>
    /// <para>
    /// <b>Image</b> is the reference it was created from (<c>Config.Image</c>),
    /// not the digest, because that is what envmux tagged and compares.
    /// </para>
    /// </remarks>
    public static ContainerInspect Inspect(JsonElement root)
    {
        var state = Child(root, "State");
        var config = Child(root, "Config");
        var hostConfig = Child(root, "HostConfig");
        var settings = Child(root, "NetworkSettings");

        var status = Text(state, "Status") ?? "";
        var running = Flag(state, "Running");

        // A container that has never run reports an exit code of 0, which reads
        // as "succeeded". It has not exited; it has no code.
        int? exitCode = running || status.Equals("created", StringComparison.Ordinal)
            ? null
            : Number(state, "ExitCode");

        var ports = Ports(Child(settings, "Ports"));

        if (ports.Count == 0)
        {
            ports = Ports(Child(hostConfig, "PortBindings"));
        }

        var mounts = new List<MountSpec>();

        foreach (var mount in Items(Child(root, "Mounts")))
        {
            var type = Text(mount, "Type") ?? "";

            // A volume is known by its name; its Source is a path inside the
            // engine's own storage that means nothing to anyone.
            var source = type.Equals("volume", StringComparison.Ordinal)
                ? Text(mount, "Name") ?? ""
                : Text(mount, "Source") ?? "";

            mounts.Add(new MountSpec(type, source, Text(mount, "Destination") ?? "", !Flag(mount, "RW", whenMissing: true),
                type == "bind" ? Text(mount, "Propagation") : null));
        }

        // An older engine leaves a tmpfs out of the top-level list; it is then
        // only where it was asked for.
        foreach (var mount in Items(Child(hostConfig, "Mounts")))
        {
            var target = Text(mount, "Target") ?? "";

            if ((Text(mount, "Type") ?? "").Equals("tmpfs", StringComparison.Ordinal) &&
                !mounts.Exists(m => m.Target.Equals(target, StringComparison.Ordinal)))
            {
                mounts.Add(new MountSpec("tmpfs", "", Text(mount, "Target") ?? "", Flag(mount, "ReadOnly")));
            }
        }

        var addresses = new Dictionary<string, string>(StringComparer.Ordinal);
        var networks = Child(settings, "Networks");

        if (networks.ValueKind == JsonValueKind.Object)
        {
            foreach (var network in networks.EnumerateObject())
            {
                // Attached but not running is a network with no address yet.
                addresses[network.Name] = Text(network.Value, "IPAddress") ?? "";
            }
        }

        return new ContainerInspect(
            Text(root, "Id") ?? "",
            (Text(root, "Name") ?? "").TrimStart('/'),
            Text(config, "Image") ?? Text(root, "Image") ?? "",
            status,
            running,
            exitCode,
            StringMap(Child(config, "Labels")),
            ports,
            mounts,
            addresses);
    }

    /// <summary>One row of <c>GET /containers/json</c>.</summary>
    public static ContainerSummary Summary(JsonElement row) =>
        new(
            Text(row, "Id") ?? "",
            [.. Items(Child(row, "Names")).Select(n => (n.GetString() ?? "").TrimStart('/'))],
            Text(row, "Image") ?? "",
            Text(row, "State") ?? "",
            StringMap(Child(row, "Labels")));

    public static NetworkSummary Network(JsonElement row) =>
        new(Text(row, "Id") ?? "", Text(row, "Name") ?? "", StringMap(Child(row, "Labels")));

    public static VolumeSummary Volume(JsonElement row) =>
        new(Text(row, "Name") ?? "", StringMap(Child(row, "Labels")));

    /// <summary><c>GET /images/{ref}/json</c>: the labels are the image's config's, and the date is a date.</summary>
    public static ImageInspect Image(JsonElement root) =>
        new(
            Text(root, "Id") ?? "",
            [.. Items(Child(root, "RepoTags")).Select(t => t.GetString() ?? "")],
            StringMap(Child(Child(root, "Config"), "Labels")))
        {
            Created = DateTimeOffset.TryParse(Text(root, "Created"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var created)
                ? created
                : null,
        };

    /// <summary>One row of <c>GET /images/json</c>: the same image, with its labels at the top and its date in seconds.</summary>
    public static ImageInspect ImageRow(JsonElement row) =>
        new(
            Text(row, "Id") ?? "",
            [.. Items(Child(row, "RepoTags")).Select(t => t.GetString() ?? "")],
            StringMap(Child(row, "Labels")))
        {
            Created = Child(row, "Created") is { ValueKind: JsonValueKind.Number } seconds && seconds.TryGetInt64(out var unix)
                ? DateTimeOffset.FromUnixTimeSeconds(unix)
                : null,
        };

    public static ExecInspect Exec(JsonElement root)
    {
        var running = Flag(root, "Running");

        return new ExecInspect(running, running ? null : Number(root, "ExitCode"), Number(root, "Pid") ?? 0);
    }

    public static EngineVersion Version(JsonElement root)
    {
        string? platform = null;

        if (Child(root, "Platform") is { ValueKind: JsonValueKind.Object } p)
        {
            platform = Text(p, "Name") is { Length: > 0 } name ? name : null;
        }

        return new EngineVersion(
            Text(root, "Version") ?? "unknown",
            Text(root, "ApiVersion") ?? "",
            Text(root, "Os") ?? "",
            Text(root, "Arch") ?? "",
            platform);
    }

    /// <summary>
    /// The engine's sentence out of an error body: <c>{"message": "…"}</c>.
    /// </summary>
    /// <returns>The message, or the body itself trimmed when it is not that shape, or null when there is none.</returns>
    public static string? ErrorMessage(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(body);

            if (document.RootElement.ValueKind == JsonValueKind.Object &&
                Text(document.RootElement, "message") is { Length: > 0 } message)
            {
                return message.Trim();
            }
        }
        catch (JsonException)
        {
            // Not JSON: a proxy's page, or an engine old enough to answer in text.
        }

        var line = body.ReplaceLineEndings(" ").Trim();
        return line.Length > 300 ? line[..300] + "…" : line;
    }

    /// <summary>
    /// <c>repo</c> and <c>tag</c> out of a reference, as <c>POST /images/create</c> wants them.
    /// </summary>
    /// <remarks>
    /// A reference with no tag means <c>latest</c>, and it has to be said: the
    /// engine reads a missing tag as "every tag there is" and pulls them all.
    /// A digest goes in the tag's place, <c>sha256:</c> and all.
    /// </remarks>
    public static (string Repository, string Tag) SplitReference(string reference)
    {
        var at = reference.IndexOf('@', StringComparison.Ordinal);

        if (at >= 0)
        {
            return (reference[..at], reference[(at + 1)..]);
        }

        // A colon is a tag only after the last slash; before it, it is a registry's port.
        var colon = reference.LastIndexOf(':');

        return colon > reference.LastIndexOf('/')
            ? (reference[..colon], reference[(colon + 1)..])
            : (reference, "latest");
    }

    // Reading, tolerant of absence: a field this does not find is a default,
    // never a throw, because every one of these is a partial view of something
    // a newer engine is free to reshape.

    public static JsonElement Child(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var child) ? child : default;

    public static string? Text(JsonElement parent, string name) =>
        Child(parent, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    public static IEnumerable<JsonElement> Items(JsonElement array) =>
        array.ValueKind == JsonValueKind.Array ? array.EnumerateArray() : [];

    private static bool Flag(JsonElement parent, string name, bool whenMissing = false) =>
        Child(parent, name).ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => whenMissing,
        };

    private static int? Number(JsonElement parent, string name) =>
        Child(parent, name) is { ValueKind: JsonValueKind.Number } value && value.TryGetInt32(out var number)
            ? number
            : null;

    private static Dictionary<string, string> StringMap(JsonElement map)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);

        if (map.ValueKind == JsonValueKind.Object)
        {
            foreach (var pair in map.EnumerateObject())
            {
                result[pair.Name] = pair.Value.ValueKind == JsonValueKind.String ? pair.Value.GetString() ?? "" : "";
            }
        }

        return result;
    }

    /// <summary><c>{"5173/tcp": [{"HostIp": "127.3.7.1", "HostPort": "5173"}], "22/tcp": null}</c>.</summary>
    private static List<PortBinding> Ports(JsonElement map)
    {
        var result = new List<PortBinding>();

        if (map.ValueKind != JsonValueKind.Object)
        {
            return result;
        }

        foreach (var entry in map.EnumerateObject())
        {
            // Exposed and not published is a key with null under it.
            if (entry.Value.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            var slash = entry.Name.IndexOf('/', StringComparison.Ordinal);
            var protocol = slash < 0 ? "tcp" : entry.Name[(slash + 1)..];

            if (!int.TryParse(slash < 0 ? entry.Name : entry.Name[..slash], NumberStyles.None, CultureInfo.InvariantCulture, out var containerPort))
            {
                continue;
            }

            foreach (var binding in entry.Value.EnumerateArray())
            {
                if (int.TryParse(Text(binding, "HostPort"), NumberStyles.None, CultureInfo.InvariantCulture, out var hostPort))
                {
                    result.Add(new PortBinding(containerPort, Text(binding, "HostIp") ?? "", hostPort, protocol));
                }
            }
        }

        // The engine lists bindings in whatever order its map gave them, and
        // not the same order twice. Sorted, two readings of one container are equal.
        result.Sort((a, b) =>
            a.ContainerPort != b.ContainerPort ? a.ContainerPort.CompareTo(b.ContainerPort)
            : !a.HostIp.Equals(b.HostIp, StringComparison.Ordinal) ? string.CompareOrdinal(a.HostIp, b.HostIp)
            : a.HostPort.CompareTo(b.HostPort));

        return result;
    }

    private static string PortKey(int port, string protocol) =>
        $"{port.ToString(CultureInfo.InvariantCulture)}/{(protocol.Length == 0 ? "tcp" : protocol)}";

    private static JsonArray Strings(IEnumerable<string> values)
    {
        var array = new JsonArray();

        foreach (var value in values)
        {
            array.Add((JsonNode?)JsonValue.Create(value));
        }

        return array;
    }

    private static JsonObject Map(IReadOnlyDictionary<string, string> values)
    {
        var map = new JsonObject();

        foreach (var pair in values)
        {
            map[pair.Key] = pair.Value;
        }

        return map;
    }

    private static void AddIfSet(JsonObject body, string name, string? value)
    {
        if (!string.IsNullOrEmpty(value))
        {
            body[name] = value;
        }
    }
}
