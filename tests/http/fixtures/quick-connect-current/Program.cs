using System.Collections.Concurrent;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using Emby.Server.Implementations.QuickConnect;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Devices;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.QuickConnect;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.QuickConnect;
using MediaBrowser.Model.Session;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

var bytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(bytes).RootElement;
var capture = new Capture();
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(capture); builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton(capture.Configuration); builder.Services.AddSingleton(capture.Users);
builder.Services.AddSingleton(capture.Network); builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(options => options.AddPolicy("DefaultAuthorization", policy => policy.AddAuthenticationSchemes("fixture").AddRequirements(new DefaultAuthorizationRequirement())));
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(manager => manager.FeatureProviders.Add(new OnlyQuickConnectControllers()));
builder.Services.Replace(ServiceDescriptor.Transient<QuickConnectController>(_ => new QuickConnectController(capture.Manager, capture.Authorization)));
builder.Services.Replace(ServiceDescriptor.Transient<UserController>(_ => new UserController(capture.Users, capture.Sessions, capture.Network,
    Stub.Make<IDeviceManager>((m, a) => Stub.Default(m.ReturnType)), capture.Authorization, capture.Configuration,
    NullLogger<UserController>.Instance, capture.Manager, Stub.Make<IPlaylistManager>((m, a) => Stub.Default(m.ReturnType)))));
var app = builder.Build(); app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers();
await app.StartAsync();
var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var results = new List<object>(); var expiryResults = new List<object>(); using var client = new HttpClient();
async Task<HttpObservation> Send(string method, string path, string? payload = null, string? contentType = null) {
    using var request = new HttpRequestMessage(new HttpMethod(method), address + path);
    request.Headers.TryAddWithoutValidation("Accept", "application/json");
    if (payload != null) {
        request.Content = new StringContent(payload);
        request.Content.Headers.ContentType = new(contentType ?? "application/json");
    }
    using var response = await client.SendAsync(request);
    var body = await response.Content.ReadAsStringAsync();
    JsonElement? json = null; var hasJson = false;
    try { json = JsonSerializer.Deserialize<JsonElement>(body); hasJson = true; } catch (JsonException) { }
    return new((int)response.StatusCode, body, hasJson, json, response.Content.Headers.ContentType?.ToString(),
        string.Join(", ", response.Content.Headers.Allow));
}
async Task<object[]> FollowUp() {
    if (capture.Issued == null) return [];
    var secret = capture.Issued.Secret; var payload = JsonSerializer.Serialize(new { Secret = secret });
    var observations = new List<object>();
    foreach (var operation in new[] { "poll", "redeem", "redeem-again", "poll-again" }) {
        var response = operation.StartsWith("poll", StringComparison.Ordinal)
            ? await Send("GET", "/QuickConnect/Connect?secret=" + secret)
            : await Send("POST", "/Users/AuthenticateWithQuickConnect", payload);
        observations.Add(new { operation, response });
    }
    return observations.ToArray();
}
try {
    foreach (var sample in input.GetProperty("httpCases").EnumerateArray()) {
        var started = DateTime.UtcNow; await capture.Reset(sample);
        string Expand(string text) => text.Replace("$secretLower", capture.Issued?.Secret.ToLowerInvariant()).Replace("$secret", capture.Issued?.Secret).Replace("$code", capture.Issued?.Code);
        var response = await Send(sample.GetProperty("method").GetString()!, Expand(sample.GetProperty("path").GetString()!),
            sample.TryGetProperty("body", out var payload) ? Expand(payload.GetString()!) : null, Capture.String(sample, "contentType"));
        if (sample.GetProperty("path").GetString() == "/QuickConnect/Initiate" && response.status == 200) {
            capture.Issued = capture.Manager.CheckRequestStatus(response.json!.Value.GetProperty("Secret").GetString()!);
        }
        var calls = capture.Calls.ToArray(); var followUp = await FollowUp();
        results.Add(new { name = Capture.String(sample, "name"), response, followUp, started, finished = DateTime.UtcNow,
            issued = capture.Issued, calls, callsAfterRead = capture.Calls.ToArray() });
    }
    foreach (var sample in input.GetProperty("expiryCases").EnumerateArray()) {
        await capture.Reset(JsonSerializer.SerializeToElement(new { }));
        capture.Issued = capture.Manager.TryConnect(capture.Auth);
        if (sample.TryGetProperty("authorized", out var authorized) && authorized.GetBoolean()) {
            await capture.Manager.AuthorizeRequest(Capture.UserId, capture.Issued.Code);
        }
        var started = DateTime.UtcNow;
        capture.Issued.DateAdded = started.AddMilliseconds(-sample.GetProperty("pendingAgeMs").GetInt32());
        if (sample.TryGetProperty("tokenAgeMs", out var tokenAge)) capture.AgeAuthorized(started.AddMilliseconds(-tokenAge.GetInt32()));
        var calls = capture.Calls.ToArray(); var followUp = await FollowUp();
        expiryResults.Add(new { name = Capture.String(sample, "name"), followUp, started, finished = DateTime.UtcNow,
            issued = capture.Issued, calls, callsAfterRead = capture.Calls.ToArray(), dateOffsetMs = -sample.GetProperty("pendingAgeMs").GetInt32() });
    }
} finally { await app.StopAsync(); await app.DisposeAsync(); }
var directResults = await DirectCapture.Run(input.GetProperty("directCases"));
var assemblies = new[] { typeof(QuickConnectManager).Assembly, typeof(QuickConnectController).Assembly,
    typeof(User).Assembly, typeof(Jellyfin.Server.Implementations.Users.UserManager).Assembly,
    typeof(QuickConnectResult).Assembly, typeof(ISessionManager).Assembly, typeof(ApiServiceCollectionExtensions).Assembly }
    .Distinct()
    .Select(a => new { name = a.GetName().Name, filename = a.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(a.Location))) }).OrderBy(a => a.name).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), actualExecution = true, actualManager = true,
    actualControllers = true, actualBinding = true, actualDefaultAuthorization = true, sessionManagerControlled = true, principalControlled = true,
    actualNativeInstance = false, assemblies, results, expiryResults, directResults }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public sealed record HttpObservation(int status, string body, bool hasJson, JsonElement? json, string? contentType, string allow);

public class Capture {
    public static Guid UserId = Guid.Parse("ce100000-0000-0000-0000-000000000001");
    public static string? String(JsonElement input, string key) => input.TryGetProperty(key, out var value) ? value.GetString() : null;
    public JsonElement Sample; public ServerConfiguration Config = new();
    public IServerConfigurationManager Configuration; public IUserManager Users; public INetworkManager Network;
    public ISessionManager Sessions; public IAuthorizationContext Authorization; public QuickConnectManager Manager = null!;
    public ClaimsPrincipal Principal = null!; public AuthorizationInfo Auth = null!; public User User = null!;
    public QuickConnectResult? Issued; public ConcurrentQueue<object> Calls = new(); public bool Fail;
    // The production manager has no supplied clock. Only expiry setup ages the
    // timestamp here; every resulting observation is made through public HTTP.
    public void AgeAuthorized(DateTime timestamp) {
        var authorized = (ConcurrentDictionary<string, (DateTime, AuthenticationResult)>)typeof(QuickConnectManager)
            .GetField("_authorizedSecrets", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(Manager)!;
        authorized[Issued!.Secret] = (timestamp, authorized[Issued.Secret].Item2);
    }
    public Capture() {
        Configuration = Stub.Make<IServerConfigurationManager>((m, a) => m.Name is "get_Configuration" or "get_CommonConfiguration" ? Config : Stub.Default(m.ReturnType));
        Users = Stub.Make<IUserManager>((m, a) => m.Name == "GetUserById" ? User : Stub.Default(m.ReturnType));
        Network = Stub.Make<INetworkManager>((m, a) => m.Name == "IsInLocalNetwork" ? true : Stub.Default(m.ReturnType));
        Authorization = Stub.Make<IAuthorizationContext>((m, a) => m.Name == "GetAuthorizationInfo" ? Task.FromResult(Auth) : Stub.Default(m.ReturnType));
        Sessions = Stub.Make<ISessionManager>((m, a) => {
            if (m.Name != "AuthenticateDirect") return Stub.Default(m.ReturnType);
            var r = (AuthenticationRequest)a![0]!;
            Calls.Enqueue(new { userId = r.UserId.ToString("N"), r.DeviceId, r.DeviceName, r.App, r.AppVersion, r.RemoteEndPoint });
            if (Fail) return Task.FromException<AuthenticationResult>(new AuthenticationException("Controlled direct authentication failure"));
            return Task.FromResult(new AuthenticationResult { AccessToken = "fixture-token", ServerId = "fixture-server" });
        });
    }
    public async Task Reset(JsonElement sample) {
        Sample = sample; Config = new(); Calls.Clear(); Issued = null; Fail = false;
        Manager = new QuickConnectManager(Configuration, NullLogger<QuickConnectManager>.Instance, Sessions);
        Auth = new() { DeviceId = "target-device", Device = "Target", Client = "Target app", Version = "1.2" };
        if (sample.TryGetProperty("auth", out var auth)) foreach (var field in auth.EnumerateObject()) typeof(AuthorizationInfo).GetProperty(field.Name)!.SetValue(Auth, field.Value.ValueKind == JsonValueKind.Null ? null : field.Value.GetString());
        var identity = String(sample, "identity") ?? "ordinary";
        User = new User("Fixture", "fixture", "fixture") { Id = UserId }; User.Permissions.Clear();
        User.Permissions.Add(new Permission(PermissionKind.IsAdministrator, identity == "admin"));
        User.Permissions.Add(new Permission(PermissionKind.EnableRemoteAccess, true));
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, (identity == "apiKey").ToString()) };
        if (identity != "apiKey") claims.Add(new(InternalClaimTypes.UserId, UserId.ToString("N")));
        if (identity is "admin" or "apiKey") claims.Add(new(ClaimTypes.Role, UserRoles.Administrator));
        Principal = new ClaimsPrincipal(new ClaimsIdentity(claims, "fixture"));
        var prepare = String(sample, "prepare");
        if (prepare != null) {
            Issued = Manager.TryConnect(Auth);
            if (prepare == "authorized" || prepare == "expired-authorized" || prepare == "expired-both") await Manager.AuthorizeRequest(UserId, Issued.Code);
            if (prepare is "expired" or "expired-both") Issued.DateAdded = DateTime.UnixEpoch;
            if (prepare is "expired-authorized" or "expired-both") AgeAuthorized(DateTime.UnixEpoch);
        }
        Fail = sample.TryGetProperty("fail", out var fail) && fail.GetBoolean();
        if (sample.TryGetProperty("enabled", out var enabled)) Config.QuickConnectAvailable = enabled.GetBoolean();
    }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Handler(method!, args);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class OnlyQuickConnectControllers : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var c in feature.Controllers.Where(t => t.AsType() != typeof(QuickConnectController) && t.AsType() != typeof(UserController)).ToArray()) feature.Controllers.Remove(c);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() => Task.FromResult(Capture.String(capture.Sample, "identity") == "anonymous" ? AuthenticateResult.NoResult()
        : AuthenticateResult.Success(new AuthenticationTicket(capture.Principal, "fixture")));
}
