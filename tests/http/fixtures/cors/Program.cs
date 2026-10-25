using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Server.Configuration;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Configuration;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

var input = File.ReadAllBytes(args[0]);
var configuration = new ServerConfiguration();
var manager = Stub.Create<IServerConfigurationManager, Stub>();
((Stub)(object)manager).Configuration = configuration;
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders();
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddCors();
builder.Services.AddSingleton(manager);
builder.Services.AddTransient<ICorsPolicyProvider, CorsPolicyProvider>();
await using var app = builder.Build();
app.Map("/media", branch => {
    branch.UseCors();
    // CORS runs before the endpoint/authentication boundary. These terminals
    // isolate middleware effects without creating a database or replacing CORS.
    branch.Run(context => {
        context.Response.StatusCode = context.Request.Path.Value switch {
            "/System/Ping" => context.Request.Method is "GET" or "POST" ? 200 : 405,
            "/ScheduledTasks" => 401,
            _ => 404
        };
        return Task.CompletedTask;
    });
});
await app.StartAsync();
var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var results = new List<object>();
using var client = new HttpClient();
try {
    foreach (var row in JsonDocument.Parse(input).RootElement.EnumerateArray()) {
        configuration.CorsHosts = row.TryGetProperty("hosts", out var hosts) ? hosts.Deserialize<string[]>()! : ["*"];
        using var request = new HttpRequestMessage(new HttpMethod(row.GetProperty("method").GetString()!), address + row.GetProperty("path").GetString());
        foreach (var header in row.GetProperty("headers").EnumerateObject()) request.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString());
        using var response = await client.SendAsync(request);
        await response.Content.ReadAsByteArrayAsync();
        var headers = response.Headers.Where(header => header.Key.StartsWith("Access-Control-", StringComparison.OrdinalIgnoreCase) || header.Key.Equals("Vary", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(header => header.Key.ToLowerInvariant(), header => string.Join(",", header.Value));
        results.Add(new { name = row.GetProperty("name").GetString(), status = (int)response.StatusCode, headers });
    }
} finally { await app.StopAsync(); }
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.GetName().Name).Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location,
        sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualExecution = true, inputSha256 = Convert.ToHexStringLower(SHA256.HashData(input)),
    results, assemblies }, new JsonSerializerOptions { WriteIndented = true }));

public class Stub : DispatchProxy {
    public ServerConfiguration Configuration = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => method!.Name == "get_Configuration"
        ? Configuration : throw new NotSupportedException(method.Name);
}
