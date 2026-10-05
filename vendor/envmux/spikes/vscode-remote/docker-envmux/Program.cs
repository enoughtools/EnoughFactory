using System.Diagnostics;

// docs/vscode-remote.md §7, the alternative: `dev.containers.dockerPath`
// names this instead of `docker`. It pins DOCKER_HOST at the envmux shim's
// pipe and execs the real docker CLI with stdio inherited, so hijacked
// streams pass straight through. Every invocation is logged, which is the
// §11.1 API-surface capture as a side effect.

var here = AppContext.BaseDirectory;
var log = Path.Combine(here, "docker-envmux.log");

try
{
    // Several docker processes run at once; the log is best-effort and shared.
    using var f = new FileStream(log, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
    using var w = new StreamWriter(f);
    w.WriteLine($"{DateTime.Now:HH:mm:ss.fff} docker {string.Join(' ', args.Select(a => a.Contains(' ') ? '"' + a + '"' : a))}");
}
catch (IOException)
{
}

var real = (Environment.GetEnvironmentVariable("PATH") ?? "")
    .Split(';', StringSplitOptions.RemoveEmptyEntries)
    .Select(d => Path.Combine(d, "docker.exe"))
    .FirstOrDefault(File.Exists)
    ?? @"C:\Program Files\Docker\Docker\resources\bin\docker.exe";

var psi = new ProcessStartInfo(real) { UseShellExecute = false };
foreach (var a in args) psi.ArgumentList.Add(a);
psi.Environment["DOCKER_HOST"] = "npipe:////./pipe/envmux-docker";
psi.Environment["DOCKER_CONTEXT"] = "default";

using var p = Process.Start(psi)!;
p.WaitForExit();
return p.ExitCode;
