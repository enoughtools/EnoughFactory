using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;

namespace Envmux.Socks;

/// <summary>
/// Which process is on the other end of a loopback connection, and which
/// process started it.
/// </summary>
/// <remarks>
/// <para>
/// This is how the SOCKS port lets in a browser that cannot send a password.
/// Branded Chrome has no SOCKS5 authentication and, since 137, no
/// <c>--load-extension</c> to add it, so the credential is the connection's
/// owner instead: the TCP table says which process holds the client end, and
/// walking its parents says whether it is a browser this session launched.
/// Chrome's connections come from its network-service child; Firefox's from the
/// browser process itself or its socket process. Both are within a few parents
/// of what was launched (<c>spikes/socks-browser</c> showed it for Chrome and
/// Edge).
/// </para>
/// <para>
/// A port alone would not do. Any process of any account on this machine can
/// dial a loopback port, and so can a container whose traffic Docker Desktop or
/// WSL relays onto the loopback through a process running as this user. A
/// password or a launched ancestor is the difference between "on this machine"
/// and "the browser this session opened".
/// </para>
/// <para>
/// Windows uses iphlpapi and ntdll; macOS asks its bundled lsof and ps tools.
/// Other platforms answer "unknown" and a caller has to bring the password.
/// </para>
/// </remarks>
internal static class ConnectionOwner
{
    public static Task<int?> FindAsync(IPEndPoint client, int listenerPort, CancellationToken ct) =>
        OperatingSystem.IsMacOS()
            ? MacConnectionOwner.FindAsync(client, listenerPort, ct)
            : Task.FromResult(Find(client, listenerPort));

    public static Task<int?> ParentAsync(int pid, CancellationToken ct) =>
        OperatingSystem.IsMacOS()
            ? MacConnectionOwner.ParentAsync(pid, ct)
            : Task.FromResult(Parent(pid));

    /// <summary>
    /// The process holding the client end of a connection to <paramref name="listenerPort"/>
    /// from <paramref name="client"/>, or null when it cannot be told.
    /// </summary>
    public static int? Find(IPEndPoint client, int listenerPort)
    {
        if (!OperatingSystem.IsWindows() || client.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork)
        {
            return null;
        }

        var size = 0;
        _ = Native.GetExtendedTcpTable(IntPtr.Zero, ref size, false, Native.AfInet, Native.TcpTableOwnerPidAll, 0);

        // The table can grow between asking its size and reading it; a little
        // headroom saves the second round trip nearly every time.
        size += 16 * RowSize;
        var buffer = Marshal.AllocHGlobal(size);

        try
        {
            if (Native.GetExtendedTcpTable(buffer, ref size, false, Native.AfInet, Native.TcpTableOwnerPidAll, 0) != 0)
            {
                return null;
            }

            var count = Marshal.ReadInt32(buffer);

            for (var i = 0; i < count; i++)
            {
                // MIB_TCPROW_OWNER_PID: state, local addr, local port, remote
                // addr, remote port, pid — six DWORDs, ports in network order in
                // the low word.
                var row = buffer + 4 + (i * RowSize);

                if (Port(Marshal.ReadInt32(row, 8)) == client.Port &&
                    Port(Marshal.ReadInt32(row, 16)) == listenerPort)
                {
                    return Marshal.ReadInt32(row, 20);
                }
            }

            return null;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        static int Port(int raw) => ((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF);
    }

    /// <summary>
    /// The process that started <paramref name="pid"/>, or null when it cannot
    /// be read — gone, or not ours to open.
    /// </summary>
    public static int? Parent(int pid)
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        var handle = Native.OpenProcess(Native.ProcessQueryLimitedInformation, false, pid);

        if (handle == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            var info = default(Native.ProcessBasicInformation);

            return Native.NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(info), out _) == 0
                ? checked((int)info.InheritedFromUniqueProcessId)
                : null;
        }
        finally
        {
            Native.CloseHandle(handle);
        }
    }

    /// <summary>What a process is called, for a log line about it.</summary>
    public static string Name(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            return process.ProcessName;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            return "?";
        }
    }

    /// <summary>When a process started, to tell it from a later one given the same id.</summary>
    public static DateTime? Started(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            return process.StartTime;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }

    private const int RowSize = 24;

    // DllImport rather than LibraryImport, for the reason Ui/ConsoleModes.cs
    // gives: the source generator emits unsafe code and the project does not
    // allow it.
    private static class Native
    {
        public const int AfInet = 2;
        public const int TcpTableOwnerPidAll = 5;
        public const int ProcessQueryLimitedInformation = 0x1000;

        [DllImport("iphlpapi.dll")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        public static extern uint GetExtendedTcpTable(
            IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);

        [DllImport("kernel32.dll", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        public static extern IntPtr OpenProcess(int access, bool inherit, int pid);

        [DllImport("kernel32.dll")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("ntdll.dll")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        public static extern int NtQueryInformationProcess(
            IntPtr process, int infoClass, ref ProcessBasicInformation info, int size, out int returned);

        [StructLayout(LayoutKind.Sequential)]
        public struct ProcessBasicInformation
        {
            public IntPtr ExitStatus;
            public IntPtr PebBaseAddress;
            public IntPtr AffinityMask;
            public IntPtr BasePriority;
            public IntPtr UniqueProcessId;
            public IntPtr InheritedFromUniqueProcessId;
        }
    }
}

/// <summary>
/// The browsers this session launched, and the question the SOCKS port asks of
/// every connection that brings no password: is it one of them?
/// </summary>
internal sealed class LaunchedBrowsers
{
    /// <summary>
    /// How many parents up to look.
    /// </summary>
    /// <remarks>
    /// Chrome's network service is one below the browser; Firefox's socket
    /// process one below its. Four is room for a launcher in between and not
    /// enough to reach <c>explorer.exe</c>, which is every desktop process's
    /// ancestor and would make the check mean nothing.
    /// </remarks>
    private const int Depth = 4;

    private readonly Dictionary<int, DateTime?> _launched = [];

    public void Add(System.Diagnostics.Process process)
    {
        lock (_launched)
        {
            _launched[process.Id] = ConnectionOwner.Started(process.Id);
        }
    }

    public bool Any
    {
        get
        {
            lock (_launched)
            {
                return _launched.Count > 0;
            }
        }
    }

    /// <summary>
    /// Whether <paramref name="pid"/> is a launched browser or descends from one.
    /// </summary>
    /// <remarks>
    /// A launched id is only believed while the process behind it has the start
    /// time it had when it was launched, so a browser that has exited cannot
    /// lend its id to whatever Windows hands the number to next.
    /// </remarks>
    public async Task<bool> ContainsAsync(int pid, CancellationToken ct)
    {
        int? current = pid;

        for (var depth = 0; depth <= Depth && current is { } p && p > 0; depth++)
        {
            DateTime? started;
            bool known;

            lock (_launched)
            {
                known = _launched.TryGetValue(p, out started);
            }

            if (known && started is not null && ConnectionOwner.Started(p) == started)
            {
                return true;
            }

            current = await ConnectionOwner.ParentAsync(p, ct).ConfigureAwait(false);
        }

        return false;
    }
}
