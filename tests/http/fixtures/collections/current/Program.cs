using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using Emby.Server.Implementations.Collections;
using Emby.Server.Implementations.IO;
using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Api.Auth.UserPermissionPolicy;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
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
var capture = new Capture(Path.Combine(Path.GetDirectoryName(args[1])!, "states"));
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders();
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(capture);
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<IServerConfigurationManager>(DispatchProxy.Create<IServerConfigurationManager, ConfigurationControl>());
builder.Services.AddSingleton(capture.Users);
builder.Services.AddSingleton(capture.Network);
builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, UserPermissionHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(options => options.AddPolicy(Policies.CollectionManagement,
    policy => policy.AddAuthenticationSchemes("fixture").RequireAuthenticatedUser()
        .AddRequirements(new UserPermissionRequirement(PermissionKind.EnableCollectionManagement))));
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(manager => manager.FeatureProviders.Add(new OnlyCollectionController()));
builder.Services.Replace(ServiceDescriptor.Transient<CollectionController>(_ => new CollectionController(capture.Manager, capture.Dto)));
var application = builder.Build();
application.UseMiddleware<ExceptionMiddleware>();
application.UseAuthentication();
application.UseAuthorization();
application.MapControllers();
await application.StartAsync();
var address = application.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
var results = new List<object>();
try {
    foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
        capture.Reset(sample);
        using var request = new HttpRequestMessage(new HttpMethod(sample.GetProperty("method").GetString()!), address + sample.GetProperty("path").GetString());
        request.Headers.TryAddWithoutValidation("Accept", Capture.String(sample, "accept") ?? "application/json");
        if (sample.TryGetProperty("body", out var bodyValue)) {
            request.Content = new StringContent(bodyValue.GetString()!);
            request.Content.Headers.ContentType = new(Capture.String(sample, "contentType") ?? "application/json");
        }
        using var response = await client.SendAsync(request);
        var body = await response.Content.ReadAsStringAsync();
        object? json = null; try { json = JsonSerializer.Deserialize<JsonElement>(body); } catch (JsonException) { }
        results.Add(new { name = sample.GetProperty("name").GetString(), status = (int)response.StatusCode,
            contentType = response.Content.Headers.ContentType?.ToString(), allow = string.Join(", ", response.Content.Headers.Allow),
            body, jsonBody = json, calls = capture.Calls.ToArray(), managerState = capture.Native?.Snapshot() });
    }
} finally { client.Dispose(); await application.StopAsync(); await application.DisposeAsync(); }
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .Select(assembly => new { name = assembly.GetName().Name, filename = assembly.Location,
        sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).OrderBy(row => row.name).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { schemaVersion = 1, actualExecution = true, httpServerStopped = true,
    boundary = "Same-run actual CollectionController, MVC binding/authorization and CollectionManager error prefixes with real isolated files. Principal, network, repository and DTO seams are controlled; no full Native server or exchange acceptance.",
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    actualController = true, actualBinding = true, actualPermissionHandlers = true, actualManagerErrors = true, principalControlled = true,
    userNetworkControlled = true, managerDtoControlled = true, assemblies, results }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Capture {
    public static Guid Id(int index) => Guid.Parse($"ca100000-0000-0000-0000-{index:000000000000}");
    public JsonElement Sample;
    public List<object> Calls = new();
    public ClaimsPrincipal Principal = null!;
    public User User = null!;
    public ICollectionManager Manager;
    public IDtoService Dto;
    public IUserManager Users;
    public INetworkManager Network;
    public NativeManagerBoundary? Native;
    public string StateRoot;
    public static string? String(JsonElement sample, string key) => sample.TryGetProperty(key, out var value) ? value.GetString() : null;
    public Capture(string stateRoot) {
        StateRoot = stateRoot;
        Manager = DispatchProxy.Create<ICollectionManager, ManagerControl>(); ((ManagerControl)Manager).Capture = this;
        Dto = DispatchProxy.Create<IDtoService, DtoControl>(); ((DtoControl)Dto).Capture = this;
        Users = DispatchProxy.Create<IUserManager, UserControl>(); ((UserControl)Users).Capture = this;
        Network = DispatchProxy.Create<INetworkManager, NetworkControl>(); ((NetworkControl)Network).Capture = this;
    }
    public void Reset(JsonElement sample) {
        Sample = sample; Calls.Clear();
        Native = sample.TryGetProperty("actualManager", out var native) && native.GetBoolean()
            ? new NativeManagerBoundary(this, Path.Combine(StateRoot, sample.GetProperty("name").GetString()!)) : null;
        var identity = String(sample, "identity") ?? "collection";
        User = new User("Fixture", "fixture", "fixture") { Id = Id(9) };
        User.Permissions.Clear();
        User.Permissions.Add(new Permission(PermissionKind.IsAdministrator, identity == "admin"));
        User.Permissions.Add(new Permission(PermissionKind.EnableCollectionManagement, identity == "collection"));
        User.Permissions.Add(new Permission(PermissionKind.EnableRemoteAccess, !sample.TryGetProperty("remoteDenied", out var denied) || !denied.GetBoolean()));
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, (identity == "apiKey").ToString()) };
        if (identity != "apiKey" && identity != "empty") claims.Add(new(InternalClaimTypes.UserId, Id(9).ToString("N")));
        if (identity == "admin") claims.Add(new(ClaimTypes.Role, UserRoles.Administrator));
        Principal = new ClaimsPrincipal(new ClaimsIdentity(claims, "fixture"));
    }
}
public class ManagerControl : DispatchProxy {
    public Capture Capture = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "CreateCollectionAsync") {
            var options = (CollectionCreationOptions)args![0]!;
            Capture.Calls.Add(new { phase = "create", options.Name, options.IsLocked,
                ParentId = options.ParentId?.ToString("N"), ItemIdList = options.ItemIdList.ToArray(), UserIds = options.UserIds.Select(value => value.ToString("N")).ToArray() });
            if (Capture.Native is not null) return Capture.Native.Manager.CreateCollectionAsync(options);
            if (Capture.String(Capture.Sample, "fail") == "create") throw new IOException("Controlled create failure.");
            return Task.FromResult(new BoxSet { Id = Capture.Id(1), Name = options.Name });
        }
        if (method.Name is "AddToCollectionAsync" or "RemoveFromCollectionAsync") {
            Capture.Calls.Add(new { phase = method.Name == "AddToCollectionAsync" ? "add" : "remove",
                id = ((Guid)args![0]!).ToString("N"), ids = ((IEnumerable<Guid>)args[1]!).Select(value => value.ToString("N")).ToArray() });
            if (Capture.Native is not null) return method.Name == "AddToCollectionAsync"
                ? Capture.Native.Manager.AddToCollectionAsync((Guid)args[0]!, (IEnumerable<Guid>)args[1]!)
                : Capture.Native.Manager.RemoveFromCollectionAsync((Guid)args[0]!, (IEnumerable<Guid>)args[1]!);
            if (Capture.String(Capture.Sample, "fail") == "mutation") throw new IOException("Controlled mutation failure.");
            return Task.CompletedTask;
        }
        throw new NotSupportedException(method.Name);
    }
}
public class DtoControl : DispatchProxy {
    public Capture Capture = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name != "GetBaseItemDto") throw new NotSupportedException(method.Name);
        var options = (DtoOptions)args![1]!;
        Capture.Calls.Add(new { phase = "dto", id = ((BoxSet)args[0]!).Id.ToString("N"), allFields = options.Fields.Count > 0, userIsNull = args[2] is null, ownerIsNull = args[3] is null });
        if (Capture.String(Capture.Sample, "fail") == "dto") throw new IOException("Controlled DTO failure.");
        return new BaseItemDto { Id = Capture.Id(2) };
    }
}
public class UserControl : DispatchProxy {
    public Capture Capture = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetUserById" ? Capture.User : throw new NotSupportedException(method.Name);
}
public class NetworkControl : DispatchProxy {
    public Capture Capture = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "IsInLocalNetwork" ? !Capture.Sample.TryGetProperty("remote", out var remote) || !remote.GetBoolean() : throw new NotSupportedException(method.Name);
}
public class ConfigurationControl : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "get_Configuration" ? new ServerConfiguration() : throw new NotSupportedException(method.Name);
}
public class OnlyCollectionController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var controller in feature.Controllers.Where(type => type.AsType() != typeof(CollectionController)).ToArray()) feature.Controllers.Remove(controller);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() => Task.FromResult(Capture.String(capture.Sample, "identity") == "anonymous" ? AuthenticateResult.NoResult()
        : AuthenticateResult.Success(new AuthenticationTicket(capture.Principal, "fixture")));
}

// Execute the actual CollectionManager and ManagedFileSystem for the public
// error classification and the create-before-member-conversion prefix.
// Repository, provider and root navigation remain explicit controls.
public class NativeManagerBoundary {
    public CollectionManager Manager;
    public BoxSet? Persisted;
    public List<string> Phases = new();
    private readonly string program;
    private readonly string collections;
    private readonly Guid collectionParentId;
    private readonly BoxSet existing;
    private readonly Movie member;
    public NativeManagerBoundary(Capture capture, string programData) {
        program = Path.GetFullPath(programData);
        var data = Path.Combine(program, "data");
        var parent = new Folder { Id = Capture.Id(5), Path = Path.Combine(data, "collections"), Name = "Collections" };
        collections = parent.Path;
        collectionParentId = parent.Id;
        Directory.CreateDirectory(parent.Path);
        var root = new NativeRoot { Id = Capture.Id(4), Path = Path.Combine(program, "root"), LiveChildren = [parent] };
        var paths = BoundaryStub.Make<IApplicationPaths>((method, _) => method.Name switch {
            "get_ProgramDataPath" => program, "get_DataPath" => data, "get_TempDirectory" => Path.Combine(program, "temp"), _ => BoundaryStub.Default(method.ReturnType) });
        var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
        member = new Movie { Id = Capture.Id(2), Name = "Member", Path = Path.Combine(program, "media", "Member.mkv") };
        existing = new BoxSet { Id = Capture.Id(1), Name = "Existing", ParentId = parent.Id, Path = Path.Combine(parent.Path, "Existing [boxset]") };
        Directory.CreateDirectory(Path.GetDirectoryName(member.Path)!);
        File.WriteAllBytes(member.Path, System.Text.Encoding.UTF8.GetBytes("unchanged source media\n"));
        Directory.CreateDirectory(existing.Path);
        File.WriteAllBytes(Path.Combine(existing.Path, "preserve.bin"), System.Text.Encoding.UTF8.GetBytes("unchanged collection sidecar\n"));
        var items = new Dictionary<Guid, BaseItem> { [member.Id] = member, [existing.Id] = existing, [root.Id] = root, [parent.Id] = parent };
        var library = BoundaryStub.Make<ILibraryManager>((method, parameters) => {
            switch (method.Name) {
                case "get_RootFolder": return root;
                case "GetItemById": return parameters![0] is Guid id && items.TryGetValue(id, out var item) ? item : null;
                case "GetNewItemId": return Capture.Id(1);
                case "GetItemList": return ((InternalItemsQuery)parameters![0]!).ItemIds.Where(items.ContainsKey).Select(id => items[id]).ToArray();
                case "GetCollectionFolders": return new List<Folder>();
                case "GetLibraryOptions": return new LibraryOptions();
                case "CreateItem":
                    Persisted = (BoxSet)parameters![0]!; items[Persisted.Id] = Persisted; Phases.Add("create-item"); return null;
                case "UpdateItemAsync": Phases.Add("save"); return Task.CompletedTask;
                default: return BoundaryStub.Default(method.ReturnType);
            }
        });
        var configuration = BoundaryStub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
            "get_ApplicationPaths" => paths, "get_Configuration" => new ServerConfiguration { MetadataCountryCode = "US" }, _ => BoundaryStub.Default(method.ReturnType) });
        var localization = BoundaryStub.Make<MediaBrowser.Model.Globalization.ILocalizationManager>((method, _) => method.Name == "GetServerLocalizedString" ? "Collections" : BoundaryStub.Default(method.ReturnType));
        var provider = BoundaryStub.Make<IProviderManager>((method, _) => {
            if (method.Name == "QueueRefresh") Phases.Add("queue");
            return BoundaryStub.Default(method.ReturnType);
        });
        var monitor = BoundaryStub.Make<ILibraryMonitor>((method, _) => {
            if (method.Name == "ReportFileSystemChangeBeginning") Phases.Add("begin");
            if (method.Name == "ReportFileSystemChangeComplete") Phases.Add("complete");
            return BoundaryStub.Default(method.ReturnType);
        });
        BaseItem.LibraryManager = library; BaseItem.FileSystem = fileSystem; BaseItem.ConfigurationManager = configuration;
        BaseItem.LocalizationManager = localization; BaseItem.ProviderManager = provider; BaseItem.Logger = NullLogger<BaseItem>.Instance;
        Manager = new CollectionManager(library, paths, localization, fileSystem, monitor, NullLoggerFactory.Instance, provider,
            BoundaryStub.Make<ILinkedChildrenService>((method, _) => BoundaryStub.Default(method.ReturnType)));
        Manager.CollectionCreated += (_, _) => Phases.Add("created-event");
        Manager.ItemsAddedToCollection += (_, _) => Phases.Add("added-event");
        Manager.ItemsRemovedFromCollection += (_, _) => Phases.Add("removed-event");
    }
    private object Project(BoxSet item) => new { name = item.Name, type = "BoxSet", isLocked = item.IsLocked,
        parentRole = item.ParentId == collectionParentId ? "collections" : item.ParentId.ToString("N"),
        path = Path.GetRelativePath(collections, item.Path).Replace('\\', '/'),
        links = item.LinkedChildren.Select(link => new { itemId = link.ItemId?.ToString("N"), path = link.Path,
            libraryItemId = link.LibraryItemId, type = link.Type.ToString() }).ToArray() };
    public object Snapshot() => new { diagnosticPhases = Phases.ToArray(), created = Persisted is not null,
        collection = Persisted is null ? null : Project(Persisted), existing = Project(existing),
        events = Phases.Where(value => value.EndsWith("-event", StringComparison.Ordinal)).ToArray(),
        directories = Directory.EnumerateDirectories(collections, "*", SearchOption.AllDirectories)
            .Select(value => Path.GetRelativePath(collections, value).Replace('\\', '/')).Order(StringComparer.Ordinal).ToArray(),
        files = Directory.EnumerateFiles(collections, "*", SearchOption.AllDirectories).Select(value => new {
            path = Path.GetRelativePath(collections, value).Replace('\\', '/'),
            bytes = new FileInfo(value).Length, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(value)))
        }).OrderBy(value => value.path, StringComparer.Ordinal).ToArray(),
        media = new { bytes = new FileInfo(member.Path).Length,
            sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(member.Path))) } };
}
public class BoundaryStub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Handler(method!, args);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, BoundaryStub>(); ((BoundaryStub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class NativeRoot : AggregateFolder {
    public BaseItem[] LiveChildren = [];
    public override IEnumerable<BaseItem> Children { get => LiveChildren; set { if (value is not null) LiveChildren = value.ToArray(); } }
}
