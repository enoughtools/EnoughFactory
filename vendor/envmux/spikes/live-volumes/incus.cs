#!/usr/bin/env dotnet
// A minimum Incus client for driving this spike, so the demonstration can be
// reproduced without envmux itself and without the `incus` CLI, which does not
// ship for Windows. It reads ~/.envmux/host.json and the client certificate
// envmux already made, exactly as envmux does.
//
//   dotnet run incus.cs -- api  <METHOD> <path> [json]
//   dotnet run incus.cs -- exec <instance>            # script on stdin, as root
//
// Paths are given without a leading slash — "1.0/instances" — because Git Bash
// rewrites an argument that starts with one into a Windows path.
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
var directory = Path.Combine(home, ".envmux");

// CreateFromPemFile leaves the private key somewhere schannel will not take it
// ("the credentials supplied to the package were not recognized"); exporting to
// PKCS#12 and loading that back is what puts it where TLS can use it. envmux
// does the same thing in Host/ClientCertificate.cs for the same reason.
using var pem = X509Certificate2.CreateFromPemFile(
    Path.Combine(directory, "envmux-cli.crt"), Path.Combine(directory, "envmux-cli.key"));
var certificate = X509CertificateLoader.LoadPkcs12(pem.Export(X509ContentType.Pkcs12), null);

var settings = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, "host.json"))).RootElement;
var host = settings.GetProperty("api").GetString()!;
var fingerprint = settings.GetProperty("fingerprint").GetString()!;

var handler = new SocketsHttpHandler
{
    SslOptions = new SslClientAuthenticationOptions
    {
        ClientCertificates = [certificate],
        // incusd signs its own certificate, so there is no chain to validate
        // and the pin is the whole of the trust decision — the same one envmux
        // makes in IncusClient. Learned once, in host.json, at install time.
        RemoteCertificateValidationCallback = (_, presented, _, _) =>
            presented is not null &&
            Convert.ToHexString(SHA256.HashData(presented.GetRawCertData()))
                .Equals(fingerprint, StringComparison.OrdinalIgnoreCase),
    },
};

using var http = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(20) };
var root = $"https://{host}";

args = [.. args.Where(a => a != "--")];

if (args.Length == 0)
{
    Console.Error.WriteLine("usage: incus.cs api <METHOD> <path> [json] | incus.cs exec <instance>");
    return 2;
}

if (args[0] == "api")
{
    var request = new HttpRequestMessage(new HttpMethod(args[1]), $"{root}/{args[2].TrimStart('/')}");

    if (args.Length > 3)
    {
        request.Content = new StringContent(args[3], Encoding.UTF8, "application/json");
    }

    var response = await http.SendAsync(request);
    Console.WriteLine(await response.Content.ReadAsStringAsync());
    return 0;
}

if (args[0] != "exec")
{
    Console.Error.WriteLine($"incus.cs: unknown command '{args[0]}'");
    return 2;
}

var script = await Console.In.ReadToEndAsync();

// The script travels base64-encoded so that nothing in it — quotes, newlines,
// dollars — has to survive being embedded in JSON that is embedded in a shell
// command line.
var encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(script));

var body = $$"""
{"command":["/bin/sh","-c","echo {{encoded}} | base64 -d | /bin/sh"],
 "environment":{"HOME":"/root","PATH":"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
 "interactive":false,"wait-for-websocket":false,"record-output":true}
""";

var started = await http.PostAsync(
    $"{root}/1.0/instances/{args[1]}/exec",
    new StringContent(body, Encoding.UTF8, "application/json"));

var accepted = JsonDocument.Parse(await started.Content.ReadAsStringAsync()).RootElement;

if (accepted.GetProperty("type").GetString() == "error")
{
    Console.Error.WriteLine(accepted.GetProperty("error").GetString());
    return 1;
}

// record-output rather than a websocket: the command's streams go to two files
// on the host and the operation ends when the command does. envmux takes the
// same path for provisioning, and Golden.cs explains why at length — a pty does
// not close when the command exits.
var settled = JsonDocument
    .Parse(await http.GetStringAsync($"{root}{accepted.GetProperty("operation").GetString()}/wait"))
    .RootElement.GetProperty("metadata").GetProperty("metadata");

if (settled.TryGetProperty("output", out var outputs))
{
    foreach (var log in outputs.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
    {
        if (log.Value.GetString() is not { Length: > 0 } path)
        {
            continue;
        }

        Console.Write(await http.GetStringAsync($"{root}{path}"));

        try
        {
            await http.DeleteAsync($"{root}{path}");
        }
        catch (HttpRequestException)
        {
            // A log that will not delete is untidy; losing the output that was
            // just read to say so would be worse.
        }
    }
}

return settled.TryGetProperty("return", out var code) ? code.GetInt32() : 0;
