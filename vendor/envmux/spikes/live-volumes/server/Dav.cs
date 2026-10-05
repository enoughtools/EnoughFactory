using System.Globalization;
using System.Net;
using System.Text;
using System.Security.Cryptography;
using System.Xml;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Extensions;
using Microsoft.Net.Http.Headers;

namespace Envmux.Live;

/// <summary>
/// The protocol the guest's FUSE client speaks: read-write WebDAV over the
/// session's own socket.
/// </summary>
/// <remarks>
/// <para>
/// WebDAV because the client had to be something already written and already
/// packaged — <c>rclone mount</c> — and because of everything it can speak, this
/// is the one whose server side is a day's work rather than a project.
/// <c>PROPFIND</c>, <c>GET</c>, <c>PUT</c>, <c>DELETE</c>, <c>MKCOL</c>,
/// <c>MOVE</c> and one XML shape is the whole of it, and every verb maps onto a
/// filesystem call that already exists.
/// </para>
/// <para>
/// S3 was the other candidate and would have been about the same size, but
/// buckets have no directories and no rename, so the mapping back to a
/// directory of small config files is the client's guesswork rather than the
/// server's statement. Locking is deliberately absent: <c>rclone</c> does not
/// ask for it, and one workstation with one person on it is not where
/// distributed locking earns its complexity.
/// </para>
/// </remarks>
internal sealed class Dav(Tree tree, Grants grants, GitVault git, Action<string>? audit = null)
{
    private const string Dav1 = "DAV:";

    public async Task HandleAsync(HttpContext context)
    {
        var grant = grants.Resolve(Presented(context.Request));

        if (grant is null)
        {
            // No WWW-Authenticate: there is nothing here to prompt a human for,
            // and a browser that found this port should get a door with no
            // handle rather than a login box.
            context.Response.StatusCode = (int)HttpStatusCode.Forbidden;
            return;
        }

        var path = Uri.UnescapeDataString(context.Request.Path.Value ?? "/");
        var at = tree.Resolve(path);

        // Out of scope is answered as absent rather than as forbidden. A task
        // that was not given the credential should find a directory without one
        // in it, not a locked door telling it where to knock — and a FUSE client
        // turns 403 into EACCES, which surfaces to the tool as a permissions bug
        // on the workstation rather than as a file it was never offered.
        if (!grant.Scope.Allows(at.Namespace?.Name, at.Relative))
        {
            // Logged, unlike an ordinary miss. A task reaching for a path it was
            // not granted is the event this whole design is here to make
            // visible, and it is the one thing in the log worth an alert.
            audit?.Invoke($"{DateTimeOffset.UtcNow:O} {grant.Task} {grant.Id} DENIED {context.Request.Method} {path}");

            context.Response.StatusCode = (int)HttpStatusCode.NotFound;
            return;
        }

        if (audit is not null &&
            at.Route is Route.Live or Route.Shadow &&
            context.Request.Method is not ("PROPFIND" or "OPTIONS"))
        {
            // A shadowed path that has fallen back is a read of the
            // workstation's own file and is logged as one; once the session has
            // written its own copy it is reading itself, and saying so keeps the
            // log about the workstation rather than about the session.
            var from = at.Route == Route.Shadow && at.ReadPath == at.HostPath ? " (session copy)" : "";
            audit($"{DateTimeOffset.UtcNow:O} {grant.Task} {grant.Id} {context.Request.Method} {path}{from}");
        }

        if (at.Route == Route.Virtual)
        {
            await VirtualAsync(context, path, at, grant).ConfigureAwait(false);
            return;
        }

        switch (context.Request.Method.ToUpperInvariant())
        {
            case "OPTIONS":
                Options(context);
                return;

            case "PROPFIND":
                await PropfindAsync(context, path, at, grant.Scope).ConfigureAwait(false);
                return;

            case "HEAD":
            case "GET":
                await GetAsync(context, at, body: context.Request.Method == "GET").ConfigureAwait(false);
                return;

            case "PUT":
                await PutAsync(context, at).ConfigureAwait(false);
                return;

            case "DELETE":
                Delete(context, at);
                return;

            case "MKCOL":
                Mkcol(context, at);
                return;

            case "MOVE":
            case "COPY":
                Transfer(context, at, grant.Scope);
                return;

            default:
                context.Response.StatusCode = (int)HttpStatusCode.MethodNotAllowed;
                return;
        }
    }

    /// <summary>
    /// The key this request carries, if it carries one.
    /// </summary>
    /// <remarks>
    /// The key is the whole of the authorisation, because the transport cannot
    /// help. The proxy device puts this endpoint on the guest's loopback, which
    /// reads like isolation and is not: every instance on the bridge leaves the
    /// workstation's NAT wearing the same source address, so the listener cannot
    /// tell one caller from another and must not try.
    /// </remarks>
    private static string? Presented(HttpRequest request)
    {
        var header = request.Headers.Authorization.ToString();
        return header.StartsWith("Bearer ", StringComparison.Ordinal) ? header[7..] : null;
    }

    /// <summary>
    /// The git namespace: a directory of hosts, each a file whose contents are
    /// the credential lines for that host, fetched when read.
    /// </summary>
    /// <remarks>
    /// Read-only in every verb. A <c>PUT</c> here would be a container telling
    /// this workstation what it is signed in as, and there is no version of that
    /// which is what anybody meant.
    /// </remarks>
    private async Task VirtualAsync(HttpContext context, string path, Resolution at, Grant grant)
    {
        var method = context.Request.Method.ToUpperInvariant();

        if (method == "OPTIONS")
        {
            Options(context);
            return;
        }

        if (method is not ("PROPFIND" or "GET" or "HEAD"))
        {
            context.Response.StatusCode = (int)HttpStatusCode.Forbidden;
            return;
        }

        // The hosts this key may ask about: the vault's allowlist, narrowed by
        // the key's scope.
        var hosts = git.Hosts.Where(h => grant.Scope.Allows(Policy.Git, h)).ToList();

        if (at.Relative.Length == 0)
        {
            if (method != "PROPFIND")
            {
                context.Response.StatusCode = (int)HttpStatusCode.MethodNotAllowed;
                return;
            }

            var depth = context.Request.Headers["Depth"].ToString();
            var entries = new List<(string Href, Entry Entry)>
            {
                (Href(path, true), new Entry(Policy.Git, true, 0, DateTimeOffset.UnixEpoch, null)),
            };

            if (depth == "1")
            {
                foreach (var host in hosts)
                {
                    if (await git.GetAsync(host, context.RequestAborted).ConfigureAwait(false) is { } bytes)
                    {
                        entries.Add((Href($"{Policy.Git}/{host}", false), Credential(host, bytes)));
                    }
                }
            }

            await MultistatusAsync(context, entries).ConfigureAwait(false);
            return;
        }

        var wanted = at.Relative;

        if (!hosts.Contains(wanted, StringComparer.OrdinalIgnoreCase))
        {
            audit?.Invoke($"{DateTimeOffset.UtcNow:O} {grant.Task} {grant.Id} DENIED GIT {wanted}");
            context.Response.StatusCode = (int)HttpStatusCode.NotFound;
            return;
        }

        var credential = await git.GetAsync(wanted, context.RequestAborted).ConfigureAwait(false);

        if (credential is null)
        {
            context.Response.StatusCode = (int)HttpStatusCode.NotFound;
            return;
        }

        var entry = Credential(wanted, credential);

        if (method == "PROPFIND")
        {
            await MultistatusAsync(context, [(Href(path, false), entry)]).ConfigureAwait(false);
            return;
        }

        audit?.Invoke($"{DateTimeOffset.UtcNow:O} {grant.Task} {grant.Id} GIT {wanted}");

        var (offset, count) = Range(context.Request.Headers.Range.ToString(), credential.Length);

        context.Response.Headers[HeaderNames.ETag] = entry.ETag;
        context.Response.Headers[HeaderNames.AcceptRanges] = "bytes";
        context.Response.Headers[HeaderNames.CacheControl] = "no-store";
        context.Response.ContentType = "text/plain; charset=utf-8";
        context.Response.ContentLength = count;

        if (offset > 0 || count != credential.Length)
        {
            context.Response.StatusCode = (int)HttpStatusCode.PartialContent;
            context.Response.Headers[HeaderNames.ContentRange] = $"bytes {offset}-{offset + count - 1}/{credential.Length}";
        }

        if (method == "GET" && count > 0)
        {
            await context.Response.Body.WriteAsync(credential.AsMemory((int)offset, (int)count), context.RequestAborted)
                .ConfigureAwait(false);
        }
    }

    /// <summary>A credential as a file: its length, and a modified time that moves when it does.</summary>
    private static Entry Credential(string host, byte[] bytes) =>
        new(host, false, bytes.Length,
            // The minute it was fetched in, so ETag and mtime change exactly
            // when the vault re-asks, and not on every stat in between.
            new DateTimeOffset(DateTimeOffset.UtcNow.Ticks / TimeSpan.TicksPerMinute * TimeSpan.TicksPerMinute, TimeSpan.Zero),
            null);

    private static void Options(HttpContext context)
    {
        context.Response.Headers["DAV"] = "1";
        context.Response.Headers["MS-Author-Via"] = "DAV";
        context.Response.Headers[HeaderNames.Allow] =
            "OPTIONS, PROPFIND, HEAD, GET, PUT, DELETE, MKCOL, MOVE, COPY";
        context.Response.StatusCode = (int)HttpStatusCode.OK;
    }

    private async Task PropfindAsync(HttpContext context, string path, Resolution at, Scope scope)
    {
        var self = Tree.Stat(at, Name(path));

        if (self is null)
        {
            context.Response.StatusCode = (int)HttpStatusCode.NotFound;
            return;
        }

        // Depth: infinity is refused rather than served. rclone asks for 0 and 1,
        // and the one caller who would ask for infinity is a crawler walking 317
        // MB of transcripts one HTTP response at a time.
        var depth = context.Request.Headers["Depth"].ToString();

        if (depth.Equals("infinity", StringComparison.OrdinalIgnoreCase))
        {
            context.Response.StatusCode = 403;
            return;
        }

        var href = Href(path, self.IsDirectory);
        var entries = new List<(string Href, Entry Entry)> { (href, self) };

        if (depth == "1" && self.IsDirectory)
        {
            foreach (var (name, child) in tree.Children(at))
            {
                if (!scope.Allows(child.Namespace?.Name, child.Relative))
                {
                    continue;
                }

                // The git directory is listed here as a directory; what is in
                // it is the vault's to say and needs the key's scope, so a
                // client that wants its contents asks it directly.
                if (Tree.Stat(child, name) is { } entry)
                {
                    entries.Add((Href(href.TrimEnd('/') + "/" + name, entry.IsDirectory), entry));
                }
            }
        }

        await MultistatusAsync(context, entries).ConfigureAwait(false);
    }

    private static async Task MultistatusAsync(HttpContext context, IReadOnlyList<(string Href, Entry Entry)> entries)
    {
        // Into a stream rather than a StringBuilder: XmlWriter takes its
        // declared encoding from the sink, and a StringBuilder is UTF-16, so the
        // document announced utf-16 while the response was written as UTF-8.
        var body = new MemoryStream();
        using (var xml = XmlWriter.Create(body, new XmlWriterSettings
        {
            Indent = false,
            OmitXmlDeclaration = false,
            Encoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
        }))
        {
            xml.WriteStartElement("D", "multistatus", Dav1);

            foreach (var (href, entry) in entries)
            {
                Respond(xml, href, entry);
            }

            xml.WriteEndElement();
        }

        context.Response.StatusCode = 207;
        context.Response.ContentType = "application/xml; charset=utf-8";
        context.Response.ContentLength = body.Length;
        await context.Response.Body.WriteAsync(body.GetBuffer().AsMemory(0, (int)body.Length)).ConfigureAwait(false);
    }

    private static void Respond(XmlWriter xml, string href, Entry entry)
    {
        xml.WriteStartElement("D", "response", Dav1);
        xml.WriteElementString("D", "href", Dav1, href);
        xml.WriteStartElement("D", "propstat", Dav1);
        xml.WriteStartElement("D", "prop", Dav1);

        xml.WriteElementString("D", "displayname", Dav1, entry.Name);

        xml.WriteStartElement("D", "resourcetype", Dav1);

        if (entry.IsDirectory)
        {
            xml.WriteElementString("D", "collection", Dav1, null);
        }

        xml.WriteEndElement();

        xml.WriteElementString("D", "getlastmodified", Dav1,
            entry.Modified.UtcDateTime.ToString("R", CultureInfo.InvariantCulture));

        if (!entry.IsDirectory)
        {
            xml.WriteElementString("D", "getcontentlength", Dav1,
                entry.Length.ToString(CultureInfo.InvariantCulture));
            xml.WriteElementString("D", "getetag", Dav1, entry.ETag);
            xml.WriteElementString("D", "getcontenttype", Dav1, "application/octet-stream");
        }

        xml.WriteEndElement();
        xml.WriteElementString("D", "status", Dav1, "HTTP/1.1 200 OK");
        xml.WriteEndElement();
        xml.WriteEndElement();
    }

    private static async Task GetAsync(HttpContext context, Resolution at, bool body)
    {
        var entry = Tree.Stat(at, Name(context.Request.Path.Value ?? "/"));

        if (entry is null || at.ReadPath is null)
        {
            context.Response.StatusCode = (int)HttpStatusCode.NotFound;
            return;
        }

        if (entry.IsDirectory)
        {
            context.Response.StatusCode = (int)HttpStatusCode.MethodNotAllowed;
            return;
        }

        // Opened with FileShare.ReadWrite: the file being read is one the
        // workstation's own tool is writing — that is the point of it — and
        // taking an exclusive read would make envmux the reason Claude Code
        // could not save its own credential.
        await using var file = new FileStream(
            at.ReadPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete,
            bufferSize: 64 * 1024, useAsync: true);

        var length = file.Length;
        var (offset, count) = Range(context.Request.Headers.Range.ToString(), length);

        context.Response.Headers[HeaderNames.ETag] = entry.ETag;
        context.Response.Headers[HeaderNames.LastModified] =
            entry.Modified.UtcDateTime.ToString("R", CultureInfo.InvariantCulture);
        context.Response.Headers[HeaderNames.AcceptRanges] = "bytes";
        context.Response.ContentType = "application/octet-stream";
        context.Response.ContentLength = count;

        if (offset > 0 || count != length)
        {
            context.Response.StatusCode = (int)HttpStatusCode.PartialContent;
            context.Response.Headers[HeaderNames.ContentRange] = $"bytes {offset}-{offset + count - 1}/{length}";
        }

        if (!body || count == 0)
        {
            return;
        }

        file.Seek(offset, SeekOrigin.Begin);
        await CopyAsync(file, context.Response.Body, count, context.RequestAborted).ConfigureAwait(false);
    }

    /// <summary>
    /// The single byte range a client asked for, clamped to the file.
    /// </summary>
    /// <remarks>
    /// One range, because that is what a FUSE read is: a page at an offset.
    /// Multipart ranges are a browser feature and no filesystem client sends
    /// them.
    /// </remarks>
    private static (long Offset, long Count) Range(string header, long length)
    {
        if (!header.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
        {
            return (0, length);
        }

        var spec = header[6..].Split(',')[0].Trim();
        var dash = spec.IndexOf('-', StringComparison.Ordinal);

        if (dash < 0)
        {
            return (0, length);
        }

        var from = spec[..dash];
        var to = spec[(dash + 1)..];

        if (from.Length == 0)
        {
            // "-500": the last 500 bytes.
            return long.TryParse(to, CultureInfo.InvariantCulture, out var tail) && tail > 0
                ? (Math.Max(0, length - tail), Math.Min(tail, length))
                : (0, length);
        }

        if (!long.TryParse(from, CultureInfo.InvariantCulture, out var start) || start >= length)
        {
            return (0, length);
        }

        var end = long.TryParse(to, CultureInfo.InvariantCulture, out var stop)
            ? Math.Min(stop, length - 1)
            : length - 1;

        return (start, Math.Max(0, end - start + 1));
    }

    private static async Task CopyAsync(Stream from, Stream to, long count, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];

        while (count > 0)
        {
            var read = await from.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, count)), ct)
                .ConfigureAwait(false);

            if (read == 0)
            {
                return;
            }

            await to.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
            count -= read;
        }
    }

    private static async Task PutAsync(HttpContext context, Resolution at)
    {
        if (!Writable(context, at))
        {
            return;
        }

        var path = at.HostPath!;
        var directory = Path.GetDirectoryName(path);

        if (directory is not null)
        {
            Directory.CreateDirectory(directory);
        }

        var existed = File.Exists(path);

        // Written beside and renamed over, so a reader on this workstation never
        // sees a half-written credential. The temporary name carries the
        // process id because two sessions can be writing the same overlay path.
        var temporary = $"{path}.envmux-{Environment.ProcessId:x}";

        await using (var file = new FileStream(
            temporary, FileMode.Create, FileAccess.Write, FileShare.None,
            bufferSize: 64 * 1024, useAsync: true))
        {
            await context.Request.Body.CopyToAsync(file, context.RequestAborted).ConfigureAwait(false);
        }

        File.Move(temporary, path, overwrite: true);

        context.Response.StatusCode = existed ? (int)HttpStatusCode.NoContent : (int)HttpStatusCode.Created;
    }

    private static void Delete(HttpContext context, Resolution at)
    {
        if (!Writable(context, at))
        {
            return;
        }

        var path = at.HostPath!;

        if (Directory.Exists(path))
        {
            Directory.Delete(path, recursive: true);
        }
        else if (File.Exists(path))
        {
            File.Delete(path);
        }
        else
        {
            context.Response.StatusCode = (int)HttpStatusCode.NotFound;
            return;
        }

        context.Response.StatusCode = (int)HttpStatusCode.NoContent;
    }

    private static void Mkcol(HttpContext context, Resolution at)
    {
        if (!Writable(context, at))
        {
            return;
        }

        if (Directory.Exists(at.HostPath) || File.Exists(at.HostPath))
        {
            context.Response.StatusCode = (int)HttpStatusCode.MethodNotAllowed;
            return;
        }

        Directory.CreateDirectory(at.HostPath!);
        context.Response.StatusCode = (int)HttpStatusCode.Created;
    }

    private void Transfer(HttpContext context, Resolution at, Scope scope)
    {
        if (!Writable(context, at))
        {
            return;
        }

        var destination = context.Request.Headers["Destination"].ToString();

        if (destination.Length == 0)
        {
            context.Response.StatusCode = (int)HttpStatusCode.BadRequest;
            return;
        }

        // The header is an absolute URI on this endpoint; only its path matters.
        var target = tree.Resolve(Uri.UnescapeDataString(
            Uri.TryCreate(destination, UriKind.Absolute, out var uri) ? uri.AbsolutePath : destination));

        if (!scope.Allows(target.Namespace?.Name, target.Relative) ||
            target.Route is not (Route.Live or Route.Shadow or Route.Overlay) || target.HostPath is null)
        {
            context.Response.StatusCode = (int)HttpStatusCode.Forbidden;
            return;
        }

        var directory = Path.GetDirectoryName(target.HostPath);

        if (directory is not null)
        {
            Directory.CreateDirectory(directory);
        }

        var existed = File.Exists(target.HostPath) || Directory.Exists(target.HostPath);
        var move = context.Request.Method.Equals("MOVE", StringComparison.OrdinalIgnoreCase);

        var source = at.ReadPath;

        if (Directory.Exists(source))
        {
            if (!move)
            {
                context.Response.StatusCode = (int)HttpStatusCode.NotImplemented;
                return;
            }

            Directory.Move(source, target.HostPath);
        }
        else if (File.Exists(source))
        {
            // A MOVE whose source is the workstation's copy of a shadowed file is
            // a copy: the session may take what it was given, and may not take it
            // away from the workstation.
            if (move && source == at.HostPath)
            {
                File.Move(source, target.HostPath, overwrite: true);
            }
            else
            {
                File.Copy(source, target.HostPath, overwrite: true);
            }
        }
        else
        {
            context.Response.StatusCode = (int)HttpStatusCode.NotFound;
            return;
        }

        context.Response.StatusCode = existed ? (int)HttpStatusCode.NoContent : (int)HttpStatusCode.Created;
    }

    /// <summary>
    /// Whether this path may be written, answering the request if not.
    /// </summary>
    /// <remarks>
    /// A placeholder is the guest's own mount point and a write to it means the
    /// bind mount is not there — which is a broken session, not a file to
    /// create on the workstation.
    /// </remarks>
    private static bool Writable(HttpContext context, Resolution at)
    {
        if (at.Route is (Route.Live or Route.Shadow or Route.Overlay) && at.HostPath is not null)
        {
            return true;
        }

        context.Response.StatusCode = (int)HttpStatusCode.Forbidden;
        return false;
    }

    private static string Name(string path)
    {
        var trimmed = path.TrimEnd('/');
        var slash = trimmed.LastIndexOf('/');
        return slash < 0 ? trimmed : trimmed[(slash + 1)..];
    }

    private static string Href(string path, bool directory)
    {
        var parts = path.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        var joined = "/" + string.Join('/', parts.Select(Uri.EscapeDataString));

        return directory && joined.Length > 1 ? joined + "/" : directory ? "/" : joined;
    }
}
