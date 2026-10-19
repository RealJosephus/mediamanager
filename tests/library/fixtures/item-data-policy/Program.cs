// Real frozen ItemPersistenceService.SaveItems and BaseItem relationship getters.
using System.Reflection;
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
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration" ? new ServerConfiguration() : Stub.Default(method.ReturnType));
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
        if (item is Episode episode && definition.TryGetProperty("SeasonId", out var season)) episode.SeasonId = Guid.Parse(season.GetString()!);
        return item;
    }
    var subject = Create(sample.GetProperty("item"));
    var parents = sample.GetProperty("parents").EnumerateArray().Select(Create).ToArray();
    subject.ParentId = parents.FirstOrDefault()?.Id ?? Guid.Empty;
    for (var index = 0; index < parents.Length; index++) parents[index].ParentId = index + 1 < parents.Length ? parents[index + 1].Id : Guid.Empty;
    var collections = sample.GetProperty("collections").EnumerateArray().Select(Create).Cast<Folder>().ToArray();
    var lookup = parents.Concat(collections).GroupBy(item => item.Id).ToDictionary(group => group.Key, group => group.First());
    var library = Stub.Make<ILibraryManager>((method, parameters) => method.Name switch {
        "GetItemById" => lookup.GetValueOrDefault((Guid)parameters![0]!),
        "GetCollectionFolders" => collections.ToList(),
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
    string? exception = null;
    try {
        for (var iteration = 0; iteration < (sample.TryGetProperty("repeat", out var repeat) ? repeat.GetInt32() : 1); iteration++) persistence.SaveItems([subject], cancellation.Token);
    } catch (Exception error) { exception = error.GetType().Name; if (exception != (sample.TryGetProperty("expectException", out var expectedError) ? expectedError.GetString() : null)) Console.Error.WriteLine(error); }
    if (exception != (sample.TryGetProperty("expectException", out var expected) ? expected.GetString() : null)) throw new InvalidOperationException("Unexpected exception for " + name + ": " + exception);
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
    var requiresJson = BaseItemMapper.TypeRequiresDeserialization(subject.GetType());
    var hydrationData = sample.GetProperty("hydrationData").ValueKind == JsonValueKind.Null ? null : sample.GetProperty("hydrationData").GetString();
    storedItem!.Data = hydrationData;
    var hydrated = BaseItemMapper.DeserializeBaseItem(storedItem, NullLogger<BaseItem>.Instance, appHost)!;
    using var stored = factory.CreateDbContext();
    var storedData = stored.BaseItems.Single(item => item.Id == subject.Id).Data;
    results.Add(new { name, exception, nativeType = subject.GetType().ToString(), requiresJson, storedDataIsNull = storedData is null,
        hydrationData, trailers = hydrated.RemoteTrailers?.Select(trailer => trailer.Url).ToArray() });
}
var assemblies = new[] { typeof(BaseItem).Assembly, typeof(ItemPersistenceService).Assembly, typeof(Emby.Server.Implementations.Library.LibraryManager).Assembly, typeof(JellyfinDbContext).Assembly, typeof(SqliteDatabaseProvider).Assembly }.Distinct()
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualFrozenItemDataPolicy = true, results, assemblies,
    scope = "Actual SaveItems/EF SQLite, TypeRequiresDeserialization and DeserializeBaseItem for 27 core types. Hydration Data is explicitly replaced in memory with null, a valid poison payload or malformed text after the real save. Physical Artist parent, collection lookup, library options, recordings and path expansion remain controls. Only exact Data nullness, class policy, native type and hydrated RemoteTrailers URLs are projected; other JSON bytes, fields and tables are excluded." }, json) + "\n");

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
