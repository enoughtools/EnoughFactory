#!/usr/bin/env dotnet
// The browser half of the SOCKS idea, proved on this machine alone.
//
// A SOCKS5 listener on loopback stands in for envmux; a small HTTP server on
// another loopback port stands in for the instance ("the box"). Anything the
// browser sends to 127.0.0.1:3000 / localhost:3000 / [::1]:3000 is carried to
// the box instead — which is exactly what the real thing does, with an exec
// stream in the middle instead of a local socket.
//
//   dotnet run socks.cs -- serve              # listen, print the port, wait
//   dotnet run socks.cs -- browsers           # also drive Chrome and Edge headless
//
// It asks two questions the idea depends on:
//   1. Can a launched browser be made to send *loopback* through a proxy?
//      Chrome bypasses 127/8, localhost and ::1 by default.
//   2. How does the proxy know which session a connection is for, given that
//      branded Chrome cannot send a SOCKS5 username and password?
#:property TreatWarningsAsErrors=false
#:property Nullable=enable
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

args = [.. args.Where(a => a != "--")];
var mode = args.FirstOrDefault() ?? "serve";

// ---- the box ---------------------------------------------------------------
var box = new TcpListener(IPAddress.Loopback, 0);
box.Start();
var boxPort = ((IPEndPoint)box.LocalEndpoint).Port;
_ = Task.Run(async () =>
{
    while (true)
    {
        var client = await box.AcceptTcpClientAsync();
        _ = Task.Run(() => ServeBox(client));
    }
});

// ---- the proxy -------------------------------------------------------------
const string User = "demo-session";
const string Password = "s3cret";
var proxy = new TcpListener(IPAddress.Loopback, 0);
proxy.Start();
var proxyPort = ((IPEndPoint)proxy.LocalEndpoint).Port;
var launched = new Dictionary<int, string>(); // browser pid -> label
Log($"box on 127.0.0.1:{boxPort}; socks5 on 127.0.0.1:{proxyPort} (user {User})");
_ = Task.Run(async () =>
{
    while (true)
    {
        var client = await proxy.AcceptTcpClientAsync();
        _ = Task.Run(() => ServeSocks(client));
    }
});

if (mode == "serve")
{
    await Task.Delay(Timeout.Infinite);
}

if (mode == "browsers")
{
    var browsers = new (string Name, string Exe)[]
    {
        ("chrome", @"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        ("edge", @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    };
    var urls = new[] { "http://127.0.0.1:3000/", "http://localhost:3000/", "http://[::1]:3000/" };

    foreach (var (name, exe) in browsers.Where(b => File.Exists(b.Exe)))
    {
        foreach (var bypassLoopback in new[] { false, true })
        {
            foreach (var url in urls)
            {
                var label = $"{name} {(bypassLoopback ? "<-loopback>" : "default   ")} {url}";
                var dom = await Headless(exe, url, bypassLoopback, label);
                var verdict = dom.Contains("served by the box", StringComparison.Ordinal)
                    ? (dom.Contains("api via the box", StringComparison.Ordinal) ? "BOX (page + fetch)" : "BOX (page only)")
                    : dom.Length == 0 ? "nothing (bypassed to real loopback, refused)" : "something else";
                Console.WriteLine($"RESULT {label,-60} -> {verdict}");
            }
        }
    }
}

if (mode == "launch")
{
    // launch <exe> <url> [seconds] [headless]: open a real browser on its own
    // profile, routed through the proxy; the log above is the evidence.
    var exe = args[1];
    var seconds = args.Length > 3 ? int.Parse(args[3], CultureInfo.InvariantCulture) : 10;
    var profile = Path.Combine(Path.GetTempPath(), "envmux-socks-" + Guid.NewGuid().ToString("N")[..8]);
    var psi = new ProcessStartInfo(exe) { UseShellExecute = false };
    if (args.Length > 4 && args[4] == "headless") { psi.ArgumentList.Add("--headless=new"); }
    foreach (var a in new[]
    {
        $"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
        $"--proxy-server=socks5://127.0.0.1:{proxyPort}", "--proxy-bypass-list=<-loopback>", args[2],
    })
    {
        psi.ArgumentList.Add(a);
    }
    using var process = Process.Start(psi)!;
    lock (launched) { launched[process.Id] = Path.GetFileNameWithoutExtension(exe); }
    Log($"launched {Path.GetFileName(exe)} pid {process.Id} for {seconds}s");
    await Task.Delay(TimeSpan.FromSeconds(seconds));
    try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
}

return 0;

async Task<string> Headless(string exe, string url, bool bypassLoopback, string label)
{
    var profile = Path.Combine(Path.GetTempPath(), "envmux-socks-" + Guid.NewGuid().ToString("N")[..8]);
    var psi = new ProcessStartInfo(exe)
    {
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
    };
    foreach (var a in new[]
    {
        "--headless=new",
        $"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        $"--proxy-server=socks5://127.0.0.1:{proxyPort}",
    })
    {
        psi.ArgumentList.Add(a);
    }
    if (bypassLoopback)
    {
        // Removes the implicit bypass of 127/8, localhost and [::1].
        psi.ArgumentList.Add("--proxy-bypass-list=<-loopback>");
    }
    psi.ArgumentList.Add("--virtual-time-budget=4000");
    psi.ArgumentList.Add("--dump-dom");
    psi.ArgumentList.Add(url);

    using var process = Process.Start(psi)!;
    lock (launched)
    {
        launched[process.Id] = label;
    }
    var stdout = process.StandardOutput.ReadToEndAsync();
    _ = process.StandardError.ReadToEndAsync();
    if (!process.WaitForExit(30_000))
    {
        process.Kill(entireProcessTree: true);
    }
    var dom = await stdout;
    try { Directory.Delete(profile, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    return dom.Contains("<body", StringComparison.Ordinal) && !dom.Contains("ERR_", StringComparison.Ordinal) ? dom : "";
}

async Task ServeSocks(TcpClient client)
{
    using var _ = client;
    var stream = client.GetStream();
    var caller = Caller((IPEndPoint)client.Client.RemoteEndPoint!, proxyPort);
    try
    {
        // Greeting: VER NMETHODS METHODS...
        var head = await ReadExactly(stream, 2);
        if (head[0] != 5) { return; }
        var methods = await ReadExactly(stream, head[1]);
        string auth;
        if (methods.Contains((byte)2))
        {
            await stream.WriteAsync(new byte[] { 5, 2 });
            // RFC 1929: VER ULEN UNAME PLEN PASSWD
            var v = await ReadExactly(stream, 2);
            var uname = Encoding.UTF8.GetString(await ReadExactly(stream, v[1]));
            var plen = (await ReadExactly(stream, 1))[0];
            var passwd = Encoding.UTF8.GetString(await ReadExactly(stream, plen));
            var ok = uname == User && passwd == Password;
            await stream.WriteAsync(new byte[] { 1, (byte)(ok ? 0 : 1) });
            if (!ok) { Log($"{caller}: bad credentials for '{uname}'"); return; }
            auth = $"user/pass ({uname})";
        }
        else if (methods.Contains((byte)0))
        {
            await stream.WriteAsync(new byte[] { 5, 0 });
            auth = "no auth offered";
        }
        else
        {
            await stream.WriteAsync(new byte[] { 5, 0xFF });
            return;
        }

        // Request: VER CMD RSV ATYP DST.ADDR DST.PORT
        var req = await ReadExactly(stream, 4);
        string target = req[3] switch
        {
            1 => new IPAddress(await ReadExactly(stream, 4)).ToString(),
            4 => new IPAddress(await ReadExactly(stream, 16)).ToString(),
            3 => Encoding.ASCII.GetString(await ReadExactly(stream, (await ReadExactly(stream, 1))[0])),
            _ => throw new InvalidDataException("atyp"),
        };
        var pb = await ReadExactly(stream, 2);
        var port = (pb[0] << 8) | pb[1];
        var atyp = req[3] == 3 ? "name" : "addr";

        var loopback = target is "localhost" || (IPAddress.TryParse(target, out var ip) && IPAddress.IsLoopback(ip));
        if (req[1] != 1 || !loopback || port != 3000)
        {
            Log($"{caller} [{auth}] CONNECT {target}:{port} ({atyp}) -> refused (only loopback:3000 is the box here)");
            await stream.WriteAsync(new byte[] { 5, 5, 0, 1, 0, 0, 0, 0, 0, 0 });
            return;
        }

        Log($"{caller} [{auth}] CONNECT {target}:{port} ({atyp}) -> the box");
        using var upstream = new TcpClient();
        await upstream.ConnectAsync(IPAddress.Loopback, boxPort);
        await stream.WriteAsync(new byte[] { 5, 0, 0, 1, 0, 0, 0, 0, 0, 0 });
        var up = upstream.GetStream();
        await Task.WhenAny(stream.CopyToAsync(up), up.CopyToAsync(stream));
    }
    catch (Exception e) when (e is IOException or SocketException or EndOfStreamException or InvalidDataException)
    {
    }
}

async Task ServeBox(TcpClient client)
{
    using var _ = client;
    var stream = client.GetStream();
    try
    {
        var reader = new StreamReader(stream, Encoding.ASCII, leaveOpen: true);
        var requestLine = await reader.ReadLineAsync() ?? "";
        string? hostHeader = null;
        string? line;
        while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync()))
        {
            if (line.StartsWith("Host:", StringComparison.OrdinalIgnoreCase)) { hostHeader = line[5..].Trim(); }
        }
        var path = requestLine.Split(' ').ElementAtOrDefault(1) ?? "/";
        var body = path == "/api"
            ? $"api via the box (Host: {hostHeader})"
            : $"<!doctype html><html><body><h1>served by the box</h1><p>Host: {hostHeader}</p><p id=api>…</p>" +
              "<script>fetch('/api').then(r=>r.text()).then(t=>document.getElementById('api').textContent=t)</script>" +
              "</body></html>";
        var type = path == "/api" ? "text/plain" : "text/html";
        var bytes = Encoding.UTF8.GetBytes(body);
        var header = $"HTTP/1.1 200 OK\r\nContent-Type: {type}; charset=utf-8\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(header));
        await stream.WriteAsync(bytes);
    }
    catch (IOException)
    {
    }
}

// Which process holds the client end of this connection, and which of our
// launched browsers (if any) it descends from. This is how the proxy can know
// the session without a password: the connection's owner is the credential.
string Caller(IPEndPoint remote, int listenerPort)
{
    var pid = OwningPid(remote.Port, listenerPort);
    if (pid == 0) { return $"pid ?"; }
    string name;
    try { name = Process.GetProcessById(pid).ProcessName; } catch (ArgumentException) { name = "?"; }
    var chain = new List<int>();
    for (int p = pid, depth = 0; p != 0 && depth < 6; p = ParentPid(p), depth++)
    {
        chain.Add(p);
        lock (launched)
        {
            if (launched.TryGetValue(p, out var label))
            {
                return $"pid {pid} {name} ⊂ launched {p} [{label.Split(' ')[0]}]";
            }
        }
    }
    return $"pid {pid} {name} (not a launched browser)";
}

static int OwningPid(int clientPort, int serverPort)
{
    foreach (var family in new[] { 2, 23 })
    {
        var size = 0;
        _ = Native.GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 5, 0);
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (Native.GetExtendedTcpTable(buffer, ref size, false, family, 5, 0) != 0) { continue; }
            var count = Marshal.ReadInt32(buffer);
            // MIB_TCPROW_OWNER_PID is 6 DWORDs; MIB_TCP6ROW_OWNER_PID is 16+4+4+16+4+4+4+4 bytes.
            var rowSize = family == 2 ? 24 : 56;
            for (var i = 0; i < count; i++)
            {
                var row = buffer + 4 + (i * rowSize);
                int local, remote, owner;
                if (family == 2)
                {
                    local = Port(Marshal.ReadInt32(row, 8));
                    remote = Port(Marshal.ReadInt32(row, 16));
                    owner = Marshal.ReadInt32(row, 20);
                }
                else
                {
                    local = Port(Marshal.ReadInt32(row, 20));
                    remote = Port(Marshal.ReadInt32(row, 44));
                    owner = Marshal.ReadInt32(row, 52);
                }
                if (local == clientPort && remote == serverPort) { return owner; }
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }
    return 0;

    static int Port(int raw) => ((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF);
}

static int ParentPid(int pid)
{
    var handle = Native.OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (handle == IntPtr.Zero) { return 0; }
    try
    {
        var info = new Native.ProcessBasicInformation();
        return Native.NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(info), out _) == 0
            ? checked((int)info.InheritedFromUniqueProcessId)
            : 0;
    }
    finally
    {
        Native.CloseHandle(handle);
    }
}

static async Task<byte[]> ReadExactly(Stream s, int n)
{
    var buffer = new byte[n];
    await s.ReadExactlyAsync(buffer);
    return buffer;
}

static void Log(string message) =>
    Console.WriteLine($"{DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture)} {message}");

static class Native
{
    [DllImport("iphlpapi.dll")]
    public static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);

    [DllImport("kernel32.dll")]
    public static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref ProcessBasicInformation info, int size, out int returned);

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
