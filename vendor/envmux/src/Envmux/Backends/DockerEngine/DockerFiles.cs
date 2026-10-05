using System.Formats.Tar;

namespace Envmux.Backends.DockerEngine;

/// <summary>
/// Files in and out of a container through the engine's archive endpoints,
/// which take and give a tar.
/// </summary>
/// <remarks>
/// <para>
/// What <c>docker cp</c> does, done directly. The engine unpacks the archive,
/// so it works on a container that is stopped and needs no <c>tar</c> in the
/// image. Plain methods; the seam's <c>IFiles</c> adapter will wrap them.
/// </para>
/// <para>
/// <b>Always unpacked at <c>/</c>, with the whole path in the entry.</b> The
/// endpoint refuses a directory that does not exist, and a file is often pushed
/// to one that does not yet. The root always exists, and the engine makes
/// whatever directories an entry's path is missing on the way to it. The other
/// way to get them made — directory entries in the archive — is the wrong one:
/// an entry for a directory that is already there is applied to it, so pushing
/// <c>/home/matt/.config/x</c> would hand <c>/home/matt</c> to root.
/// </para>
/// <para>
/// A file arrives owned by root with the mode asked for, as it does on Incus;
/// every caller that wants it to be somebody's says so afterwards, with an exec
/// that would have to happen anyway.
/// </para>
/// </remarks>
internal sealed class DockerFiles(IDockerEngine engine)
{
    /// <summary>How many links a pull follows before deciding it is going in circles.</summary>
    private const int MaxLinks = 8;

    /// <summary>Write one file into the container.</summary>
    /// <param name="path">Absolute; the directories on the way are made.</param>
    /// <param name="mode">Octal, <c>0644</c> unless said.</param>
    /// <exception cref="BackendException">Not a file's absolute path, or the engine refused.</exception>
    public async Task PushAsync(
        string container,
        string path,
        ReadOnlyMemory<byte> content,
        string mode = "0644",
        CancellationToken ct = default)
    {
        if (path.Length == 0 || path[0] != '/' || path[^1] == '/')
        {
            throw new BackendException($"'{path}' is not the absolute path of a file, so it cannot be written into {container}");
        }

        // Held whole: the archive endpoint wants a body it can read once from
        // start to finish, and a tar's header is written before its data, so
        // there is nothing to gain from a pipe but a second thread.
        using var archive = new MemoryStream(content.Length + 2048);

        await using (var writer = new TarWriter(archive, TarEntryFormat.Pax, leaveOpen: true))
        {
            await writer.WriteEntryAsync(TarEntry.File(path, content, mode), ct).ConfigureAwait(false);
        }

        archive.Position = 0;

        try
        {
            await engine.PutArchiveAsync(container, "/", archive, ct).ConfigureAwait(false);
        }
        catch (DockerEngineException e)
        {
            throw new BackendException($"could not write {path} into {container}: {e.Message}", e);
        }
    }

    /// <summary>The file's bytes, or null when there is no such path.</summary>
    /// <remarks>
    /// The archive of a file is one entry, and its data is the file. The archive
    /// of a link is the link, not what it points at — so a link is followed, the
    /// way <c>cat</c> would, because a caller asking for a path wants what
    /// reading that path gives.
    /// </remarks>
    /// <exception cref="BackendException">A directory, something that is not a file, a circle of links, or the engine refused.</exception>
    public async Task<byte[]?> PullAsync(string container, string path, CancellationToken ct = default)
    {
        var asked = path;

        for (var hop = 0; hop <= MaxLinks; hop++)
        {
            Stream? stream;

            try
            {
                stream = await engine.GetArchiveAsync(container, path, ct).ConfigureAwait(false);
            }
            catch (DockerEngineException e)
            {
                throw new BackendException($"could not read {asked} from {container}: {e.Message}", e);
            }

            if (stream is null)
            {
                return null;
            }

            await using (stream.ConfigureAwait(false))
            {
                await using var reader = new TarReader(stream, leaveOpen: true);

                if (await reader.GetNextEntryAsync(copyData: false, ct).ConfigureAwait(false) is not { } entry)
                {
                    return null;
                }

                switch (entry.EntryType)
                {
                    case TarEntryType.RegularFile or TarEntryType.V7RegularFile or TarEntryType.ContiguousFile:
                        if (entry.DataStream is not { } data)
                        {
                            return [];
                        }

                        using (var bytes = new MemoryStream(entry.Length > 0 && entry.Length < int.MaxValue ? (int)entry.Length : 0))
                        {
                            await data.CopyToAsync(bytes, ct).ConfigureAwait(false);
                            return bytes.ToArray();
                        }

                    case TarEntryType.SymbolicLink when entry.LinkName.Length > 0:
                        path = Resolve(path, entry.LinkName);
                        continue;

                    case TarEntryType.Directory:
                        throw new BackendException($"{asked} in {container} is a directory, and a pull reads one file");

                    default:
                        throw new BackendException(
                            $"{asked} in {container} is not a file that can be read ({entry.EntryType})");
                }
            }
        }

        throw new BackendException($"{asked} in {container} is a link that leads through more than {MaxLinks} others");
    }

    /// <summary>Where a link found at <paramref name="at"/> points, as an absolute path.</summary>
    internal static string Resolve(string at, string target)
    {
        if (target.StartsWith('/'))
        {
            return target;
        }

        var parts = new List<string>(at.Split('/', StringSplitOptions.RemoveEmptyEntries));

        // The link's own name goes; what it names is beside it.
        if (parts.Count > 0)
        {
            parts.RemoveAt(parts.Count - 1);
        }

        foreach (var part in target.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (part.Equals("..", StringComparison.Ordinal))
            {
                if (parts.Count > 0)
                {
                    parts.RemoveAt(parts.Count - 1);
                }
            }
            else if (!part.Equals(".", StringComparison.Ordinal))
            {
                parts.Add(part);
            }
        }

        return "/" + string.Join('/', parts);
    }
}
