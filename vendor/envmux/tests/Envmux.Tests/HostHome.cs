namespace Envmux.Tests;

/// <summary>
/// The tests that move <c>ENVMUX_HOME</c>, which is one variable for the whole
/// process.
/// </summary>
/// <remarks>
/// <para>
/// Two of them exist and they want opposite things: one points it at a
/// temporary directory and writes a <c>host.json</c> there, the other clears it
/// and asserts that the default is <c>~/.envmux</c>. Run in parallel they
/// interleave, and the failure is not merely a red test — a clear landing
/// between the other's set and its save writes a <c>host.json</c> into the
/// developer's <em>real</em> home directory, over whatever host they had
/// configured.
/// </para>
/// <para>
/// So they take turns. This is the same shape as the collection that used to
/// serialise container tests against the one Docker engine on the machine, and
/// it is here for the same reason: some state belongs to the machine rather than
/// to the test.
/// </para>
/// </remarks>
[CollectionDefinition(Name, DisableParallelization = true)]
public class HostHome
{
    public const string Name = "one ENVMUX_HOME at a time";
}
