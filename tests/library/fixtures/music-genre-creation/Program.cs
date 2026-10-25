using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Logging.Abstractions;
using BaseItemEntity = Jellyfin.Database.Implementations.Entities.BaseItemEntity;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, values) => Stub.Default(method.ReturnType));
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, values) => method.Name switch {
    "GetPathProtocol" => MediaProtocol.File, "GetMediaStreams" => Array.Empty<MediaStream>(),
    "GetStaticMediaSources" => Array.Empty<MediaSourceInfo>(), _ => Stub.Default(method.ReturnType)
});
var samples = new[] {
    new Sample("fresh", "Rock"), new Sample("repeat", "Rock", Repeat: true),
    new Sample("reuse-name", "Rock", Existing: "MusicGenre"),
    new Sample("replace-movie", "Rock", Existing: "Movie"),
    new Sample("replace-movie-repeat", "Rock", Existing: "Movie", Repeat: true),
    new Sample("replace-genre", "Rock", Existing: "Genre"),
    new Sample("accent", "RÖCK!!!"), new Sample("unicode", "日本語 爵士"),
    new Sample("reserved", " Rock:/|Alt. "), new Sample("empty", ""),
    new Sample("long", new string('界', 70)),
    new Sample("normalized-sensitive", "RoCK", Sensitive: true, Normalized: true),
    new Sample("unnormalized-sensitive", "RoCK", Sensitive: true, Normalized: false),
    new Sample("file-target", "Rock", BlockDirectory: true),
    new Sample("save-failure", "Rock", FailSave: true)
};
var observations = new List<object>();
foreach (var sample in samples) {
    var root = Path.GetFullPath(Path.Combine(args[0], sample.Key));
    Directory.CreateDirectory(root);
    var metadata = Path.Combine(root, "metadata");
    var configuration = new ServerConfiguration { CacheSize = 64,
        EnableCaseSensitiveItemIds = sample.Sensitive, EnableNormalizedItemByNameIds = sample.Normalized };
    var paths = Stub.Make<IServerApplicationPaths>((method, values) => method.Name switch {
        "get_ProgramDataPath" => root, "get_InternalMetadataPath" => metadata,
        "get_DataPath" => Path.Combine(root, "data"), "get_MusicGenrePath" => Path.Combine(metadata, "MusicGenre"),
        _ => Stub.Default(method.ReturnType)
    });
    var config = Stub.Make<IServerConfigurationManager>((method, values) => method.Name switch {
        "get_Configuration" => configuration, "get_ApplicationPaths" => paths,
        "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = config;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => {
        if (method.Name == "ReverseVirtualPath") {
            var value = (string?)values![0];
            return value?.StartsWith(metadata, StringComparison.Ordinal) == true ? "%MetadataPath%" + value[metadata.Length..] : value;
        }
        if (method.Name == "ExpandVirtualPath") {
            var value = (string?)values![0];
            return value?.StartsWith("%MetadataPath%", StringComparison.Ordinal) == true ? metadata + value[14..] : value;
        }
        return Stub.Default(method.ReturnType);
    });
    var factory = new SqlFactory(Path.Combine(root, "native.db"));
    using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var persistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var calls = new List<object>();
    var forwarding = Stub.Make<IItemPersistenceService>((method, values) => {
        if (method.Name == "SaveItems") {
            calls.Add(new { action = "save", items = ((IReadOnlyList<BaseItem>)values![0]!).Select(item => item.Id).ToArray(),
                cancellable = ((CancellationToken)values[1]!).CanBeCanceled });
            if (sample.FailSave) throw new IOException("Controlled save failure");
        }
        return Stub.Forward(persistence, method, values);
    });
    var manager = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    Field(manager, "_configurationManager", config);
    Field(manager, "_logger", NullLogger<LibraryManager>.Instance);
    Field(manager, "_cache", Activator.CreateInstance(typeof(LibraryManager).GetField("_cache", BindingFlags.Instance | BindingFlags.NonPublic)!.FieldType, [64])!);
    Field(manager, "_itemRepository", repository);
    Field(manager, "_persistenceService", forwarding);
    Field(manager, "_userRootFolder", new UserRootFolder { Children = [] });
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions(),
        _ => Stub.Forward(manager, method, values)
    });
    var added = new List<Guid>();
    manager.ItemAdded += (_, change) => { added.Add(change.Item.Id); calls.Add(new { action = "added", id = change.Item.Id, parent = change.Parent?.Id }); };
    var genrePath = MusicGenre.GetPath(sample.Name);
    var genreId = manager.GetMusicGenreId(sample.Name);
    if (sample.Existing is not null) {
        BaseItem existing = sample.Existing switch {
            "Movie" => new Movie(), "Genre" => new Genre(), _ => new MusicGenre()
        };
        existing.Id = genreId; existing.Name = "Existing name"; existing.Path = genrePath;
        existing.Overview = "Retained only when reused"; existing.ProductionYear = 1998;
        existing.Tags = ["curated"]; existing.ProviderIds["Custom"] = "curated-provider";
        persistence.SaveItems([existing], CancellationToken.None);
    }
    if (sample.BlockDirectory) {
        Directory.CreateDirectory(Path.GetDirectoryName(genrePath)!);
        File.WriteAllText(genrePath, "existing file");
    }
    object[] initialRows;
    using (var context = factory.CreateDbContext()) {
        var entity = context.Model.FindEntityType(typeof(BaseItemEntity))!;
        var table = StoreObjectIdentifier.Table(entity.GetTableName()!, entity.GetSchema());
        initialRows = context.BaseItems.AsNoTracking().OrderBy(row => row.Id).ToArray().Select(row => (object)
            entity.GetProperties().ToDictionary(property => property.GetColumnName(table)!, property => property.PropertyInfo!.GetValue(row))).ToArray();
    }
    var results = new List<object>();
    foreach (var attempt in Enumerable.Range(0, sample.Repeat ? 2 : 1)) {
        var began = DateTime.UtcNow;
        BaseItem? returned = null; Exception? error = null;
        try { returned = manager.GetMusicGenre(sample.Name); } catch (Exception failure) { error = failure; }
        var finished = DateTime.UtcNow;
        using var context = factory.CreateDbContext();
        var entity = context.Model.FindEntityType(typeof(BaseItemEntity))!;
        var table = StoreObjectIdentifier.Table(entity.GetTableName()!, entity.GetSchema());
        var rows = context.BaseItems.AsNoTracking().OrderBy(row => row.Id).ToArray().Select(row =>
            entity.GetProperties().ToDictionary(property => property.GetColumnName(table)!, property => property.PropertyInfo!.GetValue(row))).ToArray();
        results.Add(new {
            attempt, began, finished, returned = returned is null ? null : new { returned.Id, returned.Name, returned.Path,
                type = returned.GetType().Name, returned.SortName, returned.DateCreated, returned.DateModified },
            failure = error is null ? null : new { type = error.GetType().FullName, error.Message },
            directoryExists = Directory.Exists(genrePath), fileExists = File.Exists(genrePath),
            directoryCreated = Directory.Exists(genrePath) ? Directory.GetCreationTimeUtc(genrePath) : (DateTime?)null,
            directoryModified = Directory.Exists(genrePath) ? Directory.GetLastWriteTimeUtc(genrePath) : (DateTime?)null,
            rows, providers = context.BaseItemProviders.AsNoTracking().ToArray(), added = added.ToArray(), calls = calls.ToArray()
        });
    }
    observations.Add(new { sample, root, metadata, genrePath, genreId, initialRows, results });
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.GetName().Name).Select(assembly => new { name = assembly.GetName().Name,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    actualLibraryManagerMusicGenre = true, actualPersistenceSqlite = true, actualDirectoryCreation = true,
    dependenciesControlled = new[] { "application paths", "virtual path projection", "collection membership", "save failure injection" },
    mediaOpened = false, portOpened = false, observations, assemblies
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine(JsonSerializer.Serialize(new { cases = observations.Count, actualLibraryManagerMusicGenre = true, actualPersistenceSqlite = true }));

void Field(object owner, string name, object value) => owner.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(owner, value);
public record Sample(string Key, string Name, string? Existing = null, bool Repeat = false, bool Sensitive = false,
    bool Normalized = true, bool BlockDirectory = false, bool FailSave = false);
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var proxy = Create<T, Stub>(); ((Stub)(object)proxy).Handler = handler; return proxy;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values) {
        try { return method.Invoke(target, values); }
        catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; }
    }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
