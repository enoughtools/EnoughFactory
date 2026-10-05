using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using Envmux.Config;

namespace Envmux.Incus;

/// <summary>One dev container feature, resolved from how it was written down.</summary>
/// <param name="Registry">The host it comes from, e.g. <c>ghcr.io</c>.</param>
/// <param name="Repository">The path within it, e.g. <c>devcontainers/features/node</c>.</param>
/// <param name="Tag">The version, e.g. <c>1</c>. Defaults to <c>latest</c>.</param>
/// <param name="Options">Option name to value, passed to install.sh as environment.</param>
internal sealed record Feature(
    string Registry,
    string Repository,
    string Tag,
    IReadOnlyDictionary<string, string> Options)
{
    /// <summary>How it was written, and how it is said back.</summary>
    public string Reference => $"{Registry}/{Repository}:{Tag}";

    /// <summary>The last path segment, which is what a person calls it.</summary>
    public string Name => Repository[(Repository.LastIndexOf('/') + 1)..];
}

/// <summary>
/// Dev container features, fetched and installed into an instance.
/// </summary>
/// <remarks>
/// <para>
/// The point of this is that a project's toolchain is already written down. Most
/// repositories that need .NET and Bun and a browser have a
/// <c>devcontainer.json</c> saying so, and re-deriving that as a list of
/// <c>apt-get</c> lines is work with a wrong answer at the end of it. So envmux
/// takes the features as they are.
/// </para>
/// <para>
/// A feature is an OCI artifact: one layer, a plain tar — <em>not</em> a gzip,
/// whatever the habit of the extension suggests, and <c>tar -xzf</c> fails on it
/// with "not in gzip format" — containing <c>install.sh</c> and
/// <c>devcontainer-feature.json</c>. Fetching it needs an anonymous pull token
/// and two requests, which is why this needs no tooling in the image beyond
/// curl and tar.
/// </para>
/// <para>
/// Installed in the order they are declared. The specification has an
/// <c>installsAfter</c> field for ordering, and in practice it almost always
/// names <c>common-utils</c>, which the base already has — so honouring the
/// written order is both simpler and what the person editing the file expects.
/// </para>
/// </remarks>
internal static class Features
{
    /// <summary>Where a feature is unpacked while it installs.</summary>
    private const string WorkDirectory = "/tmp/envmux-feature";

    /// <summary>
    /// Read the features as <c>devcontainer.json</c> spells them.
    /// </summary>
    /// <remarks>
    /// The key is a full OCI reference — <c>ghcr.io/devcontainers/features/node:1</c>
    /// — because that is what a devcontainer.json contains and the whole point is
    /// that the block can be copied across unedited.
    /// </remarks>
    public static IReadOnlyList<Feature> Resolve(IReadOnlyDictionary<string, FeatureConfig>? declared)
    {
        if (declared is null || declared.Count == 0)
        {
            return [];
        }

        var features = new List<Feature>();

        foreach (var (reference, config) in declared)
        {
            var text = reference.Trim();

            if (text.Length == 0)
            {
                continue;
            }

            // The tag is after the last colon, but only when that colon is in
            // the last segment — a registry with a port in it has one earlier.
            var tag = "latest";
            var lastSlash = text.LastIndexOf('/');
            var colon = text.LastIndexOf(':');

            if (colon > lastSlash)
            {
                tag = text[(colon + 1)..];
                text = text[..colon];
            }

            var firstSlash = text.IndexOf('/', StringComparison.Ordinal);

            if (firstSlash <= 0)
            {
                throw new ConfigException(
                    $"'{reference}' is not a feature reference. It looks like " +
                    "\"ghcr.io/devcontainers/features/node:1\".");
            }

            features.Add(new Feature(
                text[..firstSlash],
                text[(firstSlash + 1)..],
                tag,
                config?.Options ?? new Dictionary<string, string>(StringComparer.Ordinal)));
        }

        return features;
    }

    /// <summary>
    /// A name for the image these features and this base produce.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Over the declaration, so the image and the config it came from cannot
    /// drift apart. Add a feature, change a version, and the fingerprint changes
    /// and the next session builds a new image rather than quietly using the old
    /// one — which is the failure this exists to prevent, because a stale
    /// toolchain presents as a build error in the project rather than as
    /// anything to do with envmux.
    /// </para>
    /// <para>
    /// The declaration, and not what it resolves to. <c>node:1</c> is a floating
    /// tag: republish it upstream with a newer node and this hash does not move,
    /// so the existing image is reused. That is the right default — a build that
    /// changed under you without the config changing is worse than one that is a
    /// few weeks old — but it does mean "rebuild against whatever is current
    /// now" is a thing you ask for rather than something that happens. The way
    /// to ask is <c>envmux prune</c>, which removes an image nothing is built
    /// on; the next session finds none and builds one.
    /// </para>
    /// <para>
    /// Short, because it becomes part of an instance name and those are read by
    /// people. Eight hex characters over a list this small is not a collision
    /// anyone will meet.
    /// </para>
    /// </remarks>
    public static string Fingerprint(string baseImage, IReadOnlyList<Feature> features)
    {
        var text = new StringBuilder();
        text.Append(baseImage).Append('\n');

        foreach (var feature in features)
        {
            text.Append(feature.Reference);

            // Sorted, because two configs that differ only in the order options
            // were typed are the same image.
            foreach (var (name, value) in feature.Options.OrderBy(o => o.Key, StringComparer.Ordinal))
            {
                text.Append(' ').Append(name).Append('=').Append(value);
            }

            text.Append('\n');
        }

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString()));
        return Convert.ToHexStringLower(hash)[..8];
    }

    /// <summary>
    /// The script that installs one feature, as root, in the instance.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Options become environment variables named after them, uppercased, which
    /// is what the specification says and what every feature's install.sh reads.
    /// <c>_REMOTE_USER</c> and <c>_CONTAINER_USER</c> come with them: features
    /// that install something per-user — nvm, sdkman, a shell config — put it in
    /// that account's home, and without them they put it in root's, where the
    /// session never looks.
    /// </para>
    /// <para>
    /// Every option the feature declares is exported, not only the ones the
    /// config set. This is the specification's rule and it is not optional: an
    /// install.sh does not supply its own defaults, so <c>dotnet:2</c> given
    /// only a version ran <c>dotnet-install.sh --install-dir</c> with nothing
    /// after it, and failed on <c>mkdir: cannot create directory ''</c> —
    /// a message about an empty string, several layers below the option nobody
    /// set.
    /// </para>
    /// <para>
    /// <c>containerEnv</c> is set twice: exported before <c>install.sh</c>, and
    /// written to <c>/etc/profile.d</c> after it. The second is the obvious one
    /// — a feature that installs nvm expects <c>NVM_DIR</c> and a <c>PATH</c>
    /// entry to exist for every shell afterwards, and without them what it
    /// installed is present and not findable.
    /// </para>
    /// <para>
    /// The first is the one that is easy to miss. <c>dotnet</c> declares
    /// <c>DOTNET_ROOT</c> in its own <c>containerEnv</c> and its install script
    /// then runs <c>--install-dir "$DOTNET_ROOT"</c>: a feature reads its own
    /// declared environment during its own installation. In declaration order,
    /// because they refer to each other — <c>PATH</c> is <c>$PATH:$DOTNET_ROOT</c>.
    /// </para>
    /// </remarks>
    /// <param name="feature">What to install.</param>
    /// <param name="user">The account the session runs as.</param>
    /// <param name="metadata">What the feature declares about itself, if it could be read.</param>
    public static string InstallScript(Feature feature, string user, FeatureMetadata? metadata = null)
    {
        var script = new StringBuilder();

        script.Line("set -eu");
        script.Line();

        // What the features before this one left behind. A toolchain is
        // installed in order and the later parts assume the earlier ones are on
        // the PATH — a feature that runs `dotnet tool install` needs the dotnet
        // feature's DOTNET_ROOT, and a login shell is not what is running here.
        script.Line("for earlier in /etc/profile.d/envmux-feature-*.sh; do");
        script.Line("  [ -f \"$earlier\" ] && . \"$earlier\"");
        script.Line("done");
        script.Line();

        script.Line($"repo={Quote(feature.Repository)}");
        script.Line($"registry={Quote(feature.Registry)}");
        script.Line($"tag={Quote(feature.Tag)}");
        script.Line();

        script.Line("token=$(curl -fsSL " +
                    "\"https://${registry}/token?scope=repository:${repo}:pull&service=${registry}\" " +
                    "| sed -n 's/.*\"token\":\"\\([^\"]*\\)\".*/\\1/p')");
        script.Line();

        script.Line("manifest=$(curl -fsSL -H \"Authorization: Bearer $token\" \\");
        script.Line("  -H \"Accept: application/vnd.oci.image.manifest.v1+json\" \\");
        script.Line("  \"https://${registry}/v2/${repo}/manifests/${tag}\")");
        script.Line();

        script.Line("digest=$(printf '%s' \"$manifest\" | " +
                    "sed -n 's/.*\"layers\":\\[{[^}]*\"digest\":\"\\([^\"]*\\)\".*/\\1/p')");
        script.Line();

        script.Line("if [ -z \"$digest\" ]; then");
        script.Line($"  echo \"{feature.Reference} has no layer to install; is the reference right?\" >&2");
        script.Line("  exit 1");
        script.Line("fi");
        script.Line();

        // Emptied rather than removed and remade, so a bind mount or a running
        // process holding the directory does not turn into a failure here.
        script.Line($"work={WorkDirectory}");
        script.Line("find \"$work\" -mindepth 1 -delete 2>/dev/null || true");
        script.Line("mkdir -p \"$work\"");
        script.Line();

        script.Line("curl -fsSL -H \"Authorization: Bearer $token\" \\");
        script.Line("  \"https://${registry}/v2/${repo}/blobs/${digest}\" -o \"$work/feature.tar\"");
        script.Line();

        // A plain tar. The media type is
        // application/vnd.devcontainers.layer.v1+tar with no +gzip, so -xzf
        // fails on it with "not in gzip format"; -xf reads either.
        script.Line("tar -xf \"$work/feature.tar\" -C \"$work\"");
        script.Line("cd \"$work\"");
        script.Line("chmod +x install.sh");
        script.Line();

        // The feature's own defaults first, then what the config said, so a
        // declared option overrides a default and an undeclared one still has a
        // value.
        var options = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var (name, value) in metadata?.Defaults ?? EmptyOptions)
        {
            options[name] = value;
        }

        foreach (var (name, value) in feature.Options)
        {
            options[name] = value;
        }

        foreach (var (name, value) in options.OrderBy(o => o.Key, StringComparer.Ordinal))
        {
            script.Line($"export {Variable(name)}={Quote(value)}");
        }

        script.Line($"export _REMOTE_USER={Quote(user)}");
        script.Line($"export _CONTAINER_USER={Quote(user)}");
        script.Line("export DEBIAN_FRONTEND=noninteractive");
        script.Line();

        var environment = metadata?.ContainerEnv ?? EmptyEnvironment;

        if (environment.Count > 0)
        {
            // The feature's own containerEnv, set before its own install.sh, and
            // this is not a nicety. dotnet declares DOTNET_ROOT there and its
            // install script runs `--install-dir "$DOTNET_ROOT"` — so without
            // this it installs into the empty string and dies on
            // `mkdir: cannot create directory ''`, naming neither the variable
            // nor the feature.
            //
            // In declaration order, because they refer to each other: PATH is
            // "$PATH:$DOTNET_ROOT", which is nothing useful if PATH is set
            // first.
            foreach (var (name, value) in environment)
            {
                script.Line($"export {name}=\"{value}\"");
            }

            script.Line();
        }

        script.Line("./install.sh");

        if (environment.Count > 0)
        {
            // And again for every shell afterwards. A profile script rather than
            // an export, because the install is over and what needs this is the
            // next login — a task, a shell, an editor over ssh.
            script.Line();
            script.Line("mkdir -p /etc/profile.d");
            script.Line($"profile=/etc/profile.d/envmux-feature-{Slug(feature.Name)}.sh");
            script.Line(": > \"$profile\"");

            // A quoted heredoc, so the ${PATH} a feature wrote stays a reference
            // for the shell that reads the profile rather than being expanded
            // now — which would bake in the PATH of an install script.
            script.Line("cat >> \"$profile\" <<'ENVMUX_FEATURE_ENV'");

            foreach (var (name, value) in environment)
            {
                script.Line($"export {name}=\"{value}\"");
            }

            script.Line("ENVMUX_FEATURE_ENV");
            script.Line("chmod 0644 \"$profile\"");
        }

        return script.ToString();
    }

    /// <summary>Nothing, without allocating a new nothing each time.</summary>
    private static readonly Dictionary<string, string> EmptyOptions = new(StringComparer.Ordinal);

    /// <summary>The same, for a feature that declares no environment.</summary>
    private static readonly List<KeyValuePair<string, string>> EmptyEnvironment = [];

    /// <summary>A feature's name, safe for a filename.</summary>
    private static string Slug(string name)
    {
        var slug = new StringBuilder(name.Length);

        foreach (var c in name)
        {
            slug.Append(char.IsAsciiLetterOrDigit(c) ? char.ToLowerInvariant(c) : '-');
        }

        return slug.ToString();
    }

    /// <summary>
    /// An option name as the environment variable a feature reads.
    /// </summary>
    /// <remarks>
    /// Uppercased, which is all the specification asks for. Anything that is not
    /// a letter or a digit becomes an underscore, because an option written in
    /// kebab-case would otherwise produce a variable name no shell can export.
    /// </remarks>
    internal static string Variable(string option)
    {
        var name = new StringBuilder(option.Length);

        foreach (var c in option)
        {
            name.Append(char.IsAsciiLetterOrDigit(c) ? char.ToUpperInvariant(c) : '_');
        }

        return name.ToString();
    }

    /// <summary>Single-quoted for a shell, with the one escape that needs.</summary>
    private static string Quote(string value) =>
        "'" + value.Replace("'", "'\\''", StringComparison.Ordinal) + "'";

    /// <summary>How this reads in a log line.</summary>
    public static string Describe(IReadOnlyList<Feature> features) =>
        features.Count == 0
            ? "no features"
            : string.Join(", ", features.Select(f =>
                f.Options.TryGetValue("version", out var v) && v.Length > 0
                    ? $"{f.Name} {v}"
                    : f.Name));

    /// <summary>How long a toolchain is given to install before it is called stuck.</summary>
    /// <remarks>
    /// Generous. A .NET SDK, a browser and a JavaScript runtime is a real
    /// download on a real connection, and this only ever runs once per project
    /// image — so the cost of waiting too long is far below the cost of giving
    /// up on something that was working.
    /// </remarks>
    public static readonly TimeSpan Deadline = TimeSpan.FromMinutes(30);

    /// <summary>The count, said the way a log line wants it.</summary>
    public static string Count(int n) =>
        n == 1 ? "1 feature" : $"{n.ToString(CultureInfo.InvariantCulture)} features";
}
