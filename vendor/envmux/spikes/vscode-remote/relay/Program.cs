using System.Buffers.Binary;
using System.IO.Pipes;
using System.Runtime.InteropServices;

// envmux docker shim — the Windows transport leg.
//
// The docker CLI can only half-close (CloseWrite) a MESSAGE-mode named pipe:
// go-winio signals EOF by writing a zero-length message, and only does so when
// the server created the pipe with PIPE_TYPE_MESSAGE — which is why dockerd
// itself listens with MessageMode: true. Node (libuv) and Kestrel both create
// byte-mode pipes, so `docker exec -i … sh -c "cat > file"` never sees EOF
// through either. This relay owns the public pipe in message mode and forwards
// each connection to the shim over a byte-mode pipe, length-prefixing the
// upstream direction so that a zero length carries the half-close.
//
// EOF towards the client is the same zero-length message. .NET's PipeStream
// drops empty writes on the floor, so that one write is a raw overlapped
// WriteFile. The handle has to stay overlapped: Windows serialises synchronous
// I/O on a handle, so a blocking read in one pump would starve every write in
// the other.

const string Outer = "envmux-docker";
const string Inner = "envmux-docker-inner";

ThreadPool.SetMinThreads(128, 128);
Console.WriteLine($"relay: \\\\.\\pipe\\{Outer} (message mode) -> \\\\.\\pipe\\{Inner}");

while (true)
{
    var client = new NamedPipeServerStream(
        Outer,
        PipeDirection.InOut,
        NamedPipeServerStream.MaxAllowedServerInstances,
        PipeTransmissionMode.Message,
        PipeOptions.Asynchronous,
        inBufferSize: 65536,
        outBufferSize: 65536);

    await client.WaitForConnectionAsync();
    _ = Task.Run(() => HandleAsync(client));
}

static async Task HandleAsync(NamedPipeServerStream client)
{
    try
    {
        using var inner = new NamedPipeClientStream(".", Inner, PipeDirection.InOut, PipeOptions.Asynchronous);
        await inner.ConnectAsync(5000);

        var up = Task.Run(async () =>
        {
            var buf = new byte[65536];
            var hdr = new byte[4];
            var eof = false;
            try
            {
                while (true)
                {
                    var n = await client.ReadAsync(buf);
                    if (n == 0)
                    {
                        // A zero-length message is CloseWrite; a second zero, or a
                        // dropped client, is the end.
                        if (eof) break;
                        eof = true;
                        BinaryPrimitives.WriteInt32BigEndian(hdr, 0);
                        await inner.WriteAsync(hdr);
                        await inner.FlushAsync();
                        if (!client.IsConnected) break;
                        continue;
                    }

                    BinaryPrimitives.WriteInt32BigEndian(hdr, n);
                    await inner.WriteAsync(hdr);
                    await inner.WriteAsync(buf.AsMemory(0, n));
                }
            }
            catch (Exception)
            {
                // Either side went away; the other pump notices too.
            }
        });

        var down = Task.Run(async () =>
        {
            var buf = new byte[65536];
            try
            {
                while (true)
                {
                    var n = await inner.ReadAsync(buf);
                    if (n == 0) break;
                    await client.WriteAsync(buf.AsMemory(0, n));
                }
            }
            catch (Exception)
            {
            }
        });

        // The shim ending its side is EOF to the client: a zero-length message,
        // the mirror of CloseWrite. Disconnecting instead would discard whatever
        // the client had not yet read. The pipe stays open until the client,
        // having read EOF, closes it.
        await down;
        try { await client.FlushAsync(); Native.WriteEof(client.SafePipeHandle); } catch { }
        await up;
    }
    catch (Exception e)
    {
        Console.WriteLine($"relay: {e.Message}");
    }
    finally
    {
        try { client.Dispose(); } catch { }
    }
}

static unsafe partial class Native
{
    private const int ErrorIoPending = 997;

    public static void WriteEof(Microsoft.Win32.SafeHandles.SafePipeHandle handle)
    {
        var ev = CreateEventW(IntPtr.Zero, true, false, IntPtr.Zero);
        try
        {
            // Low bit set on the event: the completion is delivered to this event
            // and not to the I/O completion port the handle is bound to — where the
            // CLR would try to read it as one of its own Overlapped objects.
            nint flagged = ev;
            var ov = new NativeOverlapped { EventHandle = flagged | 1 };
            var ok = WriteFile(handle, IntPtr.Zero, 0, IntPtr.Zero, &ov);
            if (!ok && Marshal.GetLastWin32Error() == ErrorIoPending)
            {
                GetOverlappedResult(handle, &ov, out _, true);
            }
        }
        finally
        {
            CloseHandle(ev);
        }
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool WriteFile(Microsoft.Win32.SafeHandles.SafePipeHandle handle, IntPtr buffer, uint bytes, IntPtr written, NativeOverlapped* overlapped);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetOverlappedResult(Microsoft.Win32.SafeHandles.SafePipeHandle handle, NativeOverlapped* overlapped, out uint transferred, [MarshalAs(UnmanagedType.Bool)] bool wait);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial IntPtr CreateEventW(IntPtr attributes, [MarshalAs(UnmanagedType.Bool)] bool manualReset, [MarshalAs(UnmanagedType.Bool)] bool initialState, IntPtr name);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(IntPtr handle);
}
