using System.Buffers.Binary;

namespace Envmux.Docker;

/// <summary>
/// Docker's framing for a stream that is not a terminal.
/// </summary>
/// <remarks>
/// When an exec was created with <c>Tty: false</c>, stdout and stderr travel
/// down one hijacked connection multiplexed with an eight-byte header: the
/// stream number, three zero bytes, and the payload length big-endian. Sending
/// unframed bytes instead is the single most likely failure of the whole
/// integration, and it does not present as a protocol error — the client
/// reads the first bytes of output as a header and hangs waiting for a
/// payload that long. docs/vscode-remote.md §6.2.
/// </remarks>
internal static class StdCopy
{
    public const byte Stdin = 0;
    public const byte Stdout = 1;
    public const byte Stderr = 2;

    public const int HeaderLength = 8;

    /// <summary>One frame: the header and the payload, in one buffer.</summary>
    public static byte[] Frame(byte stream, ReadOnlySpan<byte> payload)
    {
        var frame = new byte[HeaderLength + payload.Length];
        frame[0] = stream;
        BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(4, 4), (uint)payload.Length);
        payload.CopyTo(frame.AsSpan(HeaderLength));
        return frame;
    }
}
