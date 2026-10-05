namespace Envmux.Backends;

/// <summary>A backend could not do what a session asked of it.</summary>
/// <remarks>
/// Not sealed, unlike every other exception here: each backend's own type derives from it, so the
/// session catches one thing whatever it runs on.
/// </remarks>
internal class BackendException(string message, Exception? inner = null) : Exception(message, inner);
