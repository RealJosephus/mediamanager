using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using BitFaster.Caching.Lru;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Extensions;
using Jellyfin.Server.Implementations.Item;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Querying;
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
using Microsoft.EntityFrameworkCore;

var bytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(bytes).RootElement;
var capture = new Capture(input);
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders();
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(capture);
builder.Services.AddSingleton<IServerConfigurationManager>(capture.Configuration);
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(options => options.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").RequireAuthenticatedUser().Build());
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(manager => manager.FeatureProviders.Add(new OnlyInstantMix()));
builder.Services.Replace(ServiceDescriptor.Transient<InstantMixController>(_ => new InstantMixController(capture.Users, capture.Dtos, capture.Music, capture.Library)));
var app = builder.Build();
app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers();
await app.StartAsync();
var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var results = new List<object>();
using var client = new HttpClient();
try {
    foreach (var sample in input.GetProperty("requests").EnumerateArray()) {
        capture.Reset(sample);
        using var response = await client.GetAsync(address + sample.GetProperty("path").GetString());
        var body = await response.Content.ReadAsStringAsync();
        results.Add(new { name = sample.GetProperty("name").GetString(), status = (int)response.StatusCode,
            contentType = response.Content.Headers.ContentType?.ToString(), body, calls = capture.Calls.ToArray() });
    }
} finally { await app.StopAsync(); await app.DisposeAsync(); }
var repositoryProbe = RepositoryProbe.Run(Path.Combine(Path.GetDirectoryName(args[1])!, "genre-selector.sqlite"), capture.Configuration);
var sqliteRuntimePath = Path.Combine(AppContext.BaseDirectory, "e_sqlite3.dll");
var sqliteRuntime = new { filename = sqliteRuntimePath, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(sqliteRuntimePath))) };
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.GetName().Name).Select(assembly => new { name = assembly.GetName().Name,
        sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
    actualMvc = true, actualInstantMixController = true, actualMusicManager = true, actualFolderTraversal = true,
    actualLibraryLookup = true, actualMusicGenreIdentity = true, actualDtoService = false, databaseOpened = true, httpDatabaseOpened = false,
    dependenciesControlled = new[] { "authentication principal", "user lookup", "repository entities and genre membership", "genre lookup/fault", "DTO projection" },
    results, repositoryProbe, sqliteRuntime, assemblies }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Capture {
    public readonly JsonElement Input;
    public JsonElement Sample;
    public List<object> Calls = new();
    public Dictionary<Guid, BaseItem> Items = new();
    public Dictionary<Guid, string> GenreNames = new();
    public User Admin = null!, Reader = null!;
    public ClaimsPrincipal Principal = null!;
    public IServerConfigurationManager Configuration = null!;
    public ILibraryManager Library = null!;
    public IUserManager Users = null!;
    public IDtoService Dtos = null!;
    public MusicManager Music = null!;
    public LibraryManager Actual = null!;
    public static Guid Id(int index) => Guid.Parse($"ac310000-0000-0000-0000-{index:000000000000}");
    public static bool Flag(JsonElement sample, string name) => sample.TryGetProperty(name, out var value) && value.GetBoolean();
    public Capture(JsonElement input) { Input = input; Reset(JsonDocument.Parse("{}").RootElement); }
    public void Reset(JsonElement sample) {
        Sample = sample; Calls.Clear(); Items.Clear(); GenreNames.Clear();
        var paths = Stub.Make<IServerApplicationPaths>((method, args) => method.Name switch {
            "get_ProgramDataPath" => @"C:\FixtureMix", "get_InternalMetadataPath" => @"C:\FixtureMix\metadata",
            "get_MusicGenrePath" => @"C:\FixtureMix\metadata\MusicGenre", _ => Stub.Default(method.ReturnType)
        });
        Configuration = Stub.Make<IServerConfigurationManager>((method, args) => method.Name switch {
            "get_Configuration" => new ServerConfiguration(), "get_ApplicationPaths" => paths, _ => Stub.Default(method.ReturnType)
        });
        BaseItem.ConfigurationManager = Configuration; BaseItem.Logger = NullLogger<BaseItem>.Instance;
        BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
        BaseItem.UserDataManager = Stub.Make<IUserDataManager>((method, args) => method.Name == "GetUserData" ? new UserItemData { Key = "fixture" } : Stub.Default(method.ReturnType));
        BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, args) => method.Name == "GetPathProtocol" ? MediaProtocol.File : Stub.Default(method.ReturnType));
        Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, args) => Stub.Default(method.ReturnType));
        Admin = NewUser(1, true); Reader = NewUser(2, false);
        Users = Stub.Make<IUserManager>((method, args) => {
            var id = (Guid)args![0]!; Calls.Add(new { method = method.Name, id });
            return id == Admin.Id ? Admin : id == Reader.Id ? Reader : null;
        });
        Actual = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
        Field(Actual, "_configurationManager", Configuration); Field(Actual, "_cache", new FastConcurrentLru<Guid, BaseItem>(100));
        Field(Actual, "_itemRepository", Stub.Make<IItemRepository>((method, args) => method.Name == "RetrieveItem"
            ? Items.GetValueOrDefault((Guid)args![0]!) : Stub.Default(method.ReturnType)));
        Field(Actual, "_userRootFolder", new UserRootFolder { Children = [] });
        Library = Stub.Make<ILibraryManager>(LibraryCall); BaseItem.LibraryManager = Library;
        Music = new MusicManager(Library);
        foreach (var definition in Input.GetProperty("items").EnumerateArray()) {
            BaseItem item = definition.GetProperty("type").GetString() switch {
                "Audio" => new Audio(), "AudioBook" => new AudioBook(), "Book" => new Book(), "Movie" => new Movie(),
                "MusicAlbum" => new MusicAlbum(), "MusicArtist" => new MusicArtist(), "Playlist" => new Playlist { OpenAccess = true },
                "MusicGenre" => new MusicGenre(), "UserView" => new UserView { ViewType = CollectionType.books }, _ => new Folder()
            };
            item.Id = Id(definition.GetProperty("id").GetInt32()); item.Name = definition.GetProperty("name").GetString();
            item.Overview = "Controlled overview";
            item.Genres = definition.TryGetProperty("genres", out var genres) ? genres.EnumerateArray().Select(value => value.GetString()!).ToArray() : [];
            if (definition.TryGetProperty("parent", out var parent)) item.ParentId = Id(parent.GetInt32());
            if (item is Folder folder) folder.LinkedChildren = [];
            if (item is MusicGenre) GenreNames[item.Id] = item.Name!;
            Items.Add(item.Id, item);
        }
        foreach (var definition in Input.GetProperty("items").EnumerateArray()) {
            var item = Items[Id(definition.GetProperty("id").GetInt32())];
            if (item is UserView view) view.DisplayParentId = Id(definition.GetProperty("displayParent").GetInt32());
            if (item is Folder folder) {
                folder.Children = Items.Values.Where(child => child.ParentId == item.Id).ToArray();
                if (definition.TryGetProperty("links", out var links)) folder.LinkedChildren = links.EnumerateArray()
                    .Select(value => new LinkedChild { ItemId = Id(value.GetInt32()), Type = MediaBrowser.Controller.Entities.LinkedChildType.Manual }).ToArray();
            }
        }
        if (sample.TryGetProperty("warmSource", out var warmSource)) {
            var warmId = Id(warmSource.GetInt32());
            _ = Actual.GetItemById(warmId);
            if (Flag(sample, "removeWarmSource")) Items.Remove(warmId);
            else {
                BaseItem replacement = Flag(sample, "replaceWarmType") ? new Movie() : new MusicAlbum();
                replacement.Id = warmId; replacement.Name = "Repository replacement"; replacement.Genres = ["Jazz"];
                Items[warmId] = replacement;
            }
        }
        Dtos = Stub.Make<IDtoService>((method, args) => {
            var selected = (IReadOnlyList<BaseItem>)args![0]!; var options = (DtoOptions)args[1]!;
            Calls.Add(new { method = method.Name, ids = selected.Select(item => item.Id).ToArray(),
                options.EnableImages, options.EnableUserData, options.ImageTypeLimit,
                fields = options.Fields.Select(field => field.ToString()).ToArray(), imageTypes = options.ImageTypes?.Select(type => type.ToString()).ToArray() });
            return selected.Select(item => new BaseItemDto { Id = item.Id, Name = item.Name, Type = item.GetBaseItemKind(),
                Overview = options.ContainsField(ItemFields.Overview) ? item.Overview : null }).ToArray();
        });
        bool apiKey = Flag(sample, "apiKey"), reader = Flag(sample, "reader");
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, apiKey.ToString()) };
        if (!apiKey) claims.Add(new(InternalClaimTypes.UserId, (reader ? Reader : Admin).Id.ToString("N")));
        if (!reader) claims.Add(new(ClaimTypes.Role, UserRoles.Administrator));
        Principal = new ClaimsPrincipal(new ClaimsIdentity(claims, "fixture"));
    }
    private User NewUser(int id, bool administrator) {
        var user = new User("fixture", "fixture-auth", "fixture-reset") { Id = Id(id) };
        user.Permissions.Add(new Permission(PermissionKind.EnableAllFolders, true));
        user.Permissions.Add(new Permission(PermissionKind.IsAdministrator, administrator));
        return user;
    }
    private object? LibraryCall(MethodInfo method, object?[]? args) {
        if (method.Name == "GetItemById") return args!.Length == 2
            ? method.IsGenericMethod && method.GetGenericArguments()[0] == typeof(Playlist)
                ? Actual.GetItemById<Playlist>((Guid)args[0]!, (User?)args[1])
                : Actual.GetItemById<BaseItem>((Guid)args[0]!, (User?)args[1])
            : Actual.GetItemById((Guid)args[0]!);
        if (method.Name == "GetCollectionFolders") return new List<Folder>();
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        if (method.Name == "GetUserRootFolder") return new UserRootFolder { Children = [] };
        if (method.Name == "GetMusicGenre") {
            var name = (string)args![0]!;
            if (name == "Blocked") {
                Calls.Add(new { method = method.Name, name, id = (Guid?)null });
                throw new IOException("Controlled genre failure");
            }
            var id = Actual.GetMusicGenreId(name);
            var genreName = Flag(Sample, "curated") && name == "Rock" ? "Jazz" : name;
            Calls.Add(new { method = method.Name, name, id, genreName });
            GenreNames[id] = genreName; return new MusicGenre { Id = id, Name = genreName };
        }
        if (method.Name is "GetItemList" or "GetItemsResult") {
            var query = (InternalItemsQuery)args![0]!;
            if (!query.OrderBy.Any(order => order.OrderBy == ItemSortBy.Random)) {
                var children = Items.Values.Where(item => item.ParentId == Id(33)).ToArray();
                return method.Name == "GetItemsResult" ? new QueryResult<BaseItem>(children) : children;
            }
            Calls.Add(new { method = method.Name, query.Limit, genreIds = query.GenreIds });
            var names = query.GenreIds.Select(id => GenreNames.GetValueOrDefault(id)?.GetCleanValue()).ToHashSet();
            return Items.Values.OfType<Audio>().Where(item => item.GetType() == typeof(Audio))
                .Where(item => query.GenreIds.Count == 0 || item.Genres.Any(genre => names.Contains(genre.GetCleanValue())))
                .Take(query.Limit ?? int.MaxValue).Cast<BaseItem>().ToArray();
        }
        return Stub.Default(method.ReturnType);
    }
    private static void Field(object owner, string name, object value) => owner.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(owner, value);
}
public class OnlyInstantMix : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var controller in feature.Controllers.Where(type => type.AsType() != typeof(InstantMixController)).ToArray()) feature.Controllers.Remove(controller);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() => Task.FromResult(Capture.Flag(capture.Sample, "anonymous") ? AuthenticateResult.NoResult()
        : AuthenticateResult.Success(new AuthenticationTicket(capture.Principal, "fixture")));
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Handler(method!, args);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var proxy = Create<T, Stub>(); ((Stub)(object)proxy).Handler = handler; return proxy; }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public static class RepositoryProbe {
    public static object Run(string filename, IServerConfigurationManager configuration) {
        var factory = new SqlFactory(filename);
        var rows = new[] {
            Row(501, typeof(Audio), "Rock audio", "rock", "Rock"),
            Row(502, typeof(Audio), "Jazz audio", "jazz", "Jazz"),
            Row(503, typeof(Audio), "Display genre only", "display", "Rock"),
            Row(504, typeof(AudioBook), "Audiobook", "audiobook", "Rock"),
            Row(505, typeof(Audio), "Empty genre value", "empty", "---"),
            Row(511, typeof(MusicGenre), "Rock", "rock"),
            Row(512, typeof(MusicGenre), "Rock", "jazz"),
            Row(513, typeof(MusicGenre), "Rock", null),
            Row(514, typeof(MusicGenre), "Rock", ""),
            Row(515, typeof(Movie), "Wrong type selector", "rock"),
            Row(516, typeof(MusicGenre), "Rock", "ROCK"),
            Row(517, typeof(MusicGenre), "Duplicate clean selector", "rock"),
        };
        var values = new[] { Value(601, "Rock", "rock"), Value(602, "Jazz", "jazz"), Value(603, "---", "") };
        var maps = new[] { Map(501, 601), Map(504, 601), Map(502, 602), Map(505, 603) };
        using (var context = factory.CreateDbContext()) {
            context.Database.EnsureCreated(); context.BaseItems.AddRange(rows);
            context.ItemValues.AddRange(values); context.ItemValuesMap.AddRange(maps); context.SaveChanges();
        }
        var appHost = Stub.Make<IServerApplicationHost>((method, args) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath"
            ? args![0] : Stub.Default(method.ReturnType));
        var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration, NullLogger<BaseItemRepository>.Instance);
        var actual = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
        typeof(LibraryManager).GetField("_itemRepository", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(actual, repository);
        typeof(LibraryManager).GetField("_configurationManager", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(actual, configuration);
        var queries = new List<object>();
        var library = Stub.Make<ILibraryManager>((method, args) => {
            var query = (InternalItemsQuery)args![0]!;
            queries.Add(new { query.GenreIds, query.Limit, includeItemTypes = query.IncludeItemTypes.Select(type => type.ToString()).ToArray() });
            return actual.GetItemList(query);
        });
        var manager = new MusicManager(library);
        var samples = new (string Name, Guid[] Ids)[] {
            ("matching clean name", [Capture.Id(511)]), ("persisted clean name overrides displayed name", [Capture.Id(512)]),
            ("null clean name", [Capture.Id(513)]), ("empty clean name", [Capture.Id(514)]),
            ("selector type is not constrained", [Capture.Id(515)]), ("clean name keeps case", [Capture.Id(516)]),
            ("duplicate clean selectors", [Capture.Id(511), Capture.Id(517)]), ("empty selector", []),
            ("missing selector", [Capture.Id(599)]), ("empty guid selector", [Guid.Empty])
        };
        var observations = samples.Select(sample => new { name = sample.Name, genreIds = sample.Ids,
            ids = manager.GetInstantMixFromGenreIds(sample.Ids, null, DtoOptions.StoredColumnsOnly).Select(item => item.Id).ToArray() }).ToArray();
        return new { actualMusicManager = true, actualLibraryManager = true, actualRepository = true, sqliteOpened = true,
            rows = rows.Select(row => new { row.Id, row.Type, row.Name, row.CleanName, row.Genres }).ToArray(),
            values = values.Select(value => new { value.ItemValueId, Type = (int)value.Type, value.Value, value.CleanValue }).ToArray(),
            maps = maps.Select(map => new { map.ItemId, map.ItemValueId }).ToArray(), observations, queries };
    }
    private static BaseItemEntity Row(int id, Type type, string name, string? cleanName, string? genres = null) => new() {
        Id = Capture.Id(id), Type = type.FullName!, Name = name, CleanName = cleanName, Genres = genres,
        SortName = name, Data = "{}", MediaType = typeof(Audio).IsAssignableFrom(type) ? "Audio" : "Unknown",
        DateCreated = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc)
    };
    private static ItemValue Value(int id, string value, string clean) => new() {
        ItemValueId = Capture.Id(id), Type = ItemValueType.Genre, Value = value, CleanValue = clean
    };
    private static ItemValueMap Map(int id, int value) => new() {
        ItemId = Capture.Id(id), ItemValueId = Capture.Id(value), Item = null!, ItemValue = null!
    };
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
