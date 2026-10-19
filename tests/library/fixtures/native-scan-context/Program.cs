// Actual frozen LibraryManager collection, library options and content type getters.
using System.Reflection;
using Emby.Naming.Common;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Persistence;
using System.Text.Json;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using Emby.Server.Implementations.Localization;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
var json = new JsonSerializerOptions { WriteIndented = true };
foreach (var sample in input.EnumerateArray()) {
    var name = sample.GetProperty("name").GetString()!;
    var directory = Path.GetFullPath(Path.Combine(args[2], name)); Directory.CreateDirectory(directory);
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_ProgramDataPath" => directory, "get_InternalMetadataPath" => Path.Combine(directory, "metadata"),
        "get_TempDirectory" => Path.Combine(directory, "temp"), _ => Stub.Default(method.ReturnType)
    });
    var configuration = new ServerConfiguration { CacheSize = 64 };
    if (sample.TryGetProperty("contentTypes", out var contentTypes)) {
        var property = typeof(ServerConfiguration).GetProperty("ContentTypes")!;
        property.SetValue(configuration, JsonSerializer.Deserialize(contentTypes.GetRawText(), property.PropertyType));
    }
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => configuration, "get_ApplicationPaths" => paths,
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    var appHost = Stub.Make<IServerApplicationHost>((method, parameters) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? parameters![0] : Stub.Default(method.ReturnType));
    BaseItem Create(JsonElement definition) {
        var type = new[] { typeof(BaseItem).Assembly, typeof(Emby.Server.Implementations.Library.LibraryManager).Assembly }.SelectMany(assembly => assembly.GetTypes()).Single(type => type.Name == definition.GetProperty("type").GetString() && !type.IsAbstract && typeof(BaseItem).IsAssignableFrom(type));
        var item = (BaseItem)Activator.CreateInstance(type)!;
        item.Id = Guid.Parse(definition.GetProperty("id").GetString()!); item.Name = definition.GetProperty("type").GetString()!;
        foreach (var field in new[] { "Tags", "Genres", "Studios", "Artists", "AlbumArtists" }) {
            if (!definition.TryGetProperty(field, out var values)) continue;
            var strings = JsonSerializer.Deserialize<string[]>(values.GetRawText())!;
            if (field == "Artists") { if (item is IHasArtist artist) artist.Artists = strings; }
            else if (field == "AlbumArtists") { if (item is IHasAlbumArtist artist) artist.AlbumArtists = strings; }
            else typeof(BaseItem).GetProperty(field)!.SetValue(item, strings);
        }
        foreach (var field in new[] { "Path", "ParentId", "OwnerId", "PhysicalLocationsList", "PhysicalFolderIds", "CollectionType" }) {
            if (!definition.TryGetProperty(field, out var value)) continue;
            var property = type.GetProperty(field)!;
            property.SetValue(item, JsonSerializer.Deserialize(value.GetRawText(), property.PropertyType, new JsonSerializerOptions { Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() } }));
        }
        if (item is Episode episode && definition.TryGetProperty("SeasonId", out var season)) episode.SeasonId = Guid.Parse(season.GetString()!);
        return item;
    }
    var subject = Create(sample.GetProperty("item"));
    var parents = sample.GetProperty("parents").EnumerateArray().Select(Create).ToArray();
    if (!sample.GetProperty("item").TryGetProperty("ParentId", out _)) subject.ParentId = parents.FirstOrDefault()?.Id ?? Guid.Empty;
    for (var index = 0; index < parents.Length; index++) parents[index].ParentId = index + 1 < parents.Length ? parents[index + 1].Id : Guid.Empty;
    var collections = sample.GetProperty("collections").EnumerateArray().Select(Create).Cast<Folder>().ToArray();
    var lookup = parents.Concat(collections).GroupBy(item => item.Id).ToDictionary(group => group.Key, group => group.First());
    LibraryManager manager = null!;
    var calls = new List<object>();
    var library = Stub.Make<ILibraryManager>((method, parameters) => method.Name switch {
        "GetItemById" => lookup.GetValueOrDefault((Guid)parameters![0]!),
        "GetCollectionFolders" => manager.GetCollectionFolders((BaseItem)parameters![0]!),
        "GetLibraryOptions" => manager.GetLibraryOptions((BaseItem)parameters![0]!),
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.LibraryManager = library;
    var factory = new SqlFactory(Path.Combine(directory, "native.db"));
    using (var context = factory.CreateDbContext()) context.Database.EnsureCreated();
    var persistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var fs = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => null!), fs,
        new(() => null!), new(() => null!), repository, persistence, null!, null!,
        new LinkedChildrenService(factory, new ItemTypeLookup(), repository), null!, new NamingOptions(),
        new DirectoryService(fs), null!, null!, null!, BaseItem.LocalizationManager, null!, new(() => null!));
    var userRoot = new UserRootFolder { Id = Guid.Parse("97910000-0000-0000-0000-000000000099"), Name = "User root", Children = collections };
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, userRoot);
    typeof(LibraryManager).GetField("_rootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager,
        parents.OfType<AggregateFolder>().FirstOrDefault() ?? new AggregateFolder { Id = Guid.Parse("97910000-0000-0000-0000-000000000098"), Children = Array.Empty<BaseItem>() });
    var optionsCache = (System.Collections.Concurrent.ConcurrentDictionary<string, LibraryOptions>)typeof(CollectionFolder)
        .GetField("_libraryOptions", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
    optionsCache.Clear();
    foreach (var definition in sample.GetProperty("collections").EnumerateArray().Append(sample.GetProperty("item"))) {
        if (definition.GetProperty("type").GetString() != "CollectionFolder") continue;
        optionsCache[definition.GetProperty("Path").GetString()!] = new LibraryOptions {
            MetadataCountryCode = definition.TryGetProperty("country", out var country) ? country.GetString() : "CONTROL" };
    }
    string? exception = null; string? parameterName = null; object? result = null;
    try {
        result = new { collectionIds = manager.GetCollectionFolders(subject).Select(value => value.Id.ToString("D")).ToArray(),
            country = manager.GetLibraryOptions(subject).MetadataCountryCode,
            configured = manager.GetConfiguredContentType(subject)?.ToString(),
            inherited = manager.GetInheritedContentType(subject)?.ToString(), contentType = manager.GetContentType(subject)?.ToString() };
    } catch (Exception error) {
        exception = error.GetType().Name; parameterName = (error as ArgumentException)?.ParamName;
        if (exception != (sample.TryGetProperty("expectException", out var expected) ? expected.GetString() : null)) {
            Console.Error.WriteLine(name + ": " + error); throw;
        }
    }
    if (exception is null && sample.TryGetProperty("expectException", out _)) throw new InvalidOperationException("Expected native context failure: " + name);
    results.Add(new { name, exception, parameterName, result });
}
var assemblies = new[] { typeof(BaseItem).Assembly, typeof(LibraryManager).Assembly, typeof(ItemPersistenceService).Assembly }.Distinct()
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location,
        sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualFrozenNativeScanContext = true, results, assemblies,
    scope = "Actual LibraryManager GetCollectionFolders, GetLibraryOptions, configured/inherited/content type methods. Live parent/owner objects, user-root child order and a country marker in the actual CollectionFolder options cache are explicit controls; real EF database is initialized but no item saves or SQL projections are claimed. Tests ordinal paths, first-folder selection, NULL and malformed/numeric override values. No options XML, resolver execution, scanner transactions or complete-library acceptance." }, json) + "\n");
public class Stub : DispatchProxy {
    public Func<MethodInfo,object?[]?,object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T : class { var value = Create<T,Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
