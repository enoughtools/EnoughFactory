using System.Threading.Channels;

namespace Envmux.Tests.DockerEngine;

/// <summary>
/// A hijacked connection a test holds both ends of: it says what arrives and
/// when, when the far side ends, and sees what was written.
/// </summary>
/// <remarks>
/// What <see cref="FakeDockerEngine.OnExecStream"/> is for. The stream
/// <see cref="FakeDockerEngine"/> makes on its own is a finished recording —
/// everything the exec wrote, then the end — and the exec lane's questions are
/// all about a connection that is still open: output in pieces, a read that is
/// pending when something else happens, an end that comes before or after the
/// engine admits the process has exited. Disposing it fails a pending read, as
/// closing a real connection does.
/// </remarks>
internal sealed class ScriptedExecStream : Stream
{
    private readonly Channel<byte[]> _arriving = Channel.CreateUnbounded<byte[]>();
    private readonly List<byte> _written = [];
    private ReadOnlyMemory<byte> _pending;

    /// <summary>Whether the connection has been closed from this side.</summary>
    public bool Closed { get; private set; }

    /// <summary>Everything written down the connection so far.</summary>
    public byte[] Written
    {
        get
        {
            lock (_written)
            {
                return [.. _written];
            }
        }
    }

    /// <summary>Bytes arrive from the far side.</summary>
    public void Feed(params byte[][] pieces)
    {
        foreach (var piece in pieces)
        {
            _arriving.Writer.TryWrite(piece);
        }
    }

    /// <summary>The far side ends: reads return what is left, then zero.</summary>
    public void End() => _arriving.Writer.TryComplete();

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => true;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (_pending.Length == 0)
        {
            try
            {
                if (!await _arriving.Reader.WaitToReadAsync(cancellationToken) ||
                    !_arriving.Reader.TryRead(out var next))
                {
                    return 0;
                }

                _pending = next;
            }
            catch (ChannelClosedException e) when (e.InnerException is ObjectDisposedException disposed)
            {
                throw disposed;
            }
        }

        var take = Math.Min(buffer.Length, _pending.Length);
        _pending[..take].CopyTo(buffer);
        _pending = _pending[take..];
        return take;
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public override int Read(byte[] buffer, int offset, int count) =>
        ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

    public override void Write(byte[] buffer, int offset, int count)
    {
        ObjectDisposedException.ThrowIf(Closed, this);

        lock (_written)
        {
            _written.AddRange(buffer.AsSpan(offset, count));
        }
    }

    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(Closed, this);

        lock (_written)
        {
            _written.AddRange(buffer.Span);
        }

        return ValueTask.CompletedTask;
    }

    public override void Flush()
    {
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing && !Closed)
        {
            Closed = true;
            _arriving.Writer.TryComplete(new ObjectDisposedException(nameof(ScriptedExecStream)));
        }

        base.Dispose(disposing);
    }
}
