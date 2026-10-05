using Envmux.Incus;

namespace Envmux.Host;

/// <summary>
/// The one thing still known about <c>envmux-util</c>: how to remove it.
/// </summary>
/// <remarks>
/// <para>
/// An older envmux put a small instance called <c>envmux-util</c> on the
/// bridge of an Incus it attached to, to answer the zone for the workstation's
/// NRPT rule. The workstation resolves nothing now — a session is reached
/// through its browser proxy and its ssh alias, both over the host's API — so
/// nothing makes that instance any more, and <c>archive/zone/</c> holds what
/// did. A host set up by that version still has one, sitting on the network
/// with a pinned address and turning the network's delete into an in-use error,
/// and <c>host reset</c> and <c>host range</c> are where it is met.
/// </para>
/// <para>
/// Only the one envmux made, told by the label it was created with. An instance
/// of that name without the label is somebody's, and is left alone.
/// </para>
/// </remarks>
internal static class LegacyUtility
{
    public const string InstanceName = "envmux-util";

    /// <summary>The label the retired code wrote on the instance it created.</summary>
    private const string Label = "user.envmux.utility";

    /// <summary>Remove a leftover <c>envmux-util</c>, when there is one and it is envmux's.</summary>
    /// <returns>True if one was removed; false when there was nothing of envmux's by that name.</returns>
    public static async Task<bool> RemoveAsync(IncusApi api, CancellationToken ct)
    {
        if (await api.InstanceAsync(InstanceName, ct).ConfigureAwait(false) is not { } instance ||
            !instance.Config.ContainsKey(Label))
        {
            return false;
        }

        // Not worth a graceful shutdown: it holds nothing.
        await api.StopAsync(InstanceName, 5, ct).ConfigureAwait(false);

        return await api.DeleteAsync(InstanceName, ct).ConfigureAwait(false);
    }
}
