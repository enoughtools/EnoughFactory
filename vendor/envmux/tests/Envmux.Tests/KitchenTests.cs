using System.Net;
using System.Net.Http.Headers;

using Envmux.Agents;
using Envmux.Backends;
using Envmux.Config;
using Envmux.Portal;

namespace Envmux.Tests;

public sealed class KitchenTests
{
    [Fact]
    public async Task ChefCapabilityCannotOpenTheHostShellAndWorkersCannotDispatch()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"envmux-kitchen-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var config = new SessionConfig { Name = "kitchen", Chef = true };
            await using var chef = new Session.Session(Session.SessionPlan.Resolve(config, directory, "chef"));
            await using var portal = new PortalListener(chef);
            await portal.StartAsync(PortSpec.Range(46000, 46100), IPAddress.Loopback);
            using var http = new HttpClient();
            var bridge = Assert.IsType<IPEndPoint>(portal.Bridge);

            async Task<HttpStatusCode> Get(string path, string token)
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{bridge.Port}{path}");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                using var response = await http.SendAsync(request);
                return response.StatusCode;
            }

            Assert.Equal(HttpStatusCode.OK, await Get("/api/kitchen/agents", chef.ChefToken));
            Assert.Equal(HttpStatusCode.Unauthorized, await Get("/api/kitchen/agents", chef.Plan.Portal.Token));
            Assert.Equal(HttpStatusCode.Unauthorized, await Get("/api/kitchen/agents", chef.Plan.Portal.RoomToken));
            Assert.Equal(HttpStatusCode.NotFound, await Get("/api/shell", chef.ChefToken));
            Assert.Equal(HttpStatusCode.NotFound, await Get("/api/state", chef.ChefToken));
            var worker = Session.SessionPlan.Resolve(config, directory, "worker");
            Assert.False(worker.Chef);
            Assert.True(chef.Plan.Chef);
            using var hostRequest = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{portal.Port}/api/agents");
            hostRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", chef.Plan.Portal.RoomToken);
            using var hostResponse = await http.SendAsync(hostRequest);
            Assert.Equal(HttpStatusCode.Unauthorized, hostResponse.StatusCode);
            Assert.NotEqual(chef.Plan.Portal.Token, chef.Plan.Portal.RoomToken);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void DispatchPreservesBackendAndRefusesAFourthWorker()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"envmux-dispatch-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            for (var i = 0; i < 3; i++)
            {
                var plan = Session.SessionPlan.Resolve(new SessionConfig(), directory, $"worker-{i}")
                    with
                { Backend = BackendKind.Docker };
                var record = AgentRegistry.Start(directory, plan, "bounded task", spawn: (_, _) => Environment.ProcessId,
                    maximumActive: 3);
                Assert.Equal(BackendKind.Docker, AgentRegistry.Load(directory, record.Name)!.Backend);
            }

            var fourth = Session.SessionPlan.Resolve(new SessionConfig(), directory, "worker-four");
            Assert.Throws<AgentException>(() => AgentRegistry.Start(directory, fourth, "task",
                spawn: (_, _) => throw new InvalidOperationException("must not spawn"), maximumActive: 3));
            Assert.False(File.Exists(AgentRegistry.PromptPath(directory, fourth.Session)));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
