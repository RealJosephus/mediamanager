using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using BitFaster.Caching.Lru;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv.Channels;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Channels;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var nativeName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var nativeFilename = Path.Combine(AppContext.BaseDirectory, nativeName);
var nativeHandle = NativeLibrary.Load(nativeFilename);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly,
    (name, _, _) => name == "e_sqlite3" ? nativeHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
string Hash(string filename) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename)));
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var root = Path.GetFullPath(args[2]); Directory.CreateDirectory(root);
var originalFilename = Path.GetFullPath(args[3]);
var originalHash = Hash(originalFilename);
var databaseFilename = Path.Combine(root, "native.db");
if (string.Equals(originalFilename, databaseFilename, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("A private database is required.");
File.Copy(originalFilename, databaseFilename, overwrite: false);
var copiedHash = Hash(databaseFilename);
if (copiedHash != originalHash) throw new InvalidOperationException("The stopped database copy differs.");
var factory = new SqlFactory(databaseFilename);
string SchemaAndHistory() {
    using var db = factory.CreateDbContext(); var connection = db.Database.GetDbConnection(); connection.Open();
    using var command = connection.CreateCommand();
    var rows = new List<string>();
    foreach (var sql in new[] { "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name", "SELECT MigrationId, ProductVersion FROM __EFMigrationsHistory ORDER BY MigrationId" }) {
        command.CommandText = sql; using var reader = command.ExecuteReader();
        while (reader.Read()) rows.Add(JsonSerializer.Serialize(Enumerable.Range(0, reader.FieldCount).Select(index => reader.IsDBNull(index) ? null : reader.GetValue(index)).ToArray()));
    }
    return JsonSerializer.Serialize(rows);
}
var schemaAndHistory = SchemaAndHistory();
using (var db = factory.CreateDbContext()) {
    using var transaction = db.Database.BeginTransaction();
    foreach (var table in new[] { "LinkedChildren", "BaseItems", "ItemValues" }) db.Database.ExecuteSqlRaw($"DELETE FROM \"{table}\"");
    transaction.Commit();
}
string Map(string value) => value.Replace("{root}", root, StringComparison.Ordinal).Replace('/', Path.DirectorySeparatorChar);
var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
    "get_DataPath" => Path.Combine(root, "data"), "get_ProgramDataPath" => root, _ => Stub.Default(method.ReturnType)
});
var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
    "get_CommonApplicationPaths" or "get_ApplicationPaths" => paths,
    "get_Configuration" => new ServerConfiguration { CacheSize = 256 }, _ => Stub.Default(method.ReturnType)
});
var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? values![0] : Stub.Default(method.ReturnType));
BaseItem.ConfigurationManager = configuration; BaseItem.Logger = NullLogger<BaseItem>.Instance;
BaseItem.LocalizationManager = Stub.Make<ILocalizationManager>((method, _) => Stub.Default(method.ReturnType));
BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
CollectionFolder.XmlSerializer = Stub.Make<IXmlSerializer>((method, _) => method.Name == "DeserializeFromFile" ? new LibraryOptions() : Stub.Default(method.ReturnType));
CollectionFolder.ApplicationHost = appHost;
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration, NullLogger<BaseItemRepository>.Instance);
BaseItem.ItemRepository = repository;
void Set(object target, string name, object value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
var library = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
Set(library, "_cache", new FastConcurrentLru<Guid, BaseItem>(512)); Set(library, "_itemRepository", repository); Set(library, "_configurationManager", configuration);
BaseItem.LibraryManager = library;
// These are the actual one-hop GetChannel methods; no result or visibility is mocked.
var channelManager = (ChannelManager)RuntimeHelpers.GetUninitializedObject(typeof(ChannelManager));
Set(channelManager, "_libraryManager", library); BaseItem.ChannelManager = channelManager;
var entities = new List<BaseItemEntity>();
foreach (var source in input.GetProperty("items").EnumerateArray()) {
    BaseItem item = source.GetProperty("type").GetString() switch {
        "AggregateFolder" => new AggregateFolder(), "UserRootFolder" => new UserRootFolder(), "CollectionFolder" => new CollectionFolder(),
        "Folder" => new Folder(), "Channel" => new Channel(), "LiveTvChannel" => new LiveTvChannel(), "LiveTvProgram" => new LiveTvProgram(),
        "Movie" => new Movie(), _ => new Video()
    };
    item.Id = Guid.Parse(source.GetProperty("id").GetString()!); item.Name = source.GetProperty("name").GetString();
    item.Path = Map(source.GetProperty("path").GetString()!);
    item.DateCreated = source.TryGetProperty("dateCreated", out var date) ? date.GetDateTime() : new DateTime(2025,1,1,0,0,0,DateTimeKind.Utc);
    if (source.TryGetProperty("parentId", out var parent)) item.ParentId = Guid.Parse(parent.GetString()!);
    if (source.TryGetProperty("channelId", out var channel)) item.ChannelId = Guid.Parse(channel.GetString()!);
    if (source.TryGetProperty("tags", out var tags)) item.Tags = tags.EnumerateArray().Select(value => value.GetString()!).ToArray();
    if (item is CollectionFolder collection) collection.PhysicalLocationsList = source.GetProperty("physicalLocations").EnumerateArray().Select(value => Map(value.GetString()!)).ToArray();
    item.PresentationUniqueKey = item.Id.ToString("N");
    entities.Add(new BaseItemEntity { Id = item.Id, Type = item.GetType().FullName, Name = item.Name, Path = item.Path,
        ParentId = item.ParentId == Guid.Empty ? null : item.ParentId, ChannelId = item.ChannelId == Guid.Empty ? null : item.ChannelId,
        IsFolder = item.IsFolder, MediaType = item.MediaType.ToString(), DateCreated = item.DateCreated, IsVirtualItem = item.IsVirtualItem,
        UnratedType = item.GetBlockUnratedType().ToString(), Tags = string.Join('|', item.Tags), PresentationUniqueKey = item.PresentationUniqueKey,
        Data = JsonSerializer.Serialize(item, item.GetType(), JsonDefaults.Options) });
}
using (var db = factory.CreateDbContext()) {
    db.BaseItems.AddRange(entities); db.SaveChanges();
    foreach (var source in input.GetProperty("items").EnumerateArray()) {
        var id = Guid.Parse(source.GetProperty("id").GetString()!);
        if (!source.TryGetProperty("ancestors", out var ancestors)) continue;
        foreach (var value in ancestors.EnumerateArray()) {
            var parent = Guid.Parse(value.GetString()!);
            db.AncestorIds.Add(new AncestorId { ItemId = id, ParentItemId = parent, Item = entities.Single(row => row.Id == id), ParentItem = entities.Single(row => row.Id == parent) });
        }
    }
    var tagValues = new Dictionary<string, ItemValue>(StringComparer.Ordinal);
    foreach (var entity in entities) foreach (var tag in (entity.Tags ?? "").Split('|', StringSplitOptions.RemoveEmptyEntries)) {
        if (!tagValues.TryGetValue(tag, out var value)) {
            value = new ItemValue { ItemValueId = Guid.NewGuid(), Type = ItemValueType.Tags, Value = tag, CleanValue = tag.ToLowerInvariant() };
            tagValues.Add(tag, value); db.ItemValues.Add(value);
        }
        db.ItemValuesMap.Add(new ItemValueMap { ItemId = entity.Id, ItemValueId = value.ItemValueId, Item = entity, ItemValue = value });
    }
    db.SaveChanges();
}
// Visibility consumes repository-hydrated objects, including actual Channel JSON.
var items = entities.Select(entity => library.GetItemById(entity.Id)!).ToDictionary(item => item.Id);
var userRoot = items.Values.OfType<UserRootFolder>().Single(); userRoot.Children = items.Values.Where(item => item.ParentId == userRoot.Id).ToArray();
Set(library, "_userRootFolder", userRoot); Set(library, "_rootFolder", items.Values.OfType<AggregateFolder>().Single());
object Observe(Func<bool> action) {
    try { return new { value = action(), errorType = (string?)null }; }
    catch (Exception error) { return new { value = (bool?)null, errorType = error.GetType().Name }; }
}
var results = new List<object>(); var queries = new List<object>();
foreach (var sample in input.GetProperty("policies").EnumerateArray()) {
    var policy = sample.GetProperty("policy");
    var user = new User("channel-component", "fixture", "fixture") { Id = Guid.Parse(input.GetProperty("userId").GetString()!) };
    foreach (var name in new[] { "EnableAllFolders", "EnableAllChannels", "EnableLiveTvAccess" }) user.SetPermission(Enum.Parse<PermissionKind>(name), policy.GetProperty(name).GetBoolean());
    foreach (var name in new[] { "EnabledFolders", "BlockedMediaFolders", "EnabledChannels", "BlockedChannels", "BlockedTags", "AllowedTags", "BlockUnratedItems" })
        user.Preferences.Add(new Preference(Enum.Parse<PreferenceKind>(name), string.Join(',', policy.GetProperty(name).EnumerateArray().Select(value => value.GetString()))));
    foreach (var item in items.Values) results.Add(new { policy = sample.GetProperty("name").GetString(), id = item.Id.ToString("N"), sourceType = item.SourceType.ToString(),
        visible = Observe(() => item.IsVisible(user)), standalone = Observe(() => item.IsVisibleStandalone(user)) });
    foreach (var request in input.GetProperty("queries").EnumerateArray()) {
        var query = new InternalItemsQuery(user) { MediaTypes = [MediaType.Video], Recursive = true,
            AncestorIds = [Guid.Parse(input.GetProperty("collectionId").GetString()!)], IsFolder = false, IsVirtualItem = false,
            StartIndex = request.GetProperty("startIndex").GetInt32(), Limit = request.GetProperty("limit").GetInt32(),
            OrderBy = [(ItemSortBy.DateCreated, SortOrder.Descending)], DtoOptions = new DtoOptions(false) };
        var result = library.GetItemsResult(query);
        queries.Add(new { policy = sample.GetProperty("name").GetString(), name = request.GetProperty("name").GetString(),
            ids = result.Items.Select(item => item.Id.ToString("N")), total = result.TotalRecordCount,
            // This is the actual DTO visibility call, after repository count/page.
            visibleIds = result.Items.Where(item => item.IsVisible(user)).Select(item => item.Id.ToString("N")) });
    }
}
if (SchemaAndHistory() != schemaAndHistory || Hash(originalFilename) != originalHash) throw new InvalidOperationException("Protected database/schema changed.");
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualBaseItemVisibility = true, actualChannelManagerAndLibraryManager = true,
    actualEfRepositoryCountAndPage = true, repositoryHydratedEntities = true, recordingExecutorsStarted = false,
    localizationControl = "No rated items; actual category and tag checks only.", inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    databaseFilename, databasePreparation = new { originalFilename, originalHash, copiedHash, retainedSchemaAndMigrationHistory = true, schemaCreated = false, migrationsApplied = false },
    results, queries, assemblies = new[] { typeof(BaseItem).Assembly, typeof(ChannelManager).Assembly, typeof(LibraryManager).Assembly, typeof(BaseItemRepository).Assembly }
        .Distinct().Select(assembly => new { filename = assembly.Location, sha256 = Hash(assembly.Location) }),
    nativeLibraries = new[] { new { filename = nativeFilename, sha256 = Hash(nativeFilename), requiredPackagedImage = true } } },
    new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never }));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False;Foreign Keys=True").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
