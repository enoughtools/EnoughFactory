using System.Formats.Tar;
using System.Runtime.InteropServices;

namespace Envmux.Backends.DockerEngine;

/// <summary>
/// A file as the one entry of a tar, which is how a file crosses into a container.
/// </summary>
/// <remarks>
/// What <c>docker cp</c> does: the engine's archive endpoint takes a tar and
/// unpacks it, and there is no other files API. The entry is rooted so that
/// extracting at <c>/</c> lands the file where it was asked for, and the engine
/// applies the mode and owner as written, so the mode the caller asked for is
/// the mode on disk. Backend-neutral on purpose: a Kubernetes backend sends the
/// same one-entry archive down an exec to <c>tar -xf -</c>.
/// </remarks>
internal static class TarEntry
{
    /// <summary>
    /// The entry for one file.
    /// </summary>
    /// <remarks>
    /// The bytes are wrapped, not copied: a <see cref="MemoryStream"/> over the
    /// array the memory already is. A bundle of tens of megabytes goes to the
    /// engine from where it was read, and nowhere else.
    /// </remarks>
    /// <param name="path">Absolute, inside the container.</param>
    /// <param name="mode">Octal, as the seam spells it: <c>0644</c>.</param>
    public static PaxTarEntry File(string path, ReadOnlyMemory<byte> content, string mode)
    {
        var data = MemoryMarshal.TryGetArray(content, out var segment)
            ? new MemoryStream(segment.Array!, segment.Offset, segment.Count, writable: false)
            : new MemoryStream(content.ToArray(), writable: false);

        return new PaxTarEntry(TarEntryType.RegularFile, path.TrimStart('/'))
        {
            DataStream = data,
            Mode = Mode(mode),
            ModificationTime = DateTimeOffset.UtcNow,
            Uid = 0,
            Gid = 0,
        };
    }

    /// <summary>An octal mode string — <c>0644</c> — as the flags tar writes. Anything else is <c>0644</c>.</summary>
    public static UnixFileMode Mode(string octal)
    {
        var trimmed = octal.Trim();

        return trimmed.Length > 0 && trimmed.All(char.IsAsciiDigit) && trimmed.All(c => c < '8')
            ? (UnixFileMode)Convert.ToInt32(trimmed, 8)
            : UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;
    }
}
