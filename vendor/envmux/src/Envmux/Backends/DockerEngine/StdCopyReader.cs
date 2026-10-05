using System.Buffers;
using System.Buffers.Binary;
using System.Runtime.CompilerServices;

using Envmux.Docker;

namespace Envmux.Backends.DockerEngine;

/// <summary>
/// The reading half of <see cref="StdCopy"/>: what an exec without a terminal sends back.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="IDockerEngine.ExecStartAsync"/> with <c>tty: false</c> returns
/// the hijacked connection as the engine wrote it — stdout and stderr in one
/// stream, each chunk behind an eight-byte header: the stream's number, three
/// zeros, the payload's length big-endian. This takes it apart again.
/// <see cref="StdCopy"/> is the writer of the same framing, for the shim that
/// plays the engine to VS Code; the constants are shared so the two cannot
/// drift.
/// </para>
/// <para>
/// With a terminal there is no framing at all, and this must not be used: the
/// first eight bytes of a prompt read as a header asking for a payload of a
/// few hundred megabytes.
/// </para>
/// <para>
/// A stream that ends inside a frame is an engine that went away mid-sentence.
/// What arrived is delivered and the stream simply ends: the exec's exit code,
/// or the lack of one, is where that failure is reported.
/// </para>
/// </remarks>
internal static class StdCopyReader
{
    /// <summary>A frame claiming more than this is not a frame; it is unframed output being misread.</summary>
    private const int LargestFrame = 16 * 1024 * 1024;

    /// <summary>
    /// Read one frame's header, and nothing of its payload.
    /// </summary>
    /// <remarks>
    /// For a reader that wants the payload in its own buffer rather than a
    /// copy — <c>EngineRelay</c>, which hands a browser's bytes straight
    /// through. The header never over-reads, so the payload starts exactly
    /// where the stream is left; the caller reads that many bytes and asks
    /// again.
    /// </remarks>
    /// <param name="header">Scratch for the eight bytes, the caller's so a loop allocates nothing.</param>
    /// <returns>Which stream and how long its payload is, or null when the connection ended between frames.</returns>
    /// <exception cref="DockerEngineException">The bytes are not stdcopy framing — almost certainly a tty exec's output.</exception>
    public static async ValueTask<(byte Stream, int Length)?> ReadHeaderAsync(
        Stream framed,
        Memory<byte> header,
        CancellationToken ct = default)
    {
        header = header[..StdCopy.HeaderLength];

        if (!await FillAsync(framed, header, ct).ConfigureAwait(false))
        {
            return null;
        }

        var stream = header.Span[0];
        var length = BinaryPrimitives.ReadUInt32BigEndian(header.Span[4..8]);

        if (stream > StdCopy.Stderr + 1 || header.Span[1] != 0 || header.Span[2] != 0 || header.Span[3] != 0 || length > LargestFrame)
        {
            throw new DockerEngineException(
                "the exec's output is not stdcopy-framed — it was started with a terminal, and a terminal's output is read as it is");
        }

        return (stream, (int)length);
    }

    /// <summary>
    /// Each frame as it arrives. The payload's memory is reused: it is valid until the next frame is asked for.
    /// </summary>
    /// <exception cref="DockerEngineException">The bytes are not stdcopy framing — almost certainly a tty exec's output.</exception>
    public static async IAsyncEnumerable<(byte Stream, ReadOnlyMemory<byte> Payload)> FramesAsync(
        Stream framed,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var header = new byte[StdCopy.HeaderLength];
        var buffer = ArrayPool<byte>.Shared.Rent(32 * 1024);

        try
        {
            while (await ReadHeaderAsync(framed, header, ct).ConfigureAwait(false) is var (stream, length))
            {
                if (length > buffer.Length)
                {
                    ArrayPool<byte>.Shared.Return(buffer);
                    buffer = ArrayPool<byte>.Shared.Rent(length);
                }

                var payload = buffer.AsMemory(0, length);

                if (!await FillAsync(framed, payload, ct).ConfigureAwait(false))
                {
                    yield break;
                }

                yield return (stream, payload);
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    /// <summary>Copy stdout to one place and stderr to another until the exec's output ends.</summary>
    /// <param name="stdout">Where stream 1 goes, or null to drop it.</param>
    /// <param name="stderr">Where stream 2 goes, or null to drop it.</param>
    public static async Task CopyAsync(Stream framed, Stream? stdout, Stream? stderr, CancellationToken ct = default)
    {
        await foreach (var (stream, payload) in FramesAsync(framed, ct).ConfigureAwait(false))
        {
            var target = stream == StdCopy.Stderr ? stderr : stdout;

            if (target is not null)
            {
                await target.WriteAsync(payload, ct).ConfigureAwait(false);
                await target.FlushAsync(ct).ConfigureAwait(false);
            }
        }
    }

    /// <returns>False when the stream ended before the buffer was full.</returns>
    private static async ValueTask<bool> FillAsync(Stream source, Memory<byte> buffer, CancellationToken ct)
    {
        var filled = 0;

        while (filled < buffer.Length)
        {
            var read = await source.ReadAsync(buffer[filled..], ct).ConfigureAwait(false);

            if (read == 0)
            {
                return false;
            }

            filled += read;
        }

        return true;
    }
}
