namespace Envmux.Tests.EndToEnd;

/// <summary>A place a real session is started for the end-to-end tests.</summary>
/// <param name="Name">What the run is called: <c>incus-remote</c>, <c>incus-hyperv</c>, <c>docker</c>.</param>
/// <param name="Backend">What <c>--backend</c> gets: <c>incus</c> or <c>docker</c>, from the name's first word.</param>
/// <param name="Home">
/// The <c>ENVMUX_HOME</c> the session is started with, for an Incus host other
/// than the one <c>~/.envmux</c> names; null for the default.
/// </param>
public sealed record Target(string Name, string Backend, string? Home)
{
    public override string ToString() => Name;
}

/// <summary>
/// Which targets to run, from <c>ENVMUX_E2E</c>.
/// </summary>
/// <remarks>
/// <para>
/// Opt-in, always. These tests create instances on a real host and a real
/// engine, install Node in them and leave nothing behind only if they finish;
/// nothing that a plain <c>dotnet test</c> should ever do on somebody's
/// workstation. Unset, every case skips and says how to turn it on.
/// </para>
/// <para>
/// Written as <c>name[=home]</c> entries separated by <c>;</c>:
/// <c>incus-remote;incus-hyperv=D:\envmux-hyperv;docker</c>. The name's first word
/// is the backend. A home points the session at another Incus host's
/// <c>host.json</c> and certificate without touching the default one — which is
/// how an Incus VM and an Incus remote are both tested from one machine.
/// </para>
/// </remarks>
public static class Targets
{
    public const string Variable = "ENVMUX_E2E";

    public static IReadOnlyList<Target> Parse(string? value) =>
        [.. (value ?? "")
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(entry =>
            {
                var equals = entry.IndexOf('=', StringComparison.Ordinal);
                var name = equals < 0 ? entry : entry[..equals].Trim();
                var home = equals < 0 ? null : entry[(equals + 1)..].Trim();
                var backend = name.Split('-')[0].ToLowerInvariant();

                return new Target(name, backend, string.IsNullOrEmpty(home) ? null : home);
            })];

    /// <summary>
    /// The configured targets as theory data — or one placeholder, so a run with
    /// nothing configured reports a skip rather than a theory with no data.
    /// </summary>
    public static TheoryData<string> Names()
    {
        var data = new TheoryData<string>();
        var targets = Parse(Environment.GetEnvironmentVariable(Variable));

        foreach (var target in targets)
        {
            data.Add(target.Name);
        }

        if (targets.Count == 0)
        {
            data.Add(Unset);
        }

        return data;
    }

    /// <summary>The placeholder case for a run with nothing configured.</summary>
    public const string Unset = "(none)";

    public static Target? Find(string name) =>
        Parse(Environment.GetEnvironmentVariable(Variable)).FirstOrDefault(t => t.Name == name);
}
