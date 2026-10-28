using System.Globalization;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Api.Auth.UserPermissionPolicy;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Lyrics;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Lyrics;
using MediaBrowser.Model.Providers;
using MediaBrowser.Providers.Lyric;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

var inputBytes = File.ReadAllBytes(args[0]); using var document = JsonDocument.Parse(inputBytes); var input = document.RootElement;
Directory.CreateDirectory(args[2]);
var paths = new ServerApplicationPaths(Path.Combine(args[2], "program"), Path.Combine(args[2], "log"),
    Path.Combine(args[2], "config"), Path.Combine(args[2], "cache"), Path.Combine(args[2], "web"));
Directory.CreateDirectory(paths.ConfigurationDirectoryPath);
var serializer = new MyXmlSerializer(); serializer.SerializeToFile(new ServerConfiguration { IsStartupWizardCompleted = true,
    MetadataPath = input.GetProperty("metadataPath").GetString()! }, Path.Combine(paths.ConfigurationDirectoryPath, "system.xml"));
var config = new ServerConfigurationManager(paths, NullLoggerFactory.Instance, serializer);
paths.InternalMetadataPath = input.GetProperty("metadataPath").GetString()!;
BaseItem.ConfigurationManager = config;
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
var capture = new Capture(input);
var admin = new User("admin", "controlled", "controlled") { Id = Guid.Parse(input.GetProperty("userId").GetString()!) };
var manager = new User("manager", "controlled", "controlled") { Id = Guid.Parse(input.GetProperty("managerId").GetString()!) };
var denied = new User("denied", "controlled", "controlled") { Id = Guid.Parse(input.GetProperty("deniedId").GetString()!) };
manager.Permissions.Add(new Permission(PermissionKind.EnableLyricManagement, true));
var users = Boundary.Make<IUserManager>((method, values) => method.Name == "GetUserById"
    ? (Guid)values![0]! == manager.Id ? manager : (Guid)values[0]! == denied.Id ? denied : admin : Boundary.Default(method.ReturnType));
var library = Boundary.Make<ILibraryManager>((method, values) => {
    if (method.Name == "GetLibraryOptions") return new LibraryOptions { SaveLyricsWithMedia = false };
    if (method.Name != "GetItemById") throw new InvalidOperationException("Unexpected controlled library boundary: " + method.Name);
    var id = (Guid)values![0]!;
    if (id == Guid.Empty) throw new ArgumentException("Guid can't be empty.", "id");
    if (id != Guid.Parse(input.GetProperty("itemId").GetString()!)) return null;
    return new Audio { Id = id, Name = input.GetProperty("songName").GetString()!, Path = input.GetProperty("mediaPath").GetString()!,
        Album = input.GetProperty("albumName").GetString(), AlbumArtists = input.GetProperty("albumArtistsNames").Deserialize<string[]>()!,
        Artists = input.GetProperty("artistNames").Deserialize<string[]>()!, RunTimeTicks = long.Parse(input.GetProperty("duration").GetString()!, CultureInfo.InvariantCulture) };
});
BaseItem.LibraryManager = library;
var providers = input.GetProperty("providers").EnumerateArray().Select(value => new SourceProvider(value, capture)).ToArray();
var refreshes = Boundary.Make<IProviderManager>((method, _) => {
    if (method.Name != "QueueRefresh") throw new InvalidOperationException("Unexpected controlled metadata boundary: " + method.Name);
    capture.Queued.TrySetResult(); return null;
});
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(capture); builder.Services.AddSingleton(library); builder.Services.AddSingleton(users);
builder.Services.AddSingleton<IServerConfigurationManager>(config); builder.Services.AddSingleton<IFileSystem>(fileSystem);
builder.Services.AddSingleton(refreshes); builder.Services.AddHttpClient();
builder.Services.AddSingleton<ILyricManager>(services => new LyricManager(NullLogger<LyricManager>.Instance, fileSystem,
    Boundary.Make<ILibraryMonitor>((method, _) => Boundary.Default(method.ReturnType)), null!,
    Boundary.Make<IDirectoryService>((method, _) => Boundary.Default(method.ReturnType)),
    services.GetRequiredService<IHttpClientFactory>(), providers, [new LrcLyricParser(), new TxtLyricParser()]));
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton(Boundary.Make<INetworkManager>((method, _) => method.Name == "IsInLocalNetwork" ? true : Boundary.Default(method.ReturnType)));
builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, UserPermissionHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(value => {
    value.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement()).Build();
    value.AddPolicy(Policies.LyricManagement, new AuthorizationPolicyBuilder("fixture")
        .AddRequirements(new UserPermissionRequirement(PermissionKind.EnableLyricManagement)).Build());
});
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlyController()));
var app = builder.Build(); var results = new List<object>(); using var client = new HttpClient();
var originalHash = Hash(input.GetProperty("mediaPath").GetString()!);
try {
    app.Use(async (_, next) => { CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US"); CultureInfo.CurrentUICulture = CultureInfo.CurrentCulture; await next(); });
    app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
    var origin = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
    foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
        capture.Begin(sample);
        using var cancellation = new CancellationTokenSource();
        using var request = new HttpRequestMessage(new HttpMethod(sample.TryGetProperty("method", out var method) ? method.GetString()! : "GET"), origin + sample.GetProperty("path").GetString());
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        var sending = client.SendAsync(request, cancellation.Token);
        if (sample.TryGetProperty("disconnect", out var disconnect) && disconnect.GetBoolean()) {
            await capture.GetStarted.Task.WaitAsync(TimeSpan.FromSeconds(30)); cancellation.Cancel(); capture.ReleaseGet.TrySetResult();
            try { using var ignored = await sending; } catch (OperationCanceledException) { }
            await capture.Queued.Task.WaitAsync(TimeSpan.FromSeconds(30));
            results.Add(new { name = sample.GetProperty("name").GetString(), disconnected = true, files = Saved(input) });
        } else {
            using var response = await sending;
            results.Add(new { name = sample.GetProperty("name").GetString(), status = (int)response.StatusCode,
                contentType = response.Content.Headers.ContentType?.ToString(), body = await response.Content.ReadAsStringAsync(),
                allow = response.Content.Headers.Allow.Count == 0 ? null : string.Join(", ", response.Content.Headers.Allow), files = Saved(input) });
        }
    }
} finally { try { await app.StopAsync(); } finally { await app.DisposeAsync(); } }
if (originalHash != Hash(input.GetProperty("mediaPath").GetString()!)) throw new InvalidOperationException("The original audio bytes changed.");
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), results,
    requests = capture.Requests, originalAudioSha256 = originalHash, actualMvc = true, actualController = true, actualManager = true,
    actualParsers = true, hostStopped = true, hostDisposed = true,
    controlled = new[] { "Native principals, library item/options lookup and metadata queue completion boundary", "Original provider bytes and results" },
    scope = "Actual Native MVC authorization, LyricsController and LyricManager provider selection/parsing/save; refresh execution is separately covered by the full-host management test.",
    assemblies = new[] { typeof(LyricsController).Assembly, typeof(LyricManager).Assembly, typeof(LrcParser.Parser.Lrc.LrcParser).Assembly }
        .Select(value => new { filename = value.Location, sha256 = Hash(value.Location) })
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static string Hash(string filename) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename)));
static object[] Saved(JsonElement input) {
    var id = input.GetProperty("itemId").GetString()!;
    var directory = Path.Combine(input.GetProperty("metadataPath").GetString()!, "library", id[..2], id);
    return new[] { "track.lrc", "track.txt" }.Select(name => { var filename = Path.Combine(directory, name); return (object)new {
        name, exists = File.Exists(filename), sha256 = File.Exists(filename) ? Hash(filename) : null,
        base64 = File.Exists(filename) ? Convert.ToBase64String(File.ReadAllBytes(filename)) : null }; }).ToArray();
}
public class Capture(JsonElement input) {
    public JsonElement Input = input; public JsonElement Sample;
    public List<object> Requests = [];
    public TaskCompletionSource GetStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource ReleaseGet = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Queued = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public void Begin(JsonElement sample) { Sample = sample; GetStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        ReleaseGet = new(TaskCreationOptions.RunContinuationsAsynchronously); Queued = new(TaskCreationOptions.RunContinuationsAsynchronously); }
}
public class SourceProvider(JsonElement definition, Capture capture) : ILyricProvider, IHasOrder {
    public string Name => definition.GetProperty("name").GetString()!;
    public int Order => definition.GetProperty("order").GetInt32();
    public Task<IEnumerable<RemoteLyricInfo>> SearchAsync(LyricSearchRequest request, CancellationToken cancellationToken) {
        capture.Requests.Add(new { provider = Name, mediaPath = request.MediaPath, songName = request.SongName, albumName = request.AlbumName,
            albumArtistsNames = request.AlbumArtistsNames, artistNames = request.ArtistNames,
            duration = request.Duration?.ToString(CultureInfo.InvariantCulture), isAutomated = request.IsAutomated, providerIds = request.ProviderIds });
        if (definition.TryGetProperty("searchError", out var failure) && failure.GetBoolean()) throw new InvalidOperationException("Controlled provider search failure.");
        return Task.FromResult(definition.GetProperty("entries").EnumerateArray().Select(entry => new RemoteLyricInfo {
            Id = entry.GetProperty("id").GetString()!, ProviderName = entry.GetProperty("providerName").GetString()!,
            Metadata = JsonSerializer.Deserialize<LyricMetadata>(entry.GetProperty("metadata").GetRawText(),
                new JsonSerializerOptions { NumberHandling = JsonNumberHandling.AllowReadingFromString })!,
            Lyrics = Response(entry) }).AsEnumerable());
    }
    public async Task<LyricResponse?> GetLyricsAsync(string id, CancellationToken cancellationToken) {
        if (id == "error") throw new InvalidOperationException("Controlled provider read failure.");
        if (id == "download-disconnect") { capture.GetStarted.TrySetResult(); await capture.ReleaseGet.Task; }
        var entry = definition.GetProperty("entries").EnumerateArray().FirstOrDefault(value => value.GetProperty("id").GetString() == id);
        return entry.ValueKind == JsonValueKind.Undefined ? null : Response(entry);
    }
    private static LyricResponse Response(JsonElement entry) => new() { Format = entry.GetProperty("format").GetString()!,
        Stream = new MemoryStream(Convert.FromBase64String(entry.GetProperty("bytes").GetString()!), false) };
}
public class Boundary : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Call = null!;
    protected override object? Invoke(MethodInfo? targetMethod, object?[]? values) => Call(targetMethod!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> call) where T : class { var result = Create<T, Boundary>(); ((Boundary)(object)result).Call = call; return result; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class OnlyController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) { foreach (var value in feature.Controllers.Where(value => value.AsType() != typeof(LyricsController)).ToArray()) feature.Controllers.Remove(value); }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = capture.Sample.TryGetProperty("identity", out var value) ? value.GetString() : "admin";
        if (identity == "anonymous") return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, (identity == "apiKey").ToString()) };
        if (identity != "apiKey") claims.Add(new(InternalClaimTypes.UserId, capture.Input.GetProperty(identity == "manager" ? "managerId" : identity == "denied" ? "deniedId" : "userId").GetString()!));
        if (identity is "admin" or "apiKey") claims.Add(new(ClaimTypes.Role, UserRoles.Administrator));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name)), Scheme.Name)));
    }
}
