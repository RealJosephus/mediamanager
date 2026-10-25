using System.Collections.Concurrent;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Api.Auth.FirstTimeSetupPolicy;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
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

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var markerTypes = input.GetProperty("markerTypes").EnumerateArray().Select(entry => {
    var text = entry.GetString()!;
    var parsed = Enum.TryParse<CollectionTypeOptions>(text, true, out var value);
    return new { text, parsed, value = parsed ? (object)(Enum.IsDefined(value) ? value.ToString() : (int)value) : null };
}).ToArray();
var capture = new Capture(Path.Combine(Path.GetDirectoryName(args[1])!, "states"));
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(capture); builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton(capture.Configuration);
builder.Services.AddSingleton<IConfigurationManager>(capture.Configuration);
builder.Services.AddSingleton(capture.Users); builder.Services.AddSingleton(capture.Network);
builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, FirstTimeSetupHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(options => options.AddPolicy(Policies.FirstTimeSetupOrElevated,
    policy => policy.AddAuthenticationSchemes("fixture").AddRequirements(new FirstTimeSetupRequirement())));
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(manager => manager.FeatureProviders.Add(new OnlyStructureController()));
builder.Services.Replace(ServiceDescriptor.Transient<LibraryStructureController>(_ => new LibraryStructureController(capture.Configuration, capture.Library, capture.Monitor, capture.Directories)));
var application = builder.Build();
application.UseMiddleware<ExceptionMiddleware>(); application.UseAuthentication(); application.UseAuthorization(); application.MapControllers();
await application.StartAsync();
var address = application.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var results = new List<object>();
using var client = new HttpClient();
try {
    foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
        capture.Reset(sample);
        using var request = new HttpRequestMessage(new HttpMethod(sample.GetProperty("method").GetString()!), address + sample.GetProperty("path").GetString());
        request.Headers.TryAddWithoutValidation("Accept", Capture.String(sample, "accept") ?? "application/json");
        if (sample.TryGetProperty("body", out var payload)) {
            request.Content = new StringContent(payload.GetString()!);
            request.Content.Headers.ContentType = new(Capture.String(sample, "contentType") ?? "application/json");
        }
        using var response = await client.SendAsync(request);
        var body = await response.Content.ReadAsStringAsync();
        if (capture.Stopped) await capture.Settled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        object? jsonBody = null; try { jsonBody = JsonSerializer.Deserialize<JsonElement>(body); } catch (JsonException) { }
        results.Add(new { name = sample.GetProperty("name").GetString(), status = (int)response.StatusCode,
            contentType = response.Content.Headers.ContentType?.ToString(), allow = string.Join(", ", response.Content.Headers.Allow), body,
            jsonBody, calls = capture.Calls.ToArray(), files = Directory.EnumerateFiles(capture.Views, "*", SearchOption.AllDirectories)
                .Select(filename => Path.GetRelativePath(capture.Views, filename)).Order(StringComparer.Ordinal).ToArray(),
            savedOptions = capture.SavedOptions });
    }
} finally { await application.StopAsync(); await application.DisposeAsync(); }
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .Select(assembly => new { name = assembly.GetName().Name, filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).OrderBy(row => row.name).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), actualController = true,
    actualBinding = true, actualPermissionHandlers = true, actualRenameFiles = true, actualCollectionFolderOptions = true,
    principalControlled = true, managerControlled = true, markerTypes, assemblies, results }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Capture {
    public static Guid Id(int index) => Guid.Parse($"ca200000-0000-0000-0000-{index:000000000000}");
    public static string? String(JsonElement sample, string key) => sample.TryGetProperty(key, out var value) ? value.GetString() : null;
    public static bool Flag(JsonElement sample, string key) => sample.TryGetProperty(key, out var value) && value.GetBoolean();
    public static JsonSerializerOptions Json = new() { Converters = { new JsonStringEnumConverter() } };
    public JsonElement Sample;
    public ConcurrentQueue<object> Calls = new();
    public ClaimsPrincipal Principal = null!;
    public User User = null!;
    public string Root, Views = "";
    public bool Stopped;
    public int Moves, IgnoreClears;
    public TaskCompletionSource Settled = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public object? SavedOptions;
    public IServerConfigurationManager Configuration;
    public ILibraryManager Library;
    public ILibraryMonitor Monitor;
    public IDirectoryService Directories;
    public IUserManager Users;
    public INetworkManager Network;
    public Capture(string root) {
        Root = root;
        var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
            "get_DefaultUserViewsPath" => Views, "get_ProgramDataPath" => Path.GetDirectoryName(Path.GetDirectoryName(Views)),
            _ => Stub.Default(method.ReturnType) });
        Configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
            "get_ApplicationPaths" => paths,
            "get_Configuration" or "get_CommonConfiguration" => new ServerConfiguration { IsStartupWizardCompleted = !Flag(Sample, "wizard") },
            _ => Stub.Default(method.ReturnType) });
        Library = Stub.Make<ILibraryManager>((method, parameters) => {
            switch (method.Name) {
                case "GetVirtualFolders": Trace("get", parameters![0]); return new List<VirtualFolderInfo>();
                case "AddVirtualFolder": Trace("create", new { name = parameters![0], collectionType = parameters[1], options = JsonSerializer.SerializeToElement(parameters[2], Json), refresh = parameters[3] }); Fail("create"); return Task.CompletedTask;
                case "RemoveVirtualFolder": Trace("delete", new { name = parameters![0], refresh = parameters[1] }); Fail("delete"); return Task.CompletedTask;
                case "AddMediaPath": Trace("add-path", new { name = parameters![0], info = parameters[1] }); Fail("add-path"); return null;
                case "UpdateMediaPath": Trace("update-path", new { name = parameters![0], info = parameters[1] }); return null;
                case "RemoveMediaPath": Trace("remove-path", new { name = parameters![0], path = parameters[1] }); Fail("remove-path"); return null;
                case "QueueLibraryScan": Trace("queue"); Settled.TrySetResult(); return null;
                case "ValidateTopLibraryFolders": Trace("validate-top", parameters![1]); return Task.CompletedTask;
                case "ClearIgnoreRuleCache": Trace("clear-ignore"); if (++IgnoreClears == 2) Settled.TrySetResult(); return null;
                case "GetUserRootFolder": Trace("user-root"); return new NativeUserRoot { LiveChildren = Flag(Sample, "physicalRoot")
                    ? [new CollectionFolder { Path = Path.Combine(Views, "Renamed"), PhysicalFolderIds = [Id(12), Id(13), Id(12)] }] : [] };
                case "GetItemById":
                    Trace("item", ((Guid)parameters![0]!).ToString("N"));
                    if ((Guid)parameters[0]! == Id(12)) return new NativePhysicalFolder { Id = Id(12), Path = @"Z:\Physical", Capture = this };
                    if ((Guid)parameters[0]! == Id(13)) return new MediaBrowser.Controller.Entities.Movies.Movie { Id = Id(13) };
                    return Flag(Sample, "missingItem") ? null : new CollectionFolder { Id = (Guid)parameters[0]!, Path = Path.Combine(Views, "Library") };
                case "GetLibraryOptions": return CollectionFolder.GetLibraryOptions(((BaseItem)parameters![0]!).Path);
                case "CreateShortcut": Trace("shortcut", new { directory = parameters![0], info = parameters[1] }); Fail("shortcut"); return null;
                default: return Stub.Default(method.ReturnType);
            }
        });
        Monitor = Stub.Make<ILibraryMonitor>((method, _) => {
            if (method.Name == "Stop") { Trace("stop"); Fail("stop"); Stopped = true; }
            if (method.Name == "Start") { Trace("start"); Settled.TrySetResult(); }
            return Stub.Default(method.ReturnType);
        });
        Directories = Stub.Make<IDirectoryService>((method, parameters) => {
            if (method.Name == "Move") {
                Trace("move", new { from = parameters![0], to = parameters[1] }); Fail("move");
                if (++Moves == 2) Fail("move-second");
                Directory.Move((string)parameters[0]!, (string)parameters[1]!);
            }
            return Stub.Default(method.ReturnType);
        });
        Users = Stub.Make<IUserManager>((method, _) => method.Name == "GetUserById" ? User : Stub.Default(method.ReturnType));
        Network = Stub.Make<INetworkManager>((method, _) => method.Name == "IsInLocalNetwork" ? !Flag(Sample, "remote") : Stub.Default(method.ReturnType));
        BaseItem.LibraryManager = Library; BaseItem.Logger = NullLogger<BaseItem>.Instance;
        BaseItem.FileSystem = Stub.Make<IFileSystem>((method, _) => Stub.Default(method.ReturnType));
        BaseItem.ProviderManager = Stub.Make<IProviderManager>((method, parameters) => {
            if (method.Name == "RefreshSingleItem") {
                var options = (MetadataRefreshOptions)parameters![1]!;
                Trace("refresh-physical", new { id = ((BaseItem)parameters[0]!).Id.ToString("N"), metadata = options.MetadataRefreshMode.ToString(),
                    image = options.ImageRefreshMode.ToString(), automated = options.IsAutomated, force = options.ForceSave,
                    tokenCanCancel = ((CancellationToken)parameters[2]!).CanBeCanceled });
                return Task.FromResult(ItemUpdateType.None);
            }
            return Stub.Default(method.ReturnType);
        });
        CollectionFolder.XmlSerializer = new MyXmlSerializer();
        CollectionFolder.ApplicationHost = Stub.Make<IServerApplicationHost>((method, parameters) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? parameters![0] : Stub.Default(method.ReturnType));
        CollectionFolder.LibraryOptionsUpdated += (_, value) => { SavedOptions = JsonSerializer.SerializeToElement(value.LibraryOptions, Json); Trace("options-updated", SavedOptions); };
    }
    public void Trace(string action, object? value = null) => Calls.Enqueue(new { action, value });
    public void Fail(string phase) { if (String(Sample, "fail") == phase) throw new IOException("Controlled " + phase + " failure."); }
    public void Reset(JsonElement sample) {
        Sample = sample; Calls.Clear(); Stopped = false; Moves = IgnoreClears = 0; SavedOptions = null; Settled = new(TaskCreationOptions.RunContinuationsAsynchronously);
        Views = Path.Combine(Root, sample.GetProperty("name").GetString()!, "root", "default"); Directory.CreateDirectory(Views);
        foreach (var name in new[] { "Library", "Taken" }) { Directory.CreateDirectory(Path.Combine(Views, name)); File.WriteAllText(Path.Combine(Views, name, "movies.collection"), ""); }
        CollectionFolder.OnCollectionFolderChange();
        var identity = String(sample, "identity") ?? "admin";
        User = new User("Fixture", "fixture", "fixture") { Id = Id(9) }; User.Permissions.Clear();
        User.Permissions.Add(new Permission(PermissionKind.IsAdministrator, identity == "admin"));
        User.Permissions.Add(new Permission(PermissionKind.EnableRemoteAccess, !Flag(sample, "remoteDenied")));
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, (identity == "apiKey").ToString()) };
        if (identity != "apiKey" && identity != "empty") claims.Add(new(InternalClaimTypes.UserId, Id(9).ToString("N")));
        if (identity is "admin" or "apiKey") claims.Add(new(ClaimTypes.Role, UserRoles.Administrator));
        Principal = new ClaimsPrincipal(new ClaimsIdentity(claims, "fixture"));
    }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Handler(method!, args);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class NativeUserRoot : UserRootFolder { public BaseItem[] LiveChildren = []; public override IEnumerable<BaseItem> Children { get => LiveChildren; set { } } }
public class NativePhysicalFolder : Folder {
    public Capture Capture = null!;
    protected override Task ValidateChildrenInternal(IProgress<double> progress, bool recursive, bool refreshChildMetadata, bool allowRemoveRoot,
        MetadataRefreshOptions options, IDirectoryService directoryService, CancellationToken cancellationToken) {
        Capture.Trace("validate-physical", new { id = Id.ToString("N"), recursive, refreshChildMetadata, allowRemoveRoot, tokenCanCancel = cancellationToken.CanBeCanceled });
        return Task.CompletedTask;
    }
}
public class OnlyStructureController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var controller in feature.Controllers.Where(type => type.AsType() != typeof(LibraryStructureController)).ToArray()) feature.Controllers.Remove(controller);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() => Task.FromResult(Capture.String(capture.Sample, "identity") == "anonymous" ? AuthenticateResult.NoResult()
        : AuthenticateResult.Success(new AuthenticationTicket(capture.Principal, "fixture")));
}
