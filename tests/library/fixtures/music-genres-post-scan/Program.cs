using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Library.Validators;
using Emby.Server.Implementations.Localization;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
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
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, values) => Stub.Default(method.ReturnType));
var bytes = File.ReadAllBytes(args[0]);
var samples = JsonSerializer.Deserialize<Sample[]>(bytes, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
var results = new List<object>();
foreach (var sample in samples) {
    var root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(args[1])!, "instances", results.Count.ToString()));
    Directory.CreateDirectory(root);
    var metadata = Path.Combine(root, "metadata");
    var settings = new ServerConfiguration { CacheSize = 64, EnableNormalizedItemByNameIds = true };
    var paths = Stub.Make<IServerApplicationPaths>((method, values) => method.Name switch {
        "get_ProgramDataPath" => root, "get_InternalMetadataPath" => metadata,
        "get_MusicGenrePath" => Path.Combine(metadata, "MusicGenre"), _ => Stub.Default(method.ReturnType)
    });
    var configuration = Stub.Make<IServerConfigurationManager>((method, values) => method.Name switch {
        "get_Configuration" => settings, "get_ApplicationPaths" => paths,
        "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = configuration;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
    BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => {
        if (method.Name == "ReverseVirtualPath") return ((string?)values![0])?.Replace(metadata, "%MetadataPath%", StringComparison.Ordinal);
        if (method.Name == "ExpandVirtualPath") return ((string?)values![0])?.Replace("%MetadataPath%", metadata, StringComparison.Ordinal);
        return Stub.Default(method.ReturnType);
    });
    var factory = new SqlFactory(Path.Combine(root, "native.sqlite"));
    using (var context = factory.CreateDbContext()) context.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var persistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var manager = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    Field(manager, "_configurationManager", configuration);
    Field(manager, "_logger", NullLogger<LibraryManager>.Instance);
    Field(manager, "_cache", Activator.CreateInstance(typeof(LibraryManager).GetField("_cache", BindingFlags.Instance | BindingFlags.NonPublic)!.FieldType, [64])!);
    Field(manager, "_itemRepository", repository);
    Field(manager, "_persistenceService", persistence);
    Field(manager, "_userRootFolder", new UserRootFolder { Children = [] });
    if (sample.ExistingOwner) persistence.SaveItems([new Folder { Id = Id(901), Name = "Owner anchor" }], CancellationToken.None);
    if (sample.ExistingAlternate) persistence.SaveItems([new Folder { Id = Id(902), Name = "Primary anchor" }], CancellationToken.None);
    foreach (var name in sample.Existing) {
        BaseItem item = sample.ExistingType == "Movie" ? new Movie() : new MusicGenre();
        item.Id = manager.GetMusicGenreId(name); item.Name = "Existing " + name; item.Path = MusicGenre.GetPath(name);
        item.OwnerId = sample.ExistingOwner ? Id(901) : Guid.Empty;
        persistence.SaveItems([item], CancellationToken.None);
        if (sample.ExistingAlternate) {
            using var context = factory.CreateDbContext();
            context.BaseItems.Single(row => row.Id == item.Id).PrimaryVersionId = Id(902);
            context.SaveChanges();
        }
    }
    var inputRows = new List<BaseItemEntity>();
    var values = new List<ItemValue>();
    var maps = new List<ItemValueMap>();
    void Add(int index, string value, string clean, Type type, bool mapped = true, int valueType = 2) {
        var itemId = Id(index); var valueId = Id(index + 1000);
        inputRows.Add(new() { Id = itemId, Type = type.FullName!, Name = value + " source" });
        values.Add(new() { ItemValueId = valueId, Type = (ItemValueType)valueType, Value = value, CleanValue = clean });
        if (mapped) maps.Add(new() { ItemId = itemId, ItemValueId = valueId, Item = null!, ItemValue = null! });
    }
    for (var index = 0; index < sample.Names.Length; index++) Add(index + 1, sample.Names[index], "group-" + index.ToString("D4"), typeof(Audio));
    if (sample.ProbeSourceKinds) {
        Add(10, "Jazz", "jazz", typeof(MusicVideo)); Add(11, "Album", "album", typeof(MusicAlbum));
        Add(12, "Artist", "artist", typeof(MusicArtist)); Add(13, "Book", "book", typeof(AudioBook));
        Add(14, "Movie", "movie", typeof(Movie)); Add(15, "Missing relation", "missing", typeof(Audio), false);
        Add(16, "Tag", "tag", typeof(Audio), true, 4); Add(17, "Z lower", "same", typeof(Audio));
        Add(18, "A upper", "same", typeof(Audio));
    }
    using (var context = factory.CreateDbContext()) {
        context.BaseItems.AddRange(inputRows); context.ItemValues.AddRange(values); context.ItemValuesMap.AddRange(maps); context.SaveChanges();
    }
    var initialIds = manager.GetItemIds(new InternalItemsQuery { IncludeItemTypes = [BaseItemKind.MusicGenre] }).ToArray();
    var names = repository.GetMusicGenreNames();
    var calls = new List<object>(); var progress = new List<double>();
    var tokenSource = new CancellationTokenSource(); if (sample.CancelInitial) tokenSource.Cancel();
    manager.ItemAdded += (_, change) => calls.Add(new { action = "added", id = change.Item.Id, name = change.Item.Name });
    var library = Stub.Make<ILibraryManager>((method, arguments) => {
        if (method.Name == "GetCollectionFolders") return new List<Folder>();
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        if (method.Name == "GetMusicGenre") {
            var name = (string)arguments![0]!; calls.Add(new { action = "lookup", name });
            if (sample.CancelLookup == name) throw new OperationCanceledException("Controlled lookup cancellation");
            if (sample.FailLookup.Contains(name)) throw new IOException("Controlled lookup failure");
        }
        return Stub.Forward(manager, method, arguments);
    });
    BaseItem.LibraryManager = library;
    BaseItem.ProviderManager = Stub.Make<IProviderManager>((method, arguments) => {
        if (method.Name != "RefreshSingleItem") return Stub.Default(method.ReturnType);
        var item = (BaseItem)arguments![0]!; var options = (MetadataRefreshOptions)arguments[1]!;
        var token = (CancellationToken)arguments[2]!;
        calls.Add(new { action = "refresh", id = item.Id, name = item.Name,
            metadataMode = (int)options.MetadataRefreshMode, imageMode = (int)options.ImageRefreshMode,
            options.IsAutomated, options.ForceSave, options.ReplaceAllMetadata, options.ReplaceAllImages, options.RemoveOldMetadata });
        if (sample.CancelRefresh == item.Name) tokenSource.Cancel();
        token.ThrowIfCancellationRequested();
        if (sample.FailRefresh.Contains(item.Name)) throw new IOException("Controlled refresh failure");
        return Task.FromResult(ItemUpdateType.None);
    });
    Exception? error = null;
    try { await new MusicGenresPostScanTask(library, NullLogger<MusicGenresValidator>.Instance, repository)
        .Run(new ProgressSink(value => progress.Add(value)), tokenSource.Token); }
    catch (Exception failure) { error = failure; }
    using var final = factory.CreateDbContext();
    results.Add(new { sample.Name, root, names, initialIds,
        inputRows = inputRows.Select(row => new { row.Id, row.Type, row.Name }).ToArray(),
        values = values.Select(value => new { value.ItemValueId, type = (int)value.Type, value.Value, value.CleanValue }).ToArray(),
        maps = maps.Select(map => new { map.ItemId, map.ItemValueId }).ToArray(),
        calls, progress, failure = error is null ? null : new { type = error.GetType().Name, error.Message },
        genres = final.BaseItems.AsNoTracking().Where(row => row.Type == typeof(MusicGenre).FullName).OrderBy(row => row.Id)
            .Select(row => new { row.Id, row.Name }).ToArray() });
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.GetName().Name).Select(assembly => new { name = assembly.GetName().Name,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
    actualPostScanTask = true, actualValidator = true, actualLibraryManager = true, actualRepository = true,
    actualSqlitePersistence = true, metadataProviderControlled = true, mediaOpened = false, portOpened = false,
    sqliteRuntime = new { name = "e_sqlite3.dll", sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "e_sqlite3.dll")))).ToLowerInvariant() },
    musicGenreSourceTypes = new ItemTypeLookup().MusicGenreTypes, results, assemblies }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine(JsonSerializer.Serialize(new { cases = results.Count, actualPostScanTask = true }));

void Field(object owner, string name, object value) => owner.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(owner, value);
Guid Id(int index) => Guid.Parse("ba320000-0000-0000-0000-" + index.ToString("D12"));
public sealed class Sample {
    public string Name { get; set; } = ""; public string[] Names { get; set; } = [];
    public string[] Existing { get; set; } = []; public string? ExistingType { get; set; }
    public bool ExistingOwner { get; set; } public bool ExistingAlternate { get; set; }
    public string[] FailLookup { get; set; } = []; public string[] FailRefresh { get; set; } = [];
    public bool CancelInitial { get; set; } public string? CancelLookup { get; set; }
    public string? CancelRefresh { get; set; } public bool ProbeSourceKinds { get; set; }
}
public sealed class ProgressSink(Action<double> callback) : IProgress<double> { public void Report(double value) => callback(value); }
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
        NullLogger<JellyfinDbContext>.Instance,
        new SqliteDatabaseProvider(Stub.Make<MediaBrowser.Common.Configuration.IApplicationPaths>((method, values) => Stub.Default(method.ReturnType)), NullLogger<SqliteDatabaseProvider>.Instance),
        new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
    public Task<JellyfinDbContext> CreateDbContextAsync(CancellationToken cancellationToken = default) => Task.FromResult(CreateDbContext());
}
