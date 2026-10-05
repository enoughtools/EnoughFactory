using System.Text.Json;

namespace Envmux.Host.Windows;

/// <summary>A Hyper-V virtual switch, as far as this needs to know.</summary>
/// <param name="Name">What it is called, and what a VM names to join it.</param>
/// <param name="Kind">"External", "Internal" or "Private".</param>
/// <param name="Adapter">The physical adapter it is bound to, when it is external.</param>
internal sealed record VirtualSwitch(string Name, string Kind, string Adapter)
{
    public bool IsExternal => Kind.Equals("External", StringComparison.OrdinalIgnoreCase);

    public override string ToString() =>
        IsExternal && Adapter.Length > 0 ? $"{Name}  ({Kind}, on {Adapter})" : $"{Name}  ({Kind})";
}

/// <summary>A physical adapter a switch could be bound to.</summary>
/// <param name="Name">Its Windows name — "Ethernet", "Wi-Fi".</param>
/// <param name="Description">The hardware, which is how you tell two "Ethernet 2"s apart.</param>
/// <param name="Speed">Link speed, for choosing between a dock and a laptop's own port.</param>
internal sealed record NetAdapter(string Name, string Description, string Speed)
{
    public override string ToString() =>
        Speed.Length > 0 ? $"{Name}  —  {Description} ({Speed})" : $"{Name}  —  {Description}";
}

/// <summary>
/// The switch the VM sits on, which has to be an external one.
/// </summary>
/// <remarks>
/// <para>
/// Not a preference. Windows routes the session range to the VM's own address,
/// and only an external switch gives it one on a network Windows can route to.
/// An internal switch would put it on a host-only network with a different
/// address in a different range, and the static route would have nowhere to
/// point.
/// </para>
/// <para>
/// Creating one briefly interrupts the adapter it binds — Windows rebuilds the
/// stack around the new virtual switch — which is worth saying out loud before
/// it happens to somebody on a video call.
/// </para>
/// </remarks>
internal static class HyperVSwitch
{
    /// <summary>Every virtual switch on this machine.</summary>
    public static async Task<IReadOnlyList<VirtualSwitch>> ListAsync(CancellationToken ct = default)
    {
        var json = await Powershell.JsonAsync(
            """
            ConvertTo-Json -Compress -Depth 4 -InputObject @(
              Get-VMSwitch -ErrorAction SilentlyContinue | ForEach-Object {
                [pscustomobject]@{
                  name    = $_.Name
                  kind    = [string]$_.SwitchType
                  adapter = [string]$_.NetAdapterInterfaceDescription
                }
              })
            """,
            ct: ct).ConfigureAwait(false);

        return Read(json, e => new VirtualSwitch(
            Text(e, "name"), Text(e, "kind"), Text(e, "adapter")));
    }

    /// <summary>
    /// The adapters a switch could be bound to: up, physical, and not already one.
    /// </summary>
    /// <remarks>
    /// An adapter that is already backing a virtual switch appears as a
    /// <c>vEthernet</c> one, and binding a second switch to it fails in a way
    /// that reads as Hyper-V being broken. They are filtered here rather than
    /// explained later.
    /// </remarks>
    public static async Task<IReadOnlyList<NetAdapter>> AdaptersAsync(CancellationToken ct = default)
    {
        var json = await Powershell.JsonAsync(
            """
            ConvertTo-Json -Compress -Depth 4 -InputObject @(
              Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
              Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notlike '*Hyper-V*' } |
              ForEach-Object {
                [pscustomobject]@{
                  name        = $_.Name
                  description = $_.InterfaceDescription
                  speed       = [string]$_.LinkSpeed
                }
              })
            """,
            ct: ct).ConfigureAwait(false);

        return Read(json, e => new NetAdapter(
            Text(e, "name"), Text(e, "description"), Text(e, "speed")));
    }

    /// <summary>
    /// Create an external switch on an adapter.
    /// </summary>
    /// <remarks>
    /// <c>-AllowManagementOS</c>, always. Without it Windows loses its own
    /// address on that adapter to the switch, which on the machine you are
    /// sitting at means the network goes away and does not come back.
    /// </remarks>
    public static async Task CreateAsync(string name, NetAdapter adapter, CancellationToken ct = default)
    {
        await Powershell.CheckedAsync(
            """
            New-VMSwitch -Name $Name -NetAdapterName $Adapter -AllowManagementOS $true | Out-Null
            """,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["Name"] = name,
                ["Adapter"] = adapter.Name,
            },
            ct).ConfigureAwait(false);
    }

    /// <summary>The switch by that name, or null if there is none.</summary>
    public static async Task<VirtualSwitch?> FindAsync(string name, CancellationToken ct = default) =>
        (await ListAsync(ct).ConfigureAwait(false))
        .FirstOrDefault(s => s.Name.Equals(name, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Read a list that PowerShell may or may not have decided is a list.
    /// </summary>
    /// <remarks>
    /// <c>ConvertTo-Json</c> unrolls a pipeline, so one result arrives as a bare
    /// object and none arrives as nothing at all. <c>-InputObject</c> is what
    /// stops that — it serialises the array as an array — and it is used above,
    /// so the array case is the one that happens. The other two are still
    /// handled, because being wrong here is a switch that exists and is reported
    /// as missing.
    /// </remarks>
    private static IReadOnlyList<T> Read<T>(JsonElement json, Func<JsonElement, T> read) =>
        json.ValueKind switch
        {
            JsonValueKind.Array => [.. json.EnumerateArray().Select(read)],
            JsonValueKind.Object => [read(json)],
            _ => [],
        };

    private static string Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";
}
