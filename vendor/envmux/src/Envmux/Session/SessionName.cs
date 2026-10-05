using Envmux.Config;

namespace Envmux.Session;

/// <summary>
/// The one name a session is known by — its worktree directory, its branch, its
/// container, and the middle label of its hostnames.
/// </summary>
/// <remarks>
/// One identity for all four, so nothing has to be correlated by hand across
/// four sessions running in the same directory.
/// </remarks>
internal static class SessionName
{
    private static readonly string[] Adjectives =
    [
        "amber", "brisk", "chrome", "dusk", "ember", "flux", "glass", "halcyon",
        "indigo", "jade", "kinetic", "lucid", "mauve", "neon", "onyx", "prism",
        "quartz", "rogue", "solar", "tidal", "umbra", "vivid", "warp", "xenon",
    ];

    private static readonly string[] Nouns =
    [
        "otter", "falcon", "lynx", "heron", "vixen", "marten", "raven", "shrike",
        "tapir", "ibex", "gecko", "osprey", "badger", "cormorant", "jackal",
        "kestrel", "narwhal", "pangolin", "quokka", "serval", "tanager", "wombat",
    ];

    /// <summary>
    /// A generated name, in the shape a person can read back over the phone.
    /// </summary>
    /// <remarks>
    /// Two words rather than a hash because the name ends up in a hostname, a
    /// branch, and a directory a human has to recognise later. Collisions are
    /// possible and handled by the caller checking whether the worktree already
    /// exists — 528 combinations is plenty against four concurrent sessions and
    /// not worth a uniqueness mechanism.
    /// </remarks>
    public static string Generate()
    {
        var adjective = Adjectives[Random.Shared.Next(Adjectives.Length)];
        var noun = Nouns[Random.Shared.Next(Nouns.Length)];
        return $"{adjective}-{noun}";
    }

    /// <summary>
    /// Clean a name the user supplied, or generate one when they did not.
    /// </summary>
    public static string Resolve(string? requested) =>
        string.IsNullOrWhiteSpace(requested) ? Generate() : Slug.From(requested);

    /// <summary>The branch a session's worktree is checked out on.</summary>
    public static string Branch(string prefix, string session) => $"{prefix}{session}";
}
