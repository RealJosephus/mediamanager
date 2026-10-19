using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using BitFaster.Caching.Lru;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Playlists;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Server.Configuration;
using Jellyfin.Server.Extensions;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Common.Net;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var current = new Capture();
var initialItems = current.Items.Values.Select(item => new {
    item.Id, item.Name, Type = item.GetType().FullName, item.Path, item.ParentId, item.OwnerId,
    item.IsFolder, IsRoot = item is Folder folder && folder.IsRoot, SourceType = item.SourceType.ToString(),
    OwnerUserId = item is Playlist playlist ? playlist.OwnerUserId : Guid.Empty,
    OpenAccess = item is Playlist shared && shared.OpenAccess,
    PhysicalLocationsList = item is CollectionFolder collection ? collection.PhysicalLocationsList : Array.Empty<string>()
}).ToArray();
var permissionMatrix = new List<object>();
foreach (var policy in input.GetProperty("permissionPolicies").EnumerateArray()) {
    current.Reset(JsonSerializer.SerializeToElement(new { policy = policy.GetString() }));
    permissionMatrix.Add(new { policy = policy.GetString(), items = current.Items.Values.Select(item => new {
        id = item.Id.ToString("N"), noUser = item.CanDelete(), user = item.CanDelete(current.User) }).ToArray() });
}
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders();
builder.Logging.AddProvider(new ErrorCapture(current));
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(current);
builder.Services.AddSingleton<IServerConfigurationManager>(_ => current.Configuration);
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(options => options.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").RequireAuthenticatedUser().Build());
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(manager =>
    manager.FeatureProviders.Add(new OnlyLibraryController()));
builder.Services.Replace(ServiceDescriptor.Transient<LibraryController>(_ => current.Controller()));
var application = builder.Build();
application.UseMiddleware<ExceptionMiddleware>();
application.UseAuthentication();
application.UseAuthorization();
application.MapControllers();
await application.StartAsync();
var address = application.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var client = new HttpClient();
var results = new List<object>();
try
{
    foreach (var sample in input.GetProperty("cases").EnumerateArray())
    {
        current.Reset(sample);
        var requestPath = current.RequestPath(sample);
        using var request = new HttpRequestMessage(HttpMethod.Delete, address + requestPath);
        request.Headers.TryAddWithoutValidation("Accept", Capture.String(sample, "accept") ?? "application/json");
        using var response = await client.SendAsync(request);
        var body = await response.Content.ReadAsStringAsync();
        if ((int)response.StatusCode == 500 && Capture.String(sample, "fail") is null && Capture.String(sample, "failAfter") is null)
            throw new InvalidOperationException("Undeclared native host failure in " + sample.GetProperty("name").GetString() + ": " + JsonSerializer.Serialize(current.Errors));
        object? jsonBody = null;
        try { jsonBody = JsonSerializer.Deserialize<JsonElement>(body); } catch (JsonException) { }
        results.Add(new { name = sample.GetProperty("name").GetString(), requestPath,
            status = (int)response.StatusCode, contentType = response.Content.Headers.ContentType?.ToString(),
            body, jsonBody, calls = current.Calls.ToArray(), committed = current.Committed.ToArray(),
            remaining = current.Items.Keys.Select(id => id.ToString("N")).Order().ToArray(), errors = current.Errors.ToArray() });
    }
}
finally { client.Dispose(); await application.StopAsync(); await application.DisposeAsync(); }
var assemblyTypes = new[] { typeof(LibraryController), typeof(LibraryManager), typeof(BaseItem), typeof(User), typeof(ApiServiceCollectionExtensions) };
var assemblies = assemblyTypes.Select(type => type.Assembly).Distinct().Select(assembly => new {
    name = assembly.GetName().Name, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).ToArray();
var scope = "Actual loaded LibraryController single/batch DELETE actions through ASP.NET Core MVC, native AddJellyfinApi formatters/options, CommaDelimitedCollectionModelBinder, Guid binding, client-error mapping and ExceptionMiddleware. Concrete LibraryManager.GetItemById<T>(id,user), IsVisibleStandalone, GetCollectionFolders, MediaSourceManager.GetPathProtocol and typed CanDelete(User) execute over neutral entities. Authentication principal/default authorization policy, IUserManager lookup, repository retrieval and DeleteItem commit/fault boundary are controls. No native DeleteItem filesystem/SQL lifecycle, native authentication policy handlers, full server, dirty build-input closure, live media or clients are claimed here.";
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    scope, assemblies, initialItems, permissionMatrix, results }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Capture
{
    public static Guid Id(int index) => Guid.Parse($"a1000000-0000-0000-0000-{index:000000000000}");
    public Dictionary<Guid, BaseItem> Items = new();
    public Dictionary<string, Guid> Names = new();
    public List<object> Calls = new();
    public List<string> Committed = new();
    public List<object> Errors = new();
    public JsonElement Sample;
    public User User = null!;
    public ClaimsPrincipal Principal = null!;
    public IServerConfigurationManager Configuration = null!;
    public ILibraryManager Library = null!;
    public IUserManager Users = null!;
    public LibraryManager Actual = null!;
    public FastConcurrentLru<Guid, BaseItem> Cache = null!;
    public UserRootFolder Root = null!;
    public static bool Flag(JsonElement sample, string key) => sample.TryGetProperty(key, out var value) && value.GetBoolean();
    public static string? String(JsonElement sample, string key) => sample.TryGetProperty(key, out var value) ? value.GetString() : null;

    public Capture() { Reset(JsonDocument.Parse("{\"policy\":\"none\"}").RootElement); }
    public void Reset(JsonElement sample)
    {
        Sample = sample; Items.Clear(); Names.Clear(); Calls.Clear(); Committed.Clear(); Errors.Clear();
        Configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationControl>();
        BaseItem.ConfigurationManager = Configuration;
        BaseItem.Logger = NullLogger<BaseItem>.Instance;
        BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, Configuration.ApplicationPaths, []);
        BaseItem.LocalizationManager = DispatchProxy.Create<ILocalizationManager, EmptyControl>();
        var mediaSource = (MediaSourceManager)RuntimeHelpers.GetUninitializedObject(typeof(MediaSourceManager));
        typeof(MediaSourceManager).GetField("_fileSystem", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(mediaSource, BaseItem.FileSystem);
        BaseItem.MediaSourceManager = mediaSource;
        Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingControl>();
        Users = DispatchProxy.Create<IUserManager, UserControl>(); ((UserControl)(object)Users).Capture = this;
        Library = DispatchProxy.Create<ILibraryManager, LibraryControl>(); ((LibraryControl)(object)Library).Capture = this;
        BaseItem.LibraryManager = Library;
        Actual = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
        Cache = new FastConcurrentLru<Guid, BaseItem>(200);
        var repository = DispatchProxy.Create<IItemRepository, RepositoryControl>(); ((RepositoryControl)(object)repository).Capture = this;
        typeof(LibraryManager).GetField("_cache", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(Actual, Cache);
        typeof(LibraryManager).GetField("_itemRepository", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(Actual, repository);

        Root = new UserRootFolder { Id = Id(1), Path = @"C:\FixtureState\root\default", Name = "UserRootFolder" };
        var aggregate = new AggregateFolder { Id = Id(2), Path = @"C:\FixtureState\root", Name = "AggregateFolder", IsRoot = true };
        var physical = new Folder { Id = Id(3), Path = @"Z:\SyntheticMedia", Name = "PhysicalRoot", ParentId = aggregate.Id, IsRoot = true };
        var collection = new CollectionFolder { Id = Id(4), Path = @"C:\FixtureState\root\default\Library", Name = "CollectionFolder", ParentId = Root.Id,
            PhysicalLocationsList = new[] { physical.Path } };
        var items = new BaseItem[] { Root, aggregate, physical, collection,
            new Audio(), new Audio { Name = "SecondAudio" }, new AudioBook(), new Book(), new Movie(), new Video(),
            new Trailer(), new MusicVideo(), new Episode(), new Series(), new Season(), new MusicAlbum(), new Photo(), new PhotoAlbum(), new Folder(),
            new BoxSet(), new Playlist { OwnerUserId = Id(90), OpenAccess = true }, new MusicArtist(), new Person(), new Genre(),
            new MusicGenre(), new Studio(), new Year(), new UserView(), new PlaylistsFolder { Name = "PlaylistsFolder" },
            new Folder { Name = "RootFolder", IsRoot = true }, new MusicArtist { Name = "PhysicalArtist" },
            new MusicArtist { Name = "RemoteArtist", Path = "http://example.invalid/artist" },
            new Movie { Name = "ActiveMovie", Path = @"Z:\SyntheticMedia\active.mkv" },
            new Audio { Name = "RemoteAudio", Path = "http://example.invalid/audio" }, new Audio { Name = "NullAudio" },
            new Playlist { Name = "PlaylistNull", OwnerUserId = Id(90), OpenAccess = true }, new BoxSet { Name = "BoxSetNull" }
        };
        for (var index = 0; index < items.Length; index++)
        {
            var item = items[index];
            if (item.Id == Guid.Empty) item.Id = Id(index + 1);
            if (string.IsNullOrEmpty(item.Name)) item.Name = item.GetType().Name;
            if (index >= 4 && item.Name is not ("NullAudio" or "PlaylistNull" or "BoxSetNull"))
            {
                item.Path ??= @"Z:\SyntheticMedia\" + item.Name + (item.IsFolder ? "" : ".fixture");
                if (item is not (MusicArtist or Person or Genre or MusicGenre or Studio or Year) || item.Name is "PhysicalArtist" or "RemoteArtist") item.ParentId = physical.Id;
            }
            if (item is Playlist playlist)
            {
                playlist.Path = item.Name == "PlaylistNull" ? null : @"C:\FixtureState\data\playlists\Neutral";
                playlist.ParentId = Guid.Empty;
            }
            Items.Add(item.Id, item); Names.Add(item.Name, item.Id);
        }
        Root.Children = new[] { collection };
        typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(Actual, Root);
        Names.Add("Missing", Id(99)); Names.Add("Empty", Guid.Empty);
        var claim = String(sample, "claim") ?? "owner";
        User = new User("neutral", "fixture-auth", "fixture-reset") { Id = claim == "other" ? Id(91) : Id(90) };
        var policy = String(sample, "policy");
        User.Permissions.Add(new Permission(PermissionKind.EnableAllFolders, !Flag(sample, "hidden")));
        User.Permissions.Add(new Permission(PermissionKind.EnableContentDeletion, policy == "content"));
        User.Permissions.Add(new Permission(PermissionKind.IsAdministrator, policy == "admin"));
        User.Permissions.Add(new Permission(PermissionKind.EnableCollectionManagement, policy == "collection"));
        if (policy is "folder" or "wrong-folder")
            User.Preferences.Add(new Preference(PreferenceKind.EnableContentDeletionFromFolders, (policy == "folder" ? collection.Id : Id(98)).ToString("N")));
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, Flag(sample, "apiKey").ToString()) };
        if (claim != "absent") claims.Add(new Claim(InternalClaimTypes.UserId,
            (claim == "empty" ? Guid.Empty : claim == "missing" ? Id(92) : User.Id).ToString("N")));
        Principal = new ClaimsPrincipal(new ClaimsIdentity(claims, "fixture"));
    }

    public LibraryController Controller()
    {
        var constructor = typeof(LibraryController).GetConstructors().Single();
        var arguments = constructor.GetParameters().Select(parameter => parameter.ParameterType == typeof(ILibraryManager) ? Library
            : parameter.ParameterType == typeof(IUserManager) ? Users
            : parameter.ParameterType == typeof(IServerConfigurationManager) ? Configuration
            : parameter.ParameterType == typeof(ILogger<LibraryController>) ? (object)NullLogger<LibraryController>.Instance
            : DispatchProxy.Create(parameter.ParameterType, typeof(UnsupportedControl))).ToArray();
        return (LibraryController)constructor.Invoke(arguments);
    }

    public string Format(string name, JsonElement sample)
    {
        if (name == "Malformed") return "not-a-guid";
        var id = Names[name]; var format = String(sample, "format");
        return format == "upper" ? id.ToString().ToUpperInvariant() : id.ToString(format ?? "D");
    }
    public string RequestPath(JsonElement sample)
    {
        if (sample.TryGetProperty("path", out var path)) return path.GetString()!;
        if (sample.TryGetProperty("target", out var target))
            return (Flag(sample, "routeCase") ? "/iTeMs/" : "/Items/") + Uri.EscapeDataString(Format(target.GetString()!, sample)) + (Flag(sample, "routeCase") ? "/" : "");
        if (sample.TryGetProperty("query", out var query)) return "/Items" + (query.GetString() == "" ? "" : "?" + query.GetString());
        var values = sample.GetProperty("batch").EnumerateArray().Select(value => Format(value.GetString()!, sample)).ToArray();
        if (Flag(sample, "whitespace")) values = values.Select(value => " \t" + value + "\r ").ToArray();
        var key = String(sample, "key") ?? "ids";
        var parameters = new List<KeyValuePair<string, string?>>();
        if (Flag(sample, "repeatedJoined")) parameters.AddRange(new[] { new KeyValuePair<string, string?>(key, string.Join(',', values)), new(key, "not-a-guid") });
        else if (Flag(sample, "repeated") || Flag(sample, "mixedKeys") || Flag(sample, "repeatedEmpty"))
        {
            parameters.AddRange(values.Select((value, index) => new KeyValuePair<string, string?>(Flag(sample, "mixedKeys") && index == 1 ? "IDS" : key, value)));
            if (Flag(sample, "repeatedEmpty")) parameters.Insert(1, new(key, ""));
        }
        else parameters.Add(new(key, string.Join(',', values)));
        return QueryHelpers.AddQueryString("/Items", parameters);
    }
}

public class OnlyLibraryController : IApplicationFeatureProvider<ControllerFeature>
{
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature)
    {
        foreach (var controller in feature.Controllers.Where(type => type.AsType() != typeof(LibraryController)).ToArray()) feature.Controllers.Remove(controller);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() => Task.FromResult(
        capture.Sample.TryGetProperty("authenticated", out var value) && !value.GetBoolean() ? AuthenticateResult.NoResult()
        : AuthenticateResult.Success(new AuthenticationTicket(capture.Principal, "fixture")));
}
public class UserControl : DispatchProxy
{
    public Capture Capture = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name != "GetUserById") throw new NotSupportedException(method.Name);
        var id = (Guid)args![0]!; Capture.Calls.Add(new { phase = "user", id = id.ToString("N") });
        return id == Capture.User.Id ? Capture.User : null;
    }
}
public class RepositoryControl : DispatchProxy
{
    public Capture Capture = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "RetrieveItem"
        ? Capture.Items.GetValueOrDefault((Guid)args![0]!) : throw new NotSupportedException(method.Name);
}
public class LibraryControl : DispatchProxy
{
    public Capture Capture = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name == "GetItemById")
        {
            var id = (Guid)args![0]!;
            if (args.Length == 2)
            {
                var user = (User?)args[1]; Capture.Calls.Add(new { phase = "item", id = id.ToString("N"), userId = user?.Id.ToString("N") });
                return Capture.Actual.GetItemById<BaseItem>(id, user);
            }
            return Capture.Actual.GetItemById(id);
        }
        if (method.Name == "GetUserRootFolder") return Capture.Root;
        if (method.Name == "GetCollectionFolders") return args!.Length == 1
            ? Capture.Actual.GetCollectionFolders((BaseItem)args[0]!)
            : Capture.Actual.GetCollectionFolders((BaseItem)args[0]!, (IEnumerable<Folder>)args[1]!);
        if (method.Name == "DeleteItem")
        {
            var item = (BaseItem)args![0]!; var options = (DeleteOptions)args[1]!;
            Capture.Calls.Add(new { phase = "delete", id = item.Id.ToString("N"), options.DeleteFileLocation,
                options.DeleteFromExternalProvider, notifyParent = (bool)args[2]! });
            if (Capture.String(Capture.Sample, "fail") == item.Name) throw new IOException("Controlled precommit failure.");
            Capture.Items.Remove(item.Id); Capture.Cache.TryRemove(item.Id, out _); Capture.Committed.Add(item.Id.ToString("N"));
            if (Capture.String(Capture.Sample, "failAfter") == item.Name) throw new IOException("Controlled postcommit failure.");
            return null;
        }
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        throw new NotSupportedException(method.Name);
    }
}
public class ConfigurationControl : DispatchProxy
{
    private readonly ServerConfiguration configuration = new();
    private readonly MediaBrowser.Controller.IServerApplicationPaths paths = DispatchProxy.Create<MediaBrowser.Controller.IServerApplicationPaths, PathControl>();
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_Configuration" => configuration, "get_ApplicationPaths" => paths, _ => throw new NotSupportedException(method.Name) };
}
public class PathControl : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_DataPath" => @"C:\FixtureState\data", "get_ProgramDataPath" => @"C:\FixtureState", "get_MetadataPath" => @"C:\FixtureState\metadata",
        "get_ProgramSystemPath" => @"C:\FixtureSystem", "get_TempDirectory" => @"C:\FixtureState\temp", _ => throw new NotSupportedException(method.Name) };
}
public class RecordingControl : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo"
        ? (args![0] as string == @"Z:\SyntheticMedia\active.mkv" ? new ActiveRecordingInfo { Path = (string)args[0]! } : null)
        : throw new NotSupportedException(method.Name);
}
public class EmptyControl : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.ReturnType == typeof(string) ? ""
        : method.ReturnType.IsValueType ? Activator.CreateInstance(method.ReturnType) : null;
}
public class UnsupportedControl : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => throw new NotSupportedException(method!.Name);
}
public class ErrorCapture(Capture capture) : ILoggerProvider
{
    public ILogger CreateLogger(string name) => new ErrorLogger(capture);
    public void Dispose() { }
    private class ErrorLogger(Capture capture) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => level >= LogLevel.Error;
        public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        { if (level >= LogLevel.Error) capture.Errors.Add(new { type = exception?.GetType().Name, message = exception?.Message ?? formatter(state, exception) }); }
    }
}
