using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Envmux.Serialization;

/// <summary>The closed set of JSON contracts envmux reads and writes.</summary>
/// <remarks>
/// Reflection is disabled in every build, so missing wire types fail in tests
/// rather than only after native publishing. Each caller retains its own naming,
/// null and strictness policies; generated metadata supplies the shape only.
/// </remarks>
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Metadata)]
[JsonSerializable(typeof(Config.SessionConfig))]
[JsonSerializable(typeof(Host.HostConfig))]
[JsonSerializable(typeof(Host.IncusOsIndex.Index))]
[JsonSerializable(typeof(Agents.AgentRecord))]
[JsonSerializable(typeof(List<Agents.AgentRecord>))]
[JsonSerializable(typeof(Agents.ChatLine))]
[JsonSerializable(typeof(Portal.PortalState))]
[JsonSerializable(typeof(Portal.PortalHost.AgentRequest))]
[JsonSerializable(typeof(Docker.ShimState))]
[JsonSerializable(typeof(Docker.ContainerCreateRequest))]
[JsonSerializable(typeof(Docker.ExecCreateRequest))]
[JsonSerializable(typeof(Docker.ExecStartRequest))]
[JsonSerializable(typeof(Docker.VolumeCreateRequest))]
[JsonSerializable(typeof(Incus.ServerInfo))]
[JsonSerializable(typeof(Incus.IncusOperation))]
[JsonSerializable(typeof(Incus.Instance))]
[JsonSerializable(typeof(List<Incus.Instance>))]
[JsonSerializable(typeof(Incus.InstanceState))]
[JsonSerializable(typeof(Incus.IncusNetworkInfo))]
[JsonSerializable(typeof(List<Incus.NetworkLease>))]
[JsonSerializable(typeof(Incus.InstancesPost))]
[JsonSerializable(typeof(Incus.InstanceStatePut))]
[JsonSerializable(typeof(Incus.ExecPost))]
[JsonSerializable(typeof(Incus.ExecControl))]
[JsonSerializable(typeof(Incus.SnapshotsPost))]
[JsonSerializable(typeof(Incus.NetworksPost))]
[JsonSerializable(typeof(Incus.CertificatesPost))]
[JsonSerializable(typeof(Host.InstallSeed))]
[JsonSerializable(typeof(Host.NetworkSeed))]
[JsonSerializable(typeof(Host.KernelSeed))]
[JsonSerializable(typeof(Host.IncusSeed))]
[JsonSerializable(typeof(Editor.DockerUri.Authority))]
[JsonSerializable(typeof(JsonNode))]
[JsonSerializable(typeof(JsonElement))]
[JsonSerializable(typeof(string))]
[JsonSerializable(typeof(bool))]
[JsonSerializable(typeof(int))]
[JsonSerializable(typeof(uint))]
[JsonSerializable(typeof(long))]
[JsonSerializable(typeof(double))]
[JsonSerializable(typeof(List<string>))]
internal sealed partial class WireJsonContext : JsonSerializerContext;
