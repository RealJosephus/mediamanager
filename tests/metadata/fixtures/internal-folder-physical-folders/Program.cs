// Real frozen ItemPersistenceService.SaveItems and BaseItem relationship getters.
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
        foreach (var field in new[] { "Path", "ParentId", "OwnerId", "PhysicalLocationsList", "PhysicalFolderIds", "CollectionType", "Name", "DateCreated", "ExtraType", "PrimaryVersionId", "TopParentId" }) {
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
    var collections = sample.GetProperty("collections").EnumerateArray().Select(Create).ToArray();
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
    var fs = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []); BaseItem.FileSystem = fs;
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => null!), fs,
        new(() => null!), new(() => null!), repository, persistence, null!, null!,
        new LinkedChildrenService(factory, new ItemTypeLookup(), repository), null!, new NamingOptions(),
        new DirectoryService(fs), null!, null!, null!, BaseItem.LocalizationManager, null!, new(() => null!));
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager,
        new UserRootFolder { Id = Guid.Parse("97d10000-0000-0000-0000-000000000098"), Children = Array.Empty<BaseItem>() });
    foreach (var item in parents.Concat(collections)) persistence.SaveItems([item], CancellationToken.None);
    persistence.SaveItems([subject], CancellationToken.None);
    var rootChildren = sample.GetProperty("rootChildren").EnumerateArray().Select(value => collections.Single(item => item.Id == Guid.Parse(value.GetString()!))).ToArray();
    var rootFolder = new AggregateFolder { Id = Guid.Parse("97d10000-0000-0000-0000-000000000099"), Children = rootChildren };
    typeof(LibraryManager).GetField("_rootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, rootFolder);
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager,
        new UserRootFolder { Id = Guid.Parse("97d10000-0000-0000-0000-000000000098"), Children = Array.Empty<BaseItem>() });
    var findCalls = new List<object>();
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, parameters) => {
        if (method.Name == "get_RootFolder") return manager.RootFolder;
        if (method.Name == "GetItemById") return manager.GetItemById((Guid)parameters![0]!);
        if (method.Name == "FindByPath") {
            findCalls.Add(new { path = parameters![0], isFolder = parameters[1] });
            return manager.FindByPath((string)parameters[0]!, (bool?)parameters[1]);
        }
        return Stub.Default(method.ReturnType);
    });
    string? exception = null; string? parameterName = null; object? result = null;
    try {
        var method = typeof(CollectionFolder).GetMethods(BindingFlags.Instance | BindingFlags.NonPublic)
            .Single(method => method.Name == "GetPhysicalFolders" && method.GetParameters().Length == 1);
        var folders = ((IEnumerable<Folder>)method.Invoke(subject, [sample.GetProperty("enableCache").GetBoolean()])!).ToArray();
        result = new { ids = folders.Select(folder => folder.Id.ToString("D")).ToArray(), names = folders.Select(folder => folder.Name).ToArray(), findCalls };
    } catch (Exception error) {
        while (error is TargetInvocationException invocation && invocation.InnerException is not null) error = invocation.InnerException;
        exception = error.GetType().Name; parameterName = (error as ArgumentException)?.ParamName;
        if (exception != (sample.TryGetProperty("expectException", out var expected) ? expected.GetString() : null)) {
            Console.Error.WriteLine(name + ": " + error); throw;
        }
        result = new { findCalls };
    }
    if (exception is null && sample.TryGetProperty("expectException", out _)) throw new InvalidOperationException("Expected native physical-folder failure: " + name);
    results.Add(new { name, exception, parameterName, result });
}
var assemblies = new[] { typeof(BaseItem).Assembly, typeof(LibraryManager).Assembly, typeof(ItemPersistenceService).Assembly }.Distinct()
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location,
        sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualFrozenInternalPhysicalFolders = true, results, assemblies,
    scope = "Actual CollectionFolder GetPhysicalFolders, ManagedFileSystem.AreEqual and LibraryManager FindByPath/GetItemById with actual repository/mapper/EF SQLite. Physical-root Children array and configuration are controlled. Captures selected IDs/names and FindByPath argument order, including raw path spellings, newest-row fallback, ownership/alternate filters, cache-ID lookup and declared NULL errors. No filesystem resolver, options XML, ValidateChildren, manager refresh cache mutation or full-library acceptance." }, json) + "\n");
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
