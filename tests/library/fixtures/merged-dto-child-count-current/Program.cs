using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using BitFaster.Caching.Lru;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Dto;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Common;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Configuration;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using DbLinkType = Jellyfin.Database.Implementations.Entities.LinkedChildType;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo("en-US");
var nativeName = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "e_sqlite3.dll"
    : RuntimeInformation.IsOSPlatform(OSPlatform.OSX) ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var nativeFilename = Path.Combine(AppContext.BaseDirectory, nativeName);
var nativeHandle = NativeLibrary.Load(nativeFilename);
var sqliteResolverCalls = 0;
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) => {
    if (name != "e_sqlite3") return IntPtr.Zero;
    Interlocked.Increment(ref sqliteResolverCalls); return nativeHandle;
});
SQLitePCL.Batteries_V2.Init();
var inputBytes = File.ReadAllBytes(args[0]); using var document = JsonDocument.Parse(inputBytes); var input = document.RootElement;
var output = Path.GetFullPath(args[1]); var privateRoot = Path.GetFullPath(args[2]); Directory.CreateDirectory(privateRoot);
var databaseFilename = Path.Combine(privateRoot, "native.db"); var sourceFilename = Path.GetFullPath(args[3]);
var sourceHash = Evidence.Hash(sourceFilename); File.Copy(sourceFilename, databaseFilename, false);
if (Evidence.Hash(databaseFilename) != sourceHash) throw new InvalidOperationException("The private stopped clone must match the supplied bytes.");
var schemaBefore = Evidence.Schema(databaseFilename); Evidence.Clear(databaseFilename);
if (Evidence.Schema(databaseFilename) != schemaBefore) throw new InvalidOperationException("Setup must preserve the real migrated schema/history.");
var factory = new SqlFactory(databaseFilename); var root = input.GetProperty("root").GetString()!;
var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
    "get_ProgramDataPath" => root, "get_DataPath" => Path.Combine(root, "data"),
    "get_InternalMetadataPath" => Path.Combine(root, "metadata"), _ => Stub.Default(method.ReturnType)
});
var settings = new ServerConfiguration { MetadataCountryCode = "US", UICulture = "en-US", CacheSize = 1024 };
var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
    "get_Configuration" or "get_CommonConfiguration" => settings,
    "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths,
    "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType)
});
var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name switch {
    "get_SystemId" => input.GetProperty("serverId").GetString(), "ExpandVirtualPath" or "ReverseVirtualPath" => values![0],
    _ => Stub.Default(method.ReturnType)
});
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
var localization = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance); await localization.LoadAll();
BaseItem.ConfigurationManager = configuration; BaseItem.LocalizationManager = localization;
BaseItem.FileSystem = fileSystem; BaseItem.Logger = NullLogger<BaseItem>.Instance;
var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration, NullLogger<BaseItemRepository>.Instance);
var links = new LinkedChildrenService(factory, new ItemTypeLookup(), repository);
var counts = new ItemCountService(factory, new ItemTypeLookup(), repository);
BaseItem.ItemRepository = repository; BaseItem.ItemCountService = counts;
var library = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
void Set(object target, string field, object value) => target.GetType().GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
foreach (var pair in new (string, object)[] { ("_cache", new FastConcurrentLru<Guid, BaseItem>(1024)),
    ("_configurationManager", configuration), ("_itemRepository", repository), ("_appHost", appHost),
    ("_fileSystem", fileSystem), ("_logger", NullLogger<LibraryManager>.Instance),
    ("_linkedChildrenService", links), ("_countService", counts) }) Set(library, pair.Item1, pair.Item2);
BaseItem.LibraryManager = library;
var dto = (DtoService)RuntimeHelpers.GetUninitializedObject(typeof(DtoService)); Set(dto, "_libraryManager", library);
var batchMethod = typeof(DtoService).GetMethod("GetChildCountBatch", BindingFlags.Instance | BindingFlags.NonPublic)!;
var singleMethod = typeof(DtoService).GetMethod("GetChildCount", BindingFlags.Instance | BindingFlags.NonPublic)!;
Guid Id(JsonElement value, string property) => value.TryGetProperty(property, out var selected) && selected.ValueKind != JsonValueKind.Null ? Guid.Parse(selected.GetString()!) : Guid.Empty;
Guid? NullableId(JsonElement value, string property) => value.TryGetProperty(property, out var selected) && selected.ValueKind != JsonValueKind.Null ? Guid.Parse(selected.GetString()!) : null;
var users = new Dictionary<string, User>(); var entities = new List<BaseItemEntity>();
foreach (var source in input.GetProperty("items").EnumerateArray()) {
    BaseItem item = source.GetProperty("kind").GetString() switch {
        "Series" => new Series(), "Season" => new Season(), "Episode" => new Episode(), "Movie" => new Movie(),
        "CollectionFolder" => new CollectionFolder(), "UserRootFolder" => new UserRootFolder(), _ => new Folder()
    };
    item.Id = Id(source, "id"); item.Name = source.GetProperty("name").GetString(); item.ParentId = Id(source, "parent");
    item.PresentationUniqueKey = source.GetProperty("presentationKey").GetString()!;
    item.DateCreated = new DateTime(2026, 10, 1, 1, 2, 3, DateTimeKind.Utc); item.DateModified = item.DateCreated;
    if (item is CollectionFolder collection) collection.PhysicalFolderIds = source.GetProperty("physicalIds").EnumerateArray().Select(value => Guid.Parse(value.GetString()!)).ToArray();
    var entity = BaseItemMapper.Map(item, appHost);
    entity.ParentId = NullableId(source, "parent"); entity.SeasonId = NullableId(source, "season");
    entity.TopParentId = NullableId(source, "topParent"); entity.OwnerId = NullableId(source, "owner");
    entity.PrimaryVersionId = NullableId(source, "primary");
    entity.ExtraType = source.TryGetProperty("extra", out var extra) ? (BaseItemExtraType)extra.GetInt32() : null;
    entity.IsVirtualItem = source.GetProperty("virtual").GetBoolean();
    entity.InheritedParentalRatingValue = source.GetProperty("rating").GetInt32();
    entity.PresentationUniqueKey = source.GetProperty("presentationKey").GetString(); entities.Add(entity);
}
using (var db = factory.CreateDbContext()) {
    foreach (var source in input.GetProperty("users").EnumerateArray()) {
        var name = source.GetProperty("name").GetString()!;
        var user = new User(name, "Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider", "Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider") {
            Id = Id(source, "id"), InternalId = users.Count + 1, DisplayMissingEpisodes = source.GetProperty("displayMissing").GetBoolean()
        };
        user.SetPermission(PermissionKind.EnableAllFolders, true);
        if (source.GetProperty("maxRating").ValueKind != JsonValueKind.Null) user.MaxParentalRatingScore = source.GetProperty("maxRating").GetInt32();
        db.Users.Add(user); users.Add(name, user);
    }
    db.BaseItems.AddRange(entities); db.SaveChanges();
    foreach (var source in input.GetProperty("links").EnumerateArray()) db.LinkedChildren.Add(new LinkedChildEntity {
        ParentId = Id(source, "parent"), ChildId = Id(source, "child"), ChildType = (DbLinkType)source.GetProperty("type").GetInt32(),
        SortOrder = source.GetProperty("order").GetInt32()
    });
    db.SaveChanges();
}
var foreignKeys = Evidence.ForeignKeys(databaseFilename); var before = Evidence.Tables(databaseFilename); var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var ids = sample.GetProperty("ids").EnumerateArray().Select(value => Guid.Parse(value.GetString()!)).ToArray();
    var userName = sample.GetProperty("user").GetString()!; var user = userName == "anonymous" ? null : users[userName];
    var lane = sample.GetProperty("lane").GetString()!; Dictionary<Guid, int>? observed;
    if (sample.TryGetProperty("warm", out var warm)) library.GetItemById(Id(warm, "id"))!.PresentationUniqueKey = warm.GetProperty("presentationKey").GetString()!;
    if (lane == "repository") observed = counts.GetChildCountBatch(ids, user);
    else {
        var items = ids.Select(id => library.GetItemById(id) ?? throw new InvalidOperationException("A controlled source must hydrate.")).ToArray();
        if (lane == "dtoBatch") observed = (Dictionary<Guid, int>?)batchMethod.Invoke(dto, [items, user]);
        else if (lane == "singleDto") observed = items.ToDictionary(item => item.Id, item => (int)singleMethod.Invoke(dto, [(Folder)item, user, null])!);
        else throw new InvalidOperationException("Unknown actual count lane.");
    }
    results.Add(new { name = sample.GetProperty("name").GetString(), lane, user = userName,
        counts = (observed ?? new Dictionary<Guid, int>()).Select(pair => new { id = pair.Key.ToString("N"), count = pair.Value }).ToArray() });
}
var after = Evidence.Tables(databaseFilename);
if (JsonSerializer.Serialize(before) != JsonSerializer.Serialize(after)) throw new InvalidOperationException("The actual read-only count consumers changed persisted rows.");
if (Evidence.Schema(databaseFilename) != schemaBefore || Evidence.Hash(sourceFilename) != sourceHash) throw new InvalidOperationException("The protected database/schema changed.");
if (sqliteResolverCalls < 1) throw new InvalidOperationException("The real SQLite queries must bind through the explicit RID resolver.");
File.WriteAllText(output, JsonSerializer.Serialize(new { inputSha256 = Evidence.Hash(args[0]), sourceSha256 = sourceHash,
    databaseFilename, databaseSha256 = Evidence.Hash(databaseFilename), actualItemCountService = true,
    actualDtoCountBatch = true, actualDtoSingleCount = true, actualRepositoryAndTypedMapper = true,
    actualEfSqlite = true, actualFullDtoOrHttpExecuted = false, recordingOrMediaExecution = false,
    schemaCreated = false, schemaHistoryPreserved = true,
    preparation = new { cloneSha256 = sourceHash, schemaJson = schemaBefore, foreignKeys }, before, after, results,
    assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location)).Select(value => new { name = value.GetName().Name, filename = value.Location, sha256 = Evidence.Hash(value.Location) }),
    nativeLibraries = new[] { new { filename = nativeFilename, sha256 = Evidence.Hash(nativeFilename), rid = RuntimeInformation.RuntimeIdentifier,
        loadedByExplicitResolver = true, resolverCalls = sqliteResolverCalls } },
    phaseAcceptance = false, releaseAcceptance = false
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false, ForeignKeys = true }.ToString()).Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
public static class Evidence {
    public static string Hash(string filename) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename)));
    static SqliteConnection Open(string filename, bool foreignKeys = true) { var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false, ForeignKeys = foreignKeys }.ToString()); connection.Open(); return connection; }
    static object[][] Rows(SqliteConnection connection, string sql) {
        using var command = connection.CreateCommand(); command.CommandText = sql; using var reader = command.ExecuteReader(); var rows = new List<object[]>();
        while (reader.Read()) rows.Add(Enumerable.Range(0, reader.FieldCount).Select(i => reader.IsDBNull(i) ? null! : reader.GetValue(i)).ToArray()); return rows.ToArray();
    }
    public static string Schema(string filename) {
        using var connection = Open(filename); return JsonSerializer.Serialize(new[] {
            Rows(connection, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"),
            Rows(connection, "SELECT MigrationId,ProductVersion FROM __EFMigrationsHistory ORDER BY MigrationId") });
    }
    public static void Clear(string filename) {
        using var connection = Open(filename, false);
        foreach (var row in Rows(connection, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__EFMigrationsHistory' ORDER BY name")) {
            using var command = connection.CreateCommand(); command.CommandText = "DELETE FROM \"" + ((string)row[0]).Replace("\"", "\"\"") + "\""; command.ExecuteNonQuery();
        }
        using var reset = connection.CreateCommand(); reset.CommandText = "DELETE FROM sqlite_sequence"; reset.ExecuteNonQuery();
    }
    public static object ForeignKeys(string filename) {
        using var connection = Open(filename);
        var enabled = Convert.ToInt64(Rows(connection, "PRAGMA foreign_keys")[0][0]) == 1;
        var violations = Rows(connection, "PRAGMA foreign_key_check");
        if (!enabled || violations.Length != 0) throw new InvalidOperationException("The controlled seed must retain actual enabled foreign keys and valid relations.");
        return new { enabled, violations };
    }
    public static object Tables(string filename) {
        using var connection = Open(filename); var result = new Dictionary<string, object>();
        foreach (var entry in Rows(connection, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
            var table = (string)entry[0]; var escaped = table.Replace("\"", "\"\"");
            var rows = Rows(connection, "SELECT * FROM \"" + escaped + "\"").Select(row => JsonSerializer.Serialize(row)).Order(StringComparer.Ordinal).ToArray();
            result[table] = new { count = rows.Length, sha256 = Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(rows))) };
        }
        return result;
    }
}
