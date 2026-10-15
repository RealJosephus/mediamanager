using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Providers.Plugins.Tmdb;
using MediaBrowser.Providers.Plugins.Tmdb.TV;
using Microsoft.Extensions.Logging.Abstractions;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using Microsoft.EntityFrameworkCore;
using Microsoft.Data.Sqlite;

if (args[0] == "delete-sql") {
    SQLitePCL.Batteries_V2.Init();
    var started = DateTime.UtcNow;
    var factory = new SqlFactory(args[1]);
    var persistence = new ItemPersistenceService(factory, null!, NullLogger<ItemPersistenceService>.Instance);
    persistence.DeleteItem([Guid.Parse("f3333333-3333-3333-3333-000000000003")]);
    var ended = DateTime.UtcNow;
    using var connection = new SqliteConnection($"Data Source={args[1]};Mode=ReadOnly");
    connection.Open();
    var tables = new Dictionary<string, object>();
    foreach (var table in new[] { "BaseItems", "AncestorIds", "LinkedChildren", "UserData", "Peoples", "PeopleBaseItemMap", "ItemValues", "ItemValuesMap",
        "CustomItemDisplayPreferences", "ItemDisplayPreferences", "MediaSegments", "TrickplayInfos" }) {
        using var command = connection.CreateCommand();
        var fields = table == "BaseItems" || table == "Peoples" ? "Id,Name" : table == "ItemValues" ? "ItemValueId,Value" : "*";
        command.CommandText = $"SELECT {fields} FROM {table}";
        using var reader = command.ExecuteReader();
        var rows = new List<Dictionary<string, object?>>();
        while (reader.Read()) {
            var row = new Dictionary<string, object?>();
            for (var index = 0; index < reader.FieldCount; index++) {
                var key = reader.GetName(index);
                object? value = reader.IsDBNull(index) ? null : reader.GetValue(index);
                if (value is not null && key is "PlaybackPositionTicks" or "StartTicks" or "EndTicks") value = value.ToString();
                if (value is not null && key is "IsFavorite" or "Played" or "Likes" or "RememberIndexing" or "RememberSorting") value = Convert.ToInt64(value) != 0;
                if (value is string text && key.EndsWith("Date")) value = text.Replace(' ', 'T') + (text.EndsWith('Z') ? "" : "Z");
                row[key] = value;
            }
            rows.Add(row);
        }
        tables[table] = rows;
    }
    File.WriteAllText(args[2], JsonSerializer.Serialize(new { started, ended, tables,
        sourceBoundary = "Actual ItemPersistenceService.DeleteItem executes EF SQLite SQL against an isolated synthetic current-schema database. This is not LibraryManager.DeleteItem: alternate promotion, external assets and notifications are outside this recording.",
        assemblySha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(typeof(ItemPersistenceService).Assembly.Location))).ToLowerInvariant(),
        phaseAcceptance = false }, new JsonSerializerOptions { WriteIndented = true }));
    return;
}

var input = JsonNode.Parse(File.ReadAllText(args[0]))!;
var definitions = input["items"]!.AsArray();
var ids = definitions.Select((definition, index) => (name: definition!["name"]!.GetValue<string>(),
    id: Guid.Parse("f2222222-2222-2222-2222-" + (index + 1).ToString("D12")))).ToDictionary(pair => pair.name, pair => pair.id);
var results = new List<object>();
foreach (var sample in input["cases"]!.AsArray()) {
    var items = new Dictionary<Guid, BaseItem>();
    foreach (var definition in definitions) {
        var data = definition!.DeepClone().AsObject();
        var name = data["name"]!.GetValue<string>();
        if (sample!["overrides"]?[name] is JsonObject changes) foreach (var change in changes) data[change.Key] = change.Value?.DeepClone();
        BaseItem item = data["type"]!.GetValue<string>() switch {
            "AggregateFolder" => new AggregateFolder(), "UserRootFolder" => new UserRootFolder(),
            "CollectionFolder" => new CollectionFolder(), "Folder" => new Folder(),
            "Series" => new Series(), "Season" => new Season(), "Episode" => new Episode(),
            _ => throw new NotSupportedException()
        };
        item.Id = ids[name]; item.Name = name; item.Path = data["path"]?.GetValue<string>();
        if (data["parent"] is not null) item.ParentId = ids[data["parent"]!.GetValue<string>()];
        item.IsVirtualItem = data["virtual"]?.GetValue<bool>() ?? false;
        if (data["provider"] is not null) item.ProviderIds[data["provider"]!.GetValue<string>()] = data["providerValue"]!.GetValue<string>();
        if (item is CollectionFolder collection) {
            collection.PhysicalLocationsList = data["locations"]?.AsArray().Select(node => node!.GetValue<string>()).ToArray() ?? [];
            collection.PhysicalFolderIds = data["physicalIds"]?.AsArray().Select(node => ids[node!.GetValue<string>()]).ToArray() ?? [];
        }
        items[item.Id] = item;
    }
    foreach (var folder in items.Values.OfType<Folder>()) {
        folder.Children = items.Values.Where(item => item.ParentId == folder.Id).ToArray();
        folder.LinkedChildren = sample!["links"]?.AsArray().Where(link => ids[link![0]!.GetValue<string>()] == folder.Id)
            .Select(link => new LinkedChild { ItemId = ids[link![1]!.GetValue<string>()] }).ToArray() ?? [];
    }
    var manager = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var dependency = (LibraryProxy)(object)manager;
    dependency.Items = items; dependency.Root = (UserRootFolder)items[ids["root"]];
    dependency.Real = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    BaseItem.LibraryManager = manager;
    var config = JsonSerializer.Deserialize<PluginConfiguration>(sample!["configuration"]!.ToJsonString())!;
    config.EnabledMissingEpisodeLibraries = sample["enabled"]?.AsArray().Select(node => {
        var value = ids[node!.GetValue<string>()];
        var format = sample["enabledFormat"]?.GetValue<string>();
        return format == "hyphenated" ? value.ToString() : format == "uppercase" ? value.ToString("N").ToUpperInvariant() : value.ToString("N");
    }).ToArray() ?? [];
    var plugin = (Plugin)RuntimeHelpers.GetUninitializedObject(typeof(Plugin));
    typeof(BasePlugin<PluginConfiguration>).GetField("_configuration", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(plugin, config);
    typeof(Plugin).GetProperty("Instance")!.SetValue(null, plugin);
    var provider = new TmdbMissingEpisodeProvider(null!, manager, null!, null!, NullLogger<TmdbMissingEpisodeProvider>.Instance);
    var series = (Series)items[ids["series"]];
    var hasChanged = provider.HasChanged(series, null!);
    var collectionFolders = manager.GetCollectionFolders(series).Select(item => item.Id).ToArray();
    var enabled = config.ImportMissingEpisodes || config.ImportUnairedEpisodes;
    enabled = enabled && collectionFolders.Any(id => config.EnabledMissingEpisodeLibraries.Contains(id.ToString("N"), StringComparer.OrdinalIgnoreCase));
    // Active imports are intentionally excluded: they require controlled TMDB
    // transport, season writes and image dependencies that this oracle lacks.
    var updateType = enabled ? (int?)null : (int)await provider.FetchAsync(series, null!,
        new CancellationToken(sample["cancelled"]?.GetValue<bool>() ?? false));
    results.Add(new { name = sample["name"]!.GetValue<string>(), hasChanged, collectionFolders,
        activeImportExcluded = enabled, updateType, removed = dependency.Removed.ToArray(),
        deleteOptions = dependency.Options.ToArray(), childrenInvalidated = typeof(Folder).GetField("_children", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(series) is null });
}
var monitors = new List<object>();
foreach (var sample in input["monitorCases"]!.AsArray()) {
    var config = sample!["configuration"] is null ? null : JsonSerializer.Deserialize<PluginConfiguration>(sample["configuration"]!.ToJsonString());
    Plugin? plugin = null;
    if (config is not null) {
        plugin = (Plugin)RuntimeHelpers.GetUninitializedObject(typeof(Plugin));
        typeof(BasePlugin<PluginConfiguration>).GetField("_configuration", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(plugin, config);
    }
    typeof(Plugin).GetProperty("Instance")!.SetValue(null, plugin);
    BaseItem item = sample["type"]!.GetValue<string>() == "Series" ? new Series() : new Season();
    item.ProviderIds["Tmdb"] = sample["providerValue"]!.GetValue<string>();
    var provider = new TmdbMissingEpisodeProvider(null!, null!, null!, null!, NullLogger<TmdbMissingEpisodeProvider>.Instance);
    monitors.Add(new { name = sample["name"]!.GetValue<string>(), hasChanged = provider.HasChanged(item, null!) });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Hash(File.ReadAllBytes(args[0])), results, monitors,
    runtime = RuntimeInformation.FrameworkDescription,
    assemblies = new[] { typeof(TmdbMissingEpisodeProvider).Assembly, typeof(LibraryManager).Assembly, typeof(BaseItem).Assembly, typeof(object).Assembly }
        .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray(),
    sourceBoundary = "Actual TmdbMissingEpisodeProvider.HasChanged/FetchAsync/PruneAllVirtualEpisodes, Folder.GetRecursiveChildren and LibraryManager.GetCollectionFolders run unmodified. Controlled entity lookup supplies independently declared cached Children and direct links; DeleteItem records requests without SQL, files or events. Active imports are excluded. Persisted query-only AncestorIds and TopParentId cannot alter these entity methods.",
    phaseAcceptance = false }, new JsonSerializerOptions { WriteIndented = true }));
static string Hash(byte[] data) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(data)).ToLowerInvariant();
public class LibraryProxy : DispatchProxy {
    public Dictionary<Guid, BaseItem> Items = null!;
    public UserRootFolder Root = null!;
    public LibraryManager Real = null!;
    public List<Guid> Removed = [];
    public List<object> Options = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetItemById" => Items.GetValueOrDefault((Guid)args![0]!),
        "GetItemList" => ((MediaBrowser.Controller.Entities.InternalItemsQuery)args![0]!).ItemIds.Select(id => Items.GetValueOrDefault(id)).Where(item => item is not null).Cast<BaseItem>().ToArray(),
        "GetCollectionFolders" => Real.GetCollectionFolders((BaseItem)args![0]!, Root.Children.OfType<Folder>()),
        "DeleteItem" => Delete(args!),
        _ => throw new NotSupportedException("Unexpected library call: " + method.Name)
    };
    private object? Delete(object?[] args) {
        Removed.Add(((BaseItem)args[0]!).Id);
        var options = (DeleteOptions)args[1]!;
        Options.Add(new { options.DeleteFileLocation, notifyParentItem = (bool)args[2]! });
        return null;
    }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>()
        .UseSqlite($"Data Source={filename};Pooling=False").Options, NullLogger<JellyfinDbContext>.Instance,
        new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
