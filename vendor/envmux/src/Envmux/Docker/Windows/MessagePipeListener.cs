using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Envmux.Docker.Windows;

/// <summary>
/// The endpoint on Windows: a per-user named pipe, in message mode.
/// </summary>
/// <remarks>
/// <para>
/// Message mode is the finding, not a preference. The docker CLI ends stdin on
/// a hijacked exec with <c>CloseWrite()</c>, and go-winio implements that for
/// a <em>message</em>-mode pipe only — as a zero-length message — which is why
/// dockerd itself listens with <c>MessageMode: true</c>. On a byte-mode pipe
/// the call is a no-op, and the Dev Containers extension writes every file it
/// puts in a container with <c>docker exec -i … sh -c "cat &gt; f"</c>: the
/// <c>cat</c> never sees EOF and the connect hangs. Node's pipes are
/// byte-mode, and so are Kestrel's named-pipe transport's; this listener is
/// the one thing that cannot be borrowed from either.
/// </para>
/// <para>
/// The same signal is used in the other direction. EOF towards the client is a
/// zero-length message, and .NET's <see cref="PipeStream"/> quietly drops an
/// empty write, so that one write is a raw overlapped <c>WriteFile</c> — with
/// the low bit of its event handle set, which tells Windows to deliver the
/// completion to the event and not to the I/O completion port the handle is
/// bound to, where the runtime would try to read it as one of its own.
/// </para>
/// <para>
/// The pipe is created with a DACL granting the current user only. Docker's
/// API is unauthenticated by design and this one can start execs on every
/// target; Windows' default pipe ACL lets Everyone connect.
/// </para>
/// </remarks>
[SupportedOSPlatform("windows")]
internal sealed class MessagePipeListener(string name) : IShimListener
{
    private const int BufferSize = 64 * 1024;

    public string Address => $"npipe:////./pipe/{name}";

    public async ValueTask<IShimConnection?> AcceptAsync(CancellationToken ct)
    {
        while (true)
        {
            var pipe = Create();

            try
            {
                await pipe.WaitForConnectionAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                await pipe.DisposeAsync().ConfigureAwait(false);
                return null;
            }
            catch (IOException)
            {
                // A client that connected and left before the accept completed.
                await pipe.DisposeAsync().ConfigureAwait(false);
                continue;
            }

            return new Connection(pipe);
        }
    }

    private NamedPipeServerStream Create()
    {
        var owner = WindowsIdentity.GetCurrent().User
            ?? throw new ShimException("could not determine the current user, which the pipe's ACL needs");

        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.FullControl, AccessControlType.Allow));

        return NamedPipeServerStreamAcl.Create(
            name,
            PipeDirection.InOut,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Message,
            PipeOptions.Asynchronous,
            BufferSize,
            BufferSize,
            security);
    }

    public ValueTask DisposeAsync() => default;

    private sealed class Connection(NamedPipeServerStream pipe) : IShimConnection
    {
        public Stream Stream => pipe;

        public async ValueTask CompleteWriteAsync(CancellationToken ct)
        {
            try
            {
                await pipe.FlushAsync(ct).ConfigureAwait(false);
                Native.WriteEof(pipe.SafePipeHandle);
            }
            catch (IOException)
            {
                // The client is already gone, which is the same end state.
            }
        }

        public async ValueTask DisposeAsync()
        {
            await pipe.DisposeAsync().ConfigureAwait(false);
        }
    }

    // Internal, not private: the engine client's hijacked exec has the same
    // pipe in the other direction, and ends its stdin with this same write
    // (Backends/DockerEngine/HijackedStream.cs).
    internal static class Native
    {
        private const int ErrorIoPending = 997;

        public static void WriteEof(Microsoft.Win32.SafeHandles.SafePipeHandle handle)
        {
            var ev = CreateEventW(IntPtr.Zero, true, false, IntPtr.Zero);

            if (ev == IntPtr.Zero)
            {
                throw new IOException("could not create the event for the pipe's end-of-stream write");
            }

            try
            {
                nint flagged = ev;
                var overlapped = new NativeOverlapped { EventHandle = flagged | 1 };

                if (!WriteFile(handle, IntPtr.Zero, 0, IntPtr.Zero, ref overlapped) &&
                    Marshal.GetLastWin32Error() == ErrorIoPending)
                {
                    GetOverlappedResult(handle, ref overlapped, out _, true);
                }
            }
            finally
            {
                CloseHandle(ev);
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WriteFile(
            Microsoft.Win32.SafeHandles.SafePipeHandle handle,
            IntPtr buffer,
            uint bytes,
            IntPtr written,
            ref NativeOverlapped overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetOverlappedResult(
            Microsoft.Win32.SafeHandles.SafePipeHandle handle,
            ref NativeOverlapped overlapped,
            out uint transferred,
            [MarshalAs(UnmanagedType.Bool)] bool wait);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern IntPtr CreateEventW(
            IntPtr attributes,
            [MarshalAs(UnmanagedType.Bool)] bool manualReset,
            [MarshalAs(UnmanagedType.Bool)] bool initialState,
            IntPtr name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
