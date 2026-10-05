using System.Formats.Tar;
using System.Security.Cryptography;
using System.Text;

namespace Envmux.Backends.DockerEngine;

/// <summary>One file of the golden image's build context.</summary>
/// <param name="Name">Its path in the context, forward slashes, no leading one: <c>Dockerfile</c>.</param>
/// <param name="Content">Its bytes, with line endings already made LF.</param>
internal sealed record GoldenFile(string Name, byte[] Content)
{
    /// <summary>
    /// Whether it goes into the context executable.
    /// </summary>
    /// <remarks>
    /// Read off the file rather than kept in a list beside it: a script says it
    /// is one on its first line, and an embedded resource has no mode to ask.
    /// The Dockerfile sets the mode of what it copies as well, because a person
    /// building the same directory by hand from a Windows checkout has no bit
    /// to keep either.
    /// </remarks>
    public bool Executable => Content.AsSpan().StartsWith("#!"u8);
}

/// <summary>
/// The golden image's build context — <c>images/golden</c> — as the binary carries it.
/// </summary>
/// <remarks>
/// <para>
/// A Docker engine builds an image from a tar with a <c>Dockerfile</c> at its
/// root. The files are embedded in the envmux assembly (see the csproj, which
/// says why) so an installed envmux can build the golden image with no checkout
/// anywhere near it, and the tar is made in memory because it is a few
/// kilobytes and there is nothing to gain from a temporary directory that then
/// has to be cleaned up.
/// </para>
/// <para>
/// <see cref="Build"/> is a hash of exactly what goes into that tar. It is the
/// image's tag, which is how the golden image is invalidated here: on Incus a
/// person rebuilds golden when they decide to, and on a Docker engine editing
/// the Dockerfile produces a name the engine does not have, so the next
/// <see cref="DockerImages.HasGoldenAsync"/> says no and the rebuild is not a thing
/// anybody has to remember. The image under the old name is garbage by then,
/// and says which build it was in a label so <c>envmux prune</c> can find it.
/// </para>
/// </remarks>
internal static class GoldenContext
{
    /// <summary>What the csproj puts in front of each file's name.</summary>
    internal const string ResourcePrefix = "Envmux.Golden/";

    /// <summary>
    /// Mixed into <see cref="Build"/>, and moved when the way the image is built
    /// changes without any file changing: the builder, the tar's shape, what a
    /// label means.
    /// </summary>
    private const string Recipe = "envmux-golden/1";

    private static readonly Lazy<IReadOnlyList<GoldenFile>> Embedded = new(() => Read());

    private static readonly Lazy<string> EmbeddedBuild = new(() => BuildOf(Embedded.Value));

    /// <summary>The files, in the order they are hashed and written.</summary>
    /// <exception cref="BackendException">This binary was built without them.</exception>
    public static IReadOnlyList<GoldenFile> Files => Embedded.Value;

    /// <summary>The build this binary's golden image is: twelve hex characters.</summary>
    public static string Build => EmbeddedBuild.Value;

    /// <summary>
    /// The build a set of files makes.
    /// </summary>
    /// <remarks>
    /// Over names and content both, so a file renamed is a different image, and
    /// length-free because each part ends in a newline a name cannot contain and
    /// a hex digest does not. Twelve characters: it is read by people in
    /// <c>docker images</c>, and it only has to tell this machine's few golden
    /// builds apart.
    /// </remarks>
    internal static string BuildOf(IReadOnlyList<GoldenFile> files)
    {
        var text = new StringBuilder();
        text.Append(Recipe).Append('\n');

        foreach (var file in files.OrderBy(f => f.Name, StringComparer.Ordinal))
        {
            text.Append(file.Name).Append('\n');
            text.Append(Convert.ToHexStringLower(SHA256.HashData(file.Content))).Append('\n');
        }

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString())))[..12];
    }

    /// <summary>
    /// The context as the tar the engine's build endpoint takes.
    /// </summary>
    /// <remarks>
    /// Deterministic — fixed times, fixed owner, a fixed order — for the reason
    /// the seed archive is: the same files are the same bytes. It matters more
    /// here, because the classic builder's cache for a <c>COPY</c> is keyed on
    /// the file's content <em>and</em> its metadata, and a context stamped with
    /// the time it was made would miss that cache on every build.
    /// </remarks>
    public static byte[] Tar(IReadOnlyList<GoldenFile> files)
    {
        using var buffer = new MemoryStream();

        using (var writer = new TarWriter(buffer, TarEntryFormat.Ustar, leaveOpen: true))
        {
            foreach (var file in files.OrderBy(f => f.Name, StringComparer.Ordinal))
            {
                var mode = UnixFileMode.UserRead | UnixFileMode.UserWrite |
                           UnixFileMode.GroupRead | UnixFileMode.OtherRead;

                if (file.Executable)
                {
                    mode |= UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute;
                }

                writer.WriteEntry(new UstarTarEntry(TarEntryType.RegularFile, file.Name)
                {
                    DataStream = new MemoryStream(file.Content),
                    Mode = mode,
                    ModificationTime = DateTimeOffset.UnixEpoch,
                });
            }
        }

        return buffer.ToArray();
    }

    /// <summary>
    /// A file as it goes into the context: its name with forward slashes, its
    /// line endings LF.
    /// </summary>
    /// <remarks>
    /// The files are embedded from whatever checkout built this binary, and a
    /// checkout on Windows may have turned every line ending into CRLF. Inside
    /// the image that is <c>#!/bin/sh\r</c>, which the kernel reports as "no such
    /// file or directory" about a file that is plainly there — and it would make
    /// the same source two different builds depending on who compiled it. A file
    /// with a NUL in it is not text and is left alone.
    /// </remarks>
    internal static GoldenFile Normalise(string name, byte[] content)
    {
        name = name.Replace('\\', '/').TrimStart('/');

        if (content.AsSpan().Contains((byte)0) || !content.AsSpan().Contains((byte)'\r'))
        {
            return new GoldenFile(name, content);
        }

        var unix = new List<byte>(content.Length);

        for (var i = 0; i < content.Length; i++)
        {
            if (content[i] == (byte)'\r' && i + 1 < content.Length && content[i + 1] == (byte)'\n')
            {
                continue;
            }

            unix.Add(content[i]);
        }

        return new GoldenFile(name, [.. unix]);
    }

    private static List<GoldenFile> Read()
    {
        var assembly = typeof(GoldenContext).Assembly;
        var files = new List<GoldenFile>();

        foreach (var resource in assembly.GetManifestResourceNames()
                     .Where(n => n.StartsWith(ResourcePrefix, StringComparison.Ordinal))
                     .OrderBy(n => n, StringComparer.Ordinal))
        {
            using var stream = assembly.GetManifestResourceStream(resource)!;
            using var bytes = new MemoryStream();
            stream.CopyTo(bytes);

            files.Add(Normalise(resource[ResourcePrefix.Length..], bytes.ToArray()));
        }

        if (!files.Any(f => string.Equals(f.Name, "Dockerfile", StringComparison.Ordinal)))
        {
            // Not reachable from a build of this repository. Said anyway, in
            // words, because the alternative is the engine's "Cannot locate
            // specified Dockerfile" about a tar nobody can look inside.
            throw new BackendException(
                "this build of envmux does not carry the golden image's Dockerfile (images/golden), so it cannot " +
                "build one. Name a published golden image in the backend's docker block as \"goldenTag\" instead.");
        }

        return files;
    }
}
