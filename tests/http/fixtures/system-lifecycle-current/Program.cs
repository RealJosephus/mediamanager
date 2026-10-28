using System.Net;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Emby.Server.Implementations;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Extensions.Json;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Common.Updates;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.SyncPlay;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using AuthenticationSchemes = Jellyfin.Api.Constants.AuthenticationSchemes;

var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
var observations = new List<object>();
foreach (var sample in input.GetProperty("requests").EnumerateArray()) {
    var remote = IPAddress.Parse(sample.GetProperty("remote").GetString()!); bool restart = false;
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => {
        if (method.Name == "set_ShouldRestart") { restart = (bool)values![0]!; return null; }
        if (method.Name == "get_ShouldRestart") return restart;
        return Stub.Default(method.ReturnType);
    });
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => Stub.Default(method.ReturnType));
    var configuration = new ServerConfiguration { IsStartupWizardCompleted = true };
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name is "get_Configuration" or "get_CommonConfiguration" ? configuration : Stub.Default(method.ReturnType));
    var network = Stub.Make<INetworkManager>((method, values) => method.Name == "IsInLocalNetwork"
        ? values![0] is IPAddress address && (IPAddress.IsLoopback(address) || address.ToString().StartsWith("10.44.0.", StringComparison.Ordinal))
        : Stub.Default(method.ReturnType));
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
    builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0"); builder.Services.AddHttpContextAccessor();
    builder.Services.AddSingleton(appHost); builder.Services.AddSingleton(paths); builder.Services.AddSingleton<IApplicationPaths>(paths);
    builder.Services.AddSingleton(config); builder.Services.AddSingleton<IConfigurationManager>(config); builder.Services.AddSingleton(network);
    builder.Services.AddSingleton(Stub.Make<IFileSystem>((method, _) => Stub.Default(method.ReturnType)));
    builder.Services.AddSingleton(Stub.Make<IUserManager>((method, _) => Stub.Default(method.ReturnType)));
    builder.Services.AddSingleton(Stub.Make<ISyncPlayManager>((method, _) => Stub.Default(method.ReturnType)));
    builder.Services.AddSingleton<ISystemManager>(provider => new SystemManager(provider.GetRequiredService<IHostApplicationLifetime>(), appHost, paths, config,
        Stub.Make<IStartupOptions>((method, _) => Stub.Default(method.ReturnType)),
        Stub.Make<IInstallationManager>((method, _) => Stub.Default(method.ReturnType)),
        Stub.Make<ILibraryManager>((method, _) => Stub.Default(method.ReturnType))));
    builder.Services.AddAuthentication(AuthenticationSchemes.CustomAuthentication)
        .AddScheme<AuthenticationSchemeOptions, IdentityAuthentication>(AuthenticationSchemes.CustomAuthentication, _ => { });
    builder.Services.AddAuthorization(); builder.Services.AddJellyfinApiAuthorization();
    builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlySystemController()));
    var app = builder.Build(); bool actualStop = false, normalOwnerStopped = false, stopped = false, disposed = false; int status; string body; string? contentType, allow;
    try {
        app.Use(async (context, next) => { context.Connection.RemoteIpAddress = remote; await next(); });
        app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
        var stop = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = app.Lifetime.ApplicationStopping.Register(() => stop.TrySetResult());
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        using var client = new HttpClient(); using var request = new HttpRequestMessage(new HttpMethod(sample.GetProperty("method").GetString()!), address + sample.GetProperty("path").GetString());
        request.Headers.TryAddWithoutValidation("X-Identity", sample.GetProperty("identity").GetString()); request.Headers.TryAddWithoutValidation("Accept", "application/json");
        if (sample.TryGetProperty("body", out var payload)) request.Content = new StringContent(payload.GetString()!, Encoding.UTF8, sample.GetProperty("contentType").GetString()!);
        using var response = await client.SendAsync(request); status = (int)response.StatusCode; body = await response.Content.ReadAsStringAsync();
        contentType = response.Content.Headers.ContentType?.ToString(); allow = string.Join(", ", response.Content.Headers.Allow);
        if (status == 204) {
            await stop.Task.WaitAsync(TimeSpan.FromSeconds(15)); actualStop = true;
            // Program.StartServer uses this real host lifetime drain after
            // SystemManager.StopApplication, before disposing its host.
            await app.WaitForShutdownAsync(); normalOwnerStopped = true;
        }
    } finally {
        try { await app.StopAsync(); stopped = true; } finally { await app.DisposeAsync(); disposed = true; }
    }
    observations.Add(new { name = sample.GetProperty("name").GetString(), status, body, contentType, allow = allow == "" ? null : allow,
        actualStop, normalOwnerStopped, requestedRestart = actualStop ? restart : (bool?)null,
        hostStopped = stopped, hostDisposed = disposed, fixtureStopRequired = !normalOwnerStopped });
}
var assemblies = new[] { typeof(SystemController).Assembly, typeof(SystemManager).Assembly }.Distinct().Select(value => new {
    filename = value.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(value.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), actualMvc = true,
    actualSystemController = true, actualSystemManager = true, actualAuthorizationPolicies = true, actualHostLifetime = true,
    controls = "Declared LAN classifier and explicit identity claims; no CLR context or private generation counter comparison.", assemblies, observations },
    new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never }));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class OnlySystemController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var item in feature.Controllers.Where(value => value.AsType() != typeof(SystemController)).ToArray()) feature.Controllers.Remove(item);
    }
}
public class IdentityAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = Request.Headers["X-Identity"].ToString();
        if (identity == "anonymous") return Task.FromResult(AuthenticateResult.NoResult());
        if (identity == "invalid") return Task.FromResult(AuthenticateResult.Fail("Invalid token."));
        var claims = new List<Claim> { new(InternalClaimTypes.UserId, "cf790000000000000000000000000001"), new(InternalClaimTypes.IsApiKey, (identity == "apiKey").ToString()) };
        if (identity is "admin" or "apiKey") claims.Add(new Claim(ClaimTypes.Role, UserRoles.Administrator));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name)), Scheme.Name)));
    }
}
