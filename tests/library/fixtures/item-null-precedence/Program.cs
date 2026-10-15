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
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => new ServerConfiguration { CacheSize = 64, EnableCaseSensitiveItemIds = sample.TryGetProperty("caseSensitive", out var sensitive) && sensitive.GetBoolean() }, "get_ApplicationPaths" => paths,
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    var appHost = Stub.Make<IServerApplicationHost>((method, parameters) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? parameters![0] : Stub.Default(method.ReturnType));
    BaseItem Create(JsonElement definition) {
        var type = new[] { typeof(BaseItem).Assembly, typeof(Emby.Server.Implementations.Library.LibraryManager).Assembly }.SelectMany(assembly => assembly.GetTypes()).Single(type => type.Name == definition.GetProperty("type").GetString() && !type.IsAbstract && typeof(BaseItem).IsAssignableFrom(type));
        var item = (BaseItem)Activator.CreateInstance(type)!;
        item.Id = Guid.Parse(definition.GetProperty("id").GetString()!); item.Name = definition.GetProperty("type").GetString()!;
        foreach (var field in new[] { "Tags", "Genres", "Studios", "Artists", "AlbumArtists", "ProductionLocations" }) {
            if (!definition.TryGetProperty(field, out var values)) continue;
            var strings = JsonSerializer.Deserialize<string[]>(values.GetRawText())!;
            if (field == "Artists") { if (item is IHasArtist artist) artist.Artists = strings; }
            else if (field == "AlbumArtists") { if (item is IHasAlbumArtist artist) artist.AlbumArtists = strings; }
            else typeof(BaseItem).GetProperty(field)!.SetValue(item, strings);
        }
        foreach (var field in new[] { "Path", "ParentId", "OwnerId", "PhysicalLocationsList", "PhysicalFolderIds" }) {
            if (!definition.TryGetProperty(field, out var value)) continue;
            var property = type.GetProperty(field)!;
            property.SetValue(item, JsonSerializer.Deserialize(value.GetRawText(), property.PropertyType));
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
        "GetCollectionFolders" => manager.GetCollectionFolders((BaseItem)parameters![0]!, collections),
        "GetLibraryOptions" => new LibraryOptions(),
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.LibraryManager = library;
    var factory = new SqlFactory(Path.Combine(directory, "native.db"));
    var seedIds = new HashSet<Guid>();
    using (var context = factory.CreateDbContext()) {
        context.Database.EnsureCreated();
        foreach (var definition in sample.GetProperty("persistedItems").EnumerateArray()) {
            var id = Guid.Parse(definition.GetProperty("id").GetString()!);
            context.BaseItems.Add(new BaseItemEntity { Id = id, Type = "MediaBrowser.Controller.Entities.Folder", Name = "Seed" });
        }
        context.SaveChanges();
        foreach (var definition in sample.GetProperty("values").EnumerateArray()) {
            var id = Guid.Parse(definition.GetProperty("id").GetString()!); seedIds.Add(id);
            context.ItemValues.Add(new ItemValue { ItemValueId = id, Type = (ItemValueType)definition.GetProperty("type").GetInt32(),
                Value = definition.GetProperty("value").GetString()!, CleanValue = definition.GetProperty("cleanValue").GetString()! });
            foreach (var target in definition.GetProperty("items").EnumerateArray()) context.ItemValuesMap.Add(new ItemValueMap { Item = null!, ItemValue = null!, ItemId = Guid.Parse(target.GetString()!), ItemValueId = id });
        }
        foreach (var ancestor in sample.GetProperty("ancestors").EnumerateArray()) context.AncestorIds.Add(new AncestorId { Item = null!, ParentItem = null!, ItemId = subject.Id, ParentItemId = Guid.Parse(ancestor.GetString()!) });
        context.SaveChanges();
        if (sample.TryGetProperty("failure", out var failure)) context.Database.ExecuteSqlRaw(failure.GetString() == "values"
            ? "CREATE TRIGGER fail_save AFTER INSERT ON ItemValuesMap BEGIN SELECT RAISE(ABORT, 'Controlled value-map failure'); END"
            : "CREATE TRIGGER fail_save AFTER DELETE ON AncestorIds BEGIN SELECT RAISE(ABORT, 'Controlled ancestor failure'); END");
    }
    using var cancellation = new CancellationTokenSource();
    if (sample.TryGetProperty("cancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
    var persistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var fs = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => null!), fs,
        new(() => null!), new(() => null!), repository, persistence, null!, null!,
        new LinkedChildrenService(factory, new ItemTypeLookup(), repository), null!, new NamingOptions(),
        new DirectoryService(fs), null!, null!, null!, BaseItem.LocalizationManager, null!, new(() => null!));
    manager.ItemAdded += (_, eventArgs) => calls.Add(new { action = "added", id = eventArgs.Item.Id.ToString("D"), parentId = eventArgs.Parent?.Id.ToString("D") });
    if (subject.Id != manager.GetNewItemId(subject.Path, subject.GetType())) throw new InvalidOperationException("Fixture ID differs from the actual native identity: " + name);
    string? mapperException = null; string? mapperParameter = null; object? mapperColumns = null;
    try {
        var preview = BaseItemMapper.Map(subject, appHost);
        mapperColumns = new { preview.Artists, preview.AlbumArtists, preview.Genres, preview.Studios, preview.Tags, preview.ProductionLocations };
    } catch (ArgumentNullException error) { mapperException = error.GetType().Name; mapperParameter = error.ParamName; }
    string? exceptionParameter = null;
    string? exception = null;
    try {
        for (var iteration = 0; iteration < (sample.TryGetProperty("repeat", out var repeat) ? repeat.GetInt32() : 1); iteration++) manager.CreateItems([subject], null, cancellation.Token);
    } catch (Exception error) { exception = error.GetType().Name; exceptionParameter = (error as ArgumentNullException)?.ParamName; if (exception != (sample.TryGetProperty("expectException", out var expectedError) ? expectedError.GetString() : null)) Console.Error.WriteLine(error); }
    if (exception is not null && exception is not "ArgumentNullException" && exception is not "NullReferenceException") throw new InvalidOperationException("Unexpected exception for " + name + ": " + exception);
    using var final = factory.CreateDbContext();
    var allValues = final.ItemValues.ToArray();
    string ValueId(Guid id) {
        var value = allValues.Single(value => value.ItemValueId == id);
        return seedIds.Contains(id) ? id.ToString("D") : "$NEW/" + (int)value.Type + "/" + value.Value;
    }
    var valuesAfter = allValues.Select(value => new { id = ValueId(value.ItemValueId), type = (int)value.Type, value = value.Value, cleanValue = value.CleanValue }).OrderBy(value => value.id, StringComparer.Ordinal).ToArray();
    var maps = final.ItemValuesMap.AsEnumerable().Select(map => new { itemId = map.ItemId.ToString("D"), valueId = ValueId(map.ItemValueId) }).OrderBy(map => map.itemId, StringComparer.Ordinal).ThenBy(map => map.valueId, StringComparer.Ordinal).ToArray();
    var ancestors = final.AncestorIds.AsEnumerable().Select(row => new { itemId = row.ItemId.ToString("D"), parentId = row.ParentItemId.ToString("D") }).OrderBy(row => row.itemId, StringComparer.Ordinal).ThenBy(row => row.parentId, StringComparer.Ordinal).ToArray();
    var storedItem = final.BaseItems.SingleOrDefault(item => item.Id == subject.Id);
    results.Add(new { name, exception, exceptionParameter, mapperException, mapperParameter, mapperColumns, nativeType = subject.GetType().ToString(), storedDataIsNull = storedItem?.Data is null, calls, collectionIds = manager.GetCollectionFolders(subject, collections).Select(item => item.Id.ToString("D")).ToArray(), supportsAncestors = subject.SupportsAncestors, hasArtist = subject is IHasArtist, hasAlbumArtist = subject is IHasAlbumArtist,
        values = valuesAfter, maps, ancestors, columns = storedItem is null ? null : new { storedItem.Artists, storedItem.AlbumArtists, storedItem.Genres, storedItem.Studios, storedItem.Tags, storedItem.ProductionLocations } });
}
var assemblies = new[] { typeof(BaseItem).Assembly, typeof(ItemPersistenceService).Assembly, typeof(Emby.Server.Implementations.Library.LibraryManager).Assembly, typeof(JellyfinDbContext).Assembly, typeof(SqliteDatabaseProvider).Assembly }.Distinct()
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualFrozenItemNullPrecedence = true, results, assemblies,
    scope = "Actual mapper preview, LibraryManager.CreateItems and EF SaveItems: Audio all 63 nonempty combinations of six null lists plus inherited parent/collection null tags, and six AudioBook/MusicAlbum inheritance controls. Parent/owner lookup, user-root child array, library options and path reversal are controls. Native deterministic identity is checked for every subject. Projects mapper/save exception type and parameter, six SQL columns, relations and events. Excludes full JSON, other types and complete ValidateChildren/library acceptance." }, json) + "\n");

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
