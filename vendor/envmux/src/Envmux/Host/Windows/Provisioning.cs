namespace Envmux.Host.Windows;

/// <summary>
/// Whether this machine can build a host, and what is missing if not.
/// </summary>
/// <remarks>
/// <para>
/// This namespace is the whole of envmux's Windows-specific surface, and it is
/// separated so that a second platform is a folder rather than an excavation.
/// Everything outside it — <see cref="HostConfig"/>, <see cref="Seed"/>,
/// <see cref="ClientCertificate"/>, <see cref="DiskImage"/>,
/// <see cref="IncusOsIndex"/>, and the entire Incus client — describes a host
/// and talks to one, and none of it knows how the host was made.
/// </para>
/// <para>
/// What a second platform would have to supply, and nothing else:
/// </para>
/// <list type="number">
/// <item><b>A VM with a fixed MAC, a real TPM and Secure Boot off</b>, booting a
/// disk. <see cref="HyperV"/> does this; libvirt, UTM and Multipass all can.</item>
/// <item><b>A network the guest is on and the workstation can reach its API on.</b>
/// <see cref="HyperVSwitch"/> does this — external, so the VM has an address on
/// the LAN and a way out to pull images.</item>
/// <item><b>A raw image in whatever the hypervisor boots.</b>
/// <see cref="VhdFooter"/> exists only because Hyper-V wants VHDX and qemu-img
/// is not on a Windows workstation; a platform with qemu-img needs none of it,
/// and one that boots raw images needs less than that.</item>
/// </list>
/// <para>
/// There used to be a fourth — a persistent route and a resolver policy, so the
/// workstation reached the range by name — and it is gone: a session is reached
/// through its browser proxy and its ssh alias, both over the host's API. What
/// is left of it is <see cref="WindowsNetwork"/> taking an older version's
/// wiring back off.
/// </para>
/// <para>
/// No interface is declared for any of that, deliberately. There is one
/// implementation and no second platform to check a guess against, and an
/// abstraction shaped around a single case is usually shaped wrongly. The list
/// above is the contract until something needs to satisfy it twice.
/// </para>
/// </remarks>
internal static class Provisioning
{
    /// <summary>
    /// Everything stopping this machine from building a host, in the order it is
    /// worth fixing.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Checked together and up front, because they fail at different points in a
    /// long process: not being elevated is discovered by <c>Convert-VHD</c>
    /// after several gigabytes have been copied, and not having Hyper-V is
    /// discovered after an image has been downloaded.
    /// </para>
    /// <para>
    /// Only Hyper-V has requirements. Attaching to an Incus that already exists
    /// talks to its API and nothing else on this machine — the elevation it
    /// once needed was for the route and the NRPT rule, and those are gone — so
    /// for that provider this has nothing to say.
    /// </para>
    /// </remarks>
    /// <param name="needsHyperV">Whether the chosen provider builds a Hyper-V VM.</param>
    /// <param name="ct">Cancellation.</param>
    public static async Task<IReadOnlyList<string>> ProblemsAsync(
        bool needsHyperV = true,
        CancellationToken ct = default)
    {
        var problems = new List<string>();

        if (!needsHyperV)
        {
            return problems;
        }

        if (!OperatingSystem.IsWindows())
        {
            problems.Add(
                "envmux can only build a Hyper-V host from Windows. A daemon elsewhere is reachable from " +
                "here: `envmux install --provider incus` attaches to it and builds nothing.");

            return problems;
        }

        if (!await Powershell.HasCommandAsync("New-VM", ct).ConfigureAwait(false))
        {
            problems.Add(
                "the Hyper-V PowerShell module is not here. Enable the feature and reboot: " +
                "Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All");
        }

        if (!await Powershell.IsElevatedAsync(ct).ConfigureAwait(false))
        {
            problems.Add(
                "this is not an elevated prompt. Creating a VM and converting a disk need one — " +
                "start an Administrator terminal and run this again.");
        }

        return problems;
    }
}
