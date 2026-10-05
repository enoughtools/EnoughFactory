using System.Security.Cryptography;

namespace Envmux.Session;

/// <summary>
/// Values envmux makes up once per session — passwords, tokens, identifiers.
/// </summary>
/// <remarks>
/// <para>
/// A generated value exists for the life of one process and is never written
/// down. That is the whole design being consistent with itself: there is no
/// state directory to persist a password into, and a secret on disk would be the
/// first durable thing envmux owned.
/// </para>
/// <para>
/// The consequence is that a service's data does not outlive its password. If
/// you want a database you can come back to, set the password explicitly in the
/// config and give the service a volume — see <c>persist</c>.
/// </para>
/// </remarks>
internal static class Generated
{
    /// <summary>Characters a password is drawn from.</summary>
    /// <remarks>
    /// No quotes, backslashes, dollars, or backticks. This value travels through
    /// a connection string, a shell, a YAML file somebody pastes it into, and a
    /// URL — and the characters that break each of those are not worth the
    /// entropy they add when length is free.
    /// </remarks>
    private const string PasswordAlphabet =
        "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_";

    public const int DefaultPasswordLength = 32;
    public const int DefaultTokenLength = 48;

    /// <summary>What a <c>generate</c> entry can ask for.</summary>
    public static readonly string[] Kinds = ["password", "token", "uuid", "hex"];

    public static string Password(int length = DefaultPasswordLength) =>
        RandomNonEmpty(PasswordAlphabet, length);

    /// <summary>A URL-safe token, for API keys and session secrets.</summary>
    public static string Token(int length = DefaultTokenLength) =>
        RandomNonEmpty("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_", length);

    public static string Hex(int length = 32) =>
        RandomNonEmpty("0123456789abcdef", length);

    public static string Uuid() => Guid.NewGuid().ToString();

    /// <summary>
    /// Produce a value of the named kind.
    /// </summary>
    /// <exception cref="Config.ConfigException">The kind is not one envmux knows.</exception>
    public static string Of(string kind, int? length)
    {
        return kind.ToLowerInvariant() switch
        {
            "password" => Password(length ?? DefaultPasswordLength),
            "token" => Token(length ?? DefaultTokenLength),
            "hex" => Hex(length ?? 32),
            "uuid" => Uuid(),
            _ => throw new Config.ConfigException(
                $"'{kind}' is not something envmux can generate — try {string.Join(", ", Kinds)}"),
        };
    }

    private static string RandomNonEmpty(string alphabet, int length)
    {
        if (length < 1)
        {
            throw new Config.ConfigException($"a generated value cannot be {length} characters long");
        }

        // RandomNumberGenerator rather than Random: these are passwords, and the
        // cost of getting it right here is one method name.
        return RandomNumberGenerator.GetString(alphabet, length);
    }
}
