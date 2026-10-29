using System.Data.Common;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Emby.Naming.Common;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Library.Resolvers;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Providers.Manager;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Caching.Memory;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo("en-US");
var nativeName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var nativeFilename = Path.Combine(AppContext.BaseDirectory, nativeName);
var nativeHandle = NativeLibrary.Load(nativeFilename);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly,
    (name, _, _) => name == "e_sqlite3" ? nativeHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var mode = args[0];
var inputBytes = File.ReadAllBytes(args[1]);
using var document = JsonDocument.Parse(inputBytes);
var input = document.RootElement;
var output = Path.GetFullPath(args[2]);
var root = Path.GetFullPath(args[3]);
var source = Path.GetFullPath(args[4]);
var sourceHash = Evidence.Hash(source);
var id = Guid.Parse(input.GetProperty("itemId").GetString()!);
NativeServices? servicesOwner = null;
Exception? operationFailure = null;
var result = new Dictionary<string, object?> {
    ["mode"] = mode, ["inputSha256"] = Evidence.Hash(args[1]), ["sourceSha256"] = sourceHash,
    ["metadataRefreshExecuted"] = false, ["externalDataInvalidationExecuted"] = false,
    ["schemaCreated"] = false, ["phaseAcceptance"] = false, ["releaseAcceptance"] = false,
};
try {
    if (mode == "produce") {
        Directory.CreateDirectory(root);
        var upper = Path.Combine(root, "upper.db"); File.Copy(source, upper, false);
        var schema = Evidence.Schema(upper);
        // A controlled copy of the actual migrated schema, without live or
        // freed-page credentials from the initialized input instance.
        Evidence.ClearAndVacuum(upper);
        if (Evidence.Schema(upper) != schema) throw new InvalidOperationException("Clearing the private producer changed native DDL/history.");
        servicesOwner = new NativeServices(upper, root, input); var services = servicesOwner;
        result["recordingInput"] = input.GetProperty("recordings").Clone(); result["recordingRequests"] = services.RecordingRequests;
        Directory.CreateDirectory(services.Paths.DefaultUserViewsPath);
        var userRoot = services.Library.GetUserRootFolder();
        services.Persistence.SaveItems([userRoot], CancellationToken.None);
        // Match the actual persistent runtime's application-path lifecycle
        // before freezing any read-only/exchange baseline.
        var aggregate = services.Library.RootFolder;
        result["actualRootFolderInitialization"] = true;
        result["rootInitialization"] = new { input = input.GetProperty("rootInitialization").Clone(), aggregate = Project(aggregate),
            virtualChildren = aggregate.VirtualChildren.Select(Project).ToArray() };
        var media = Path.Combine(root, "media"); Directory.CreateDirectory(media);
        var date = DateTime.Parse(input.GetProperty("date").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
        Movie Movie(Guid value, string name, string filename) => new() {
            Id = value, Name = name, Path = Path.Combine(media, filename), ParentId = userRoot.Id,
            DateCreated = date, DateModified = date, DateLastSaved = date,
            RunTimeTicks = long.Parse(input.GetProperty("ticks").GetString()!, CultureInfo.InvariantCulture),
        };
        var item = Movie(id, input.GetProperty("name").GetString()!, "movie.m2ts");
        item.ProviderIds["OpaqueProvider"] = input.GetProperty("opaqueProvider").GetString()!;
        item.ProviderIds["Tmdb"] = "550";
        var other = Movie(Guid.Parse(input.GetProperty("otherId").GetString()!), "Unrelated item", "other.m2ts");
        other.ProviderIds["OpaqueProvider"] = "unrelated:" + input.GetProperty("itemId").GetString();
        services.Persistence.SaveItems([item, other], CancellationToken.None);
        result["actualSaveItems"] = true;
        result["typedWriterStorage"] = Evidence.Storage(upper, id);
        // This is explicit producer input through the real Native EF model.
        // Subsequent lowercase construction never rewrites this opaque text.
        using (var db = services.Factory.CreateDbContext()) {
            var entity = db.BaseItems.Single(value => value.Id == id);
            entity.Data = input.GetProperty("data").GetString();
            db.BaseItems.Single(value => value.Id == other.Id).Data = input.GetProperty("data").GetString();
            db.KeyframeData.Add(new KeyframeData { ItemId = id, TotalDuration = 200000000, KeyframeTicks = [0, 100000000] });
            db.MediaSegments.Add(new MediaSegment { Id = Guid.Parse("D9ACBEEF-12AB-34CD-56EF-012345ABCD00"), ItemId = id,
                SegmentProviderId = "GuidCaseControl", StartTicks = 0, EndTicks = 100000000 });
            db.TrickplayInfos.Add(new TrickplayInfo { ItemId = id, Width = 100, Height = 50,
                TileWidth = 1, TileHeight = 1, ThumbnailCount = 2, Interval = 10000, Bandwidth = 100 });
            db.Chapters.Add(new Chapter { ItemId = id, Item = entity, ChapterIndex = 0, StartPositionTicks = 0, Name = "Controlled chapter" });
            db.SaveChanges();
        }
        Evidence.Stop(upper);
        var lower = Path.Combine(root, "lower.db"); File.Copy(upper, lower, false);
        result["lowercaseProducer"] = Evidence.LowercaseIdentity(lower, id);
        if (Evidence.Schema(upper) != schema || Evidence.Schema(lower) != schema) throw new InvalidOperationException("The controlled identity changed native DDL/history.");
        result["schemaHistoryPreserved"] = true; result["credentialsClearedAndVacuumed"] = true;
        result["programDataPath"] = services.Paths.ProgramDataPath;
        result["controls"] = new[] { new { name = "upper", filename = upper, sha256 = Evidence.Hash(upper), storage = Evidence.Storage(upper, id),
            unrelatedStorage = Evidence.Storage(upper, other.Id), checks = Evidence.Checks(upper), tables = Evidence.Tables(upper) },
            new { name = "lower", filename = lower, sha256 = Evidence.Hash(lower), storage = Evidence.Storage(lower, id),
            unrelatedStorage = Evidence.Storage(lower, other.Id), checks = Evidence.Checks(lower), tables = Evidence.Tables(lower) } };
    } else if (mode == "read") {
        var before = Evidence.Tables(source);
        servicesOwner = new NativeServices(source, root, input); var services = servicesOwner;
        result["recordingInput"] = input.GetProperty("recordings").Clone(); result["recordingRequests"] = services.RecordingRequests;
        var repository = services.Repository.RetrieveItem(id);
        var cold = services.Library.GetItemById(id);
        object? warm = null;
        if (cold is not null) {
            var previous = cold.Name; cold.Name = input.GetProperty("warmName").GetString();
            warm = Project(services.Library.GetItemById(id)); cold.Name = previous;
        }
        var after = Evidence.Tables(source);
        if (before != after || Evidence.Hash(source) != sourceHash) throw new InvalidOperationException("Native cold/warm reads changed the source database.");
        result["actualRepositoryAndMapper"] = true; result["actualLibraryManager"] = true;
        result["repository"] = Project(repository); result["cold"] = Project(cold); result["warm"] = warm;
        result["warmExecuted"] = cold is not null;
        result["warmNotExecutedReason"] = cold is null ? "The actual Native cold lookup returned no item; no object or cache entry was manufactured." : null;
        result["storage"] = Evidence.Storage(source, id); result["checks"] = Evidence.Checks(source);
        result["beforeTables"] = before; result["afterTables"] = after; result["commands"] = services.Trace.Commands;
    } else throw new InvalidOperationException("Unknown Guid premise operation.");
    if (Evidence.Hash(source) != sourceHash) throw new InvalidOperationException("The supplied input database changed.");
    result["sourceUnchanged"] = true; result["passed"] = true;
} catch (Exception error) {
    operationFailure = error;
    result["passed"] = false;
    result["error"] = new { type = error.GetType().FullName, error.Message, error.StackTrace };
    Environment.ExitCode = 1;
} finally {
    try { servicesOwner?.Dispose(); result["componentResourcesDisposed"] = servicesOwner is not null; }
    catch (Exception error) {
        var combined = operationFailure is null ? error : new AggregateException("Native operation and component disposal failed.", operationFailure, error);
        result["componentResourcesDisposed"] = false; result["passed"] = false;
        result["error"] = new { type = combined.GetType().FullName, combined.Message, combined.StackTrace, detail = combined.ToString() };
        Environment.ExitCode = 1;
    }
}
result["assemblies"] = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location))
    .Select(value => new { name = value.GetName().Name, filename = value.Location, sha256 = Evidence.Hash(value.Location) }).ToArray();
result["nativeLibrary"] = new { filename = nativeFilename, sha256 = Evidence.Hash(nativeFilename), rid = RuntimeInformation.RuntimeIdentifier };
File.WriteAllText(output, JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static object? Project(BaseItem? item) => item is null ? null : new {
    id = item.Id.ToString("D"), nativeType = item.GetType().FullName, name = item.Name, path = item.Path,
    parentId = item.ParentId.ToString("D"), overview = item.Overview, providerIds = item.ProviderIds,
    runTimeTicks = item.RunTimeTicks?.ToString(CultureInfo.InvariantCulture),
    dateCreated = item.DateCreated.ToString("O"), dateModified = item.DateModified.ToString("O"),
};

sealed class NativeServices : IDisposable {
    public ServerApplicationPaths Paths { get; }
    public SqlFactory Factory { get; }
    public CommandTrace Trace { get; } = new();
    public BaseItemRepository Repository { get; }
    public ItemPersistenceService Persistence { get; }
    public LibraryManager Library { get; }
    public ProviderManager Providers { get; }
    readonly MemoryCache providerCache = new(new MemoryCacheOptions());
    public List<object> RecordingRequests { get; } = [];
    public NativeServices(string filename, string root, JsonElement input) {
        if (input.GetProperty("recordings").GetProperty("activeRecordingPaths").GetArrayLength() != 0)
            throw new InvalidOperationException("This controlled file-input producer does not supply active LiveTV recordings.");
        foreach (var name in new[] { "metadataProviders", "metadataSavers", "imageProviders" })
            if (input.GetProperty("rootInitialization").GetProperty(name).GetArrayLength() != 0)
                throw new InvalidOperationException("The controlled root initializer does not install metadata/image parts.");
        Video.RecordingsManager = Gateway.Make<IRecordingsManager>((method, values) => {
            if (method.Name != "GetActiveRecordingInfo") throw new NotSupportedException("Unused recordings collaborator: " + method.Name);
            if (values is not { Length: 1 } || values[0] is not string recordingPath
                || (recordingPath != Path.Combine(root, "media", "movie.m2ts") && recordingPath != Path.Combine(root, "media", "other.m2ts")))
                throw new InvalidOperationException("The recordings leaf received a path outside the declared ordinary input files.");
            RecordingRequests.Add(new { method = method.Name, path = recordingPath, result = (object?)null });
            return null;
        });
        var program = Path.Combine(root, "program"); Directory.CreateDirectory(program);
        Paths = new ServerApplicationPaths(program, Path.Combine(program, "log"), Path.Combine(program, "config"),
            Path.Combine(program, "cache"), Path.Combine(program, "web"));
        var settings = new ServerConfiguration { CacheSize = 64, EnableCaseSensitiveItemIds = true };
        var configuration = Gateway.Make<IServerConfigurationManager>((method, _) => method.Name switch {
            "get_Configuration" or "get_CommonConfiguration" => settings, "get_ApplicationPaths" or "get_CommonApplicationPaths" => Paths,
            "GetConfiguration" => new MetadataConfiguration(),
            _ when method.Name.StartsWith("add_", StringComparison.Ordinal) || method.Name.StartsWith("remove_", StringComparison.Ordinal) => null,
            _ => throw new NotSupportedException("Unused configuration collaborator: " + method.Name),
        });
        var appHost = Gateway.Make<IServerApplicationHost>((method, values) => method.Name is "ExpandVirtualPath" or "ReverseVirtualPath"
            ? values![0] : throw new NotSupportedException("Unused host collaborator: " + method.Name));
        var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, Paths, []);
        Factory = new SqlFactory(filename, Trace);
        Repository = new BaseItemRepository(Factory, appHost, new ItemTypeLookup(), configuration, NullLogger<BaseItemRepository>.Instance);
        Persistence = new ItemPersistenceService(Factory, appHost, NullLogger<ItemPersistenceService>.Instance);
        BaseItem.ConfigurationManager = configuration; BaseItem.FileSystem = fileSystem; BaseItem.Logger = NullLogger<BaseItem>.Instance;
        BaseItem.ItemRepository = Repository;
        var protocols = (MediaSourceManager)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(MediaSourceManager));
        typeof(MediaSourceManager).GetField("_fileSystem", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(protocols, fileSystem);
        BaseItem.MediaSourceManager = Gateway.Make<IMediaSourceManager>((method, values) => method.Name == "GetPathProtocol"
            ? protocols.GetPathProtocol((string)values![0]!) : throw new NotSupportedException("Unused media-source collaborator: " + method.Name));
        var collaborators = new Dictionary<Type, object> {
            [typeof(IServerApplicationHost)] = appHost, [typeof(IServerConfigurationManager)] = configuration,
            [typeof(ILoggerFactory)] = NullLoggerFactory.Instance, [typeof(MediaBrowser.Controller.Persistence.IItemRepository)] = Repository,
            [typeof(MediaBrowser.Controller.Persistence.IItemPersistenceService)] = Persistence, [typeof(MediaBrowser.Model.IO.IFileSystem)] = fileSystem,
            [typeof(NamingOptions)] = new NamingOptions(), [typeof(IDirectoryService)] = new DirectoryService(fileSystem),
            [typeof(Lazy<IProviderManager>)] = new Lazy<IProviderManager>(() => Providers),
        };
        var constructor = typeof(LibraryManager).GetConstructors().Single();
        Library = (LibraryManager)constructor.Invoke(constructor.GetParameters().Select(parameter => collaborators.GetValueOrDefault(parameter.ParameterType)).ToArray());
        Library.AddParts([], [new SpecialFolderResolver(fileSystem, Paths), new FolderResolver()], [], [], []);
        BaseItem.LibraryManager = Library;
        Providers = new ProviderManager(null!, null!, configuration, null!, NullLogger<ProviderManager>.Instance, fileSystem,
            Paths, Library, null!, null!, providerCache, null!, null!);
        Providers.AddParts([], [], [], [], [], []);
        BaseItem.ProviderManager = Providers;
    }
    public void Dispose() {
        var errors = new List<Exception>();
        try { Providers.Dispose(); } catch (Exception error) { errors.Add(error); }
        try { providerCache.Dispose(); } catch (Exception error) { errors.Add(error); }
        if (errors.Count != 0) throw new AggregateException("Native component resources failed to dispose.", errors);
    }
}

public class Gateway : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Gateway>(); ((Gateway)(object)value).Handler = handler; return value;
    }
}
sealed class SqlFactory(string filename, CommandTrace trace) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>()
        .UseSqlite(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false, ForeignKeys = true }.ToString())
        .AddInterceptors(trace).Options, NullLogger<JellyfinDbContext>.Instance,
        new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
sealed class CommandTrace : DbCommandInterceptor {
    public List<object> Commands { get; } = [];
    public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result) {
        Commands.Add(new { command.CommandText, parameters = command.Parameters.Cast<DbParameter>().Select(value => new {
            value.ParameterName, dbType = value.DbType.ToString(), clrType = value.Value?.GetType().FullName,
            value = value.Value is null or DBNull ? null : value.Value.ToString(),
        }).ToArray() });
        return result;
    }
}
static class Evidence {
    public static string Hash(string filename) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename)));
    static string Q(string value) => "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
    static SqliteConnection Open(string filename, bool foreignKeys = true) {
        var value = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false, ForeignKeys = foreignKeys }.ToString()); value.Open(); return value;
    }
    static object?[][] Rows(SqliteConnection connection, string sql) {
        using var command = connection.CreateCommand(); command.CommandText = sql; using var reader = command.ExecuteReader();
        var rows = new List<object?[]>();
        while (reader.Read()) rows.Add(Enumerable.Range(0, reader.FieldCount).Select(index => reader.IsDBNull(index) ? null : reader.GetValue(index)).ToArray());
        return rows.ToArray();
    }
    public static string Schema(string filename) {
        using var connection = Open(filename);
        return JsonSerializer.Serialize(new[] { Rows(connection, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"),
            Rows(connection, "SELECT MigrationId,ProductVersion FROM __EFMigrationsHistory ORDER BY MigrationId") });
    }
    public static void ClearAndVacuum(string filename) {
        using var connection = Open(filename, false);
        foreach (var row in Rows(connection, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__EFMigrationsHistory'")) {
            using var command = connection.CreateCommand(); command.CommandText = "DELETE FROM " + Q((string)row[0]!); command.ExecuteNonQuery();
        }
        using var vacuum = connection.CreateCommand(); vacuum.CommandText = "VACUUM"; vacuum.ExecuteNonQuery();
    }
    public static void Stop(string filename) {
        using var connection = Open(filename); using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE"; command.ExecuteNonQuery();
    }
    public static string Tables(string filename) {
        using var connection = Open(filename); var result = new Dictionary<string, object>();
        foreach (var entry in Rows(connection, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
            var name = (string)entry[0]!;
            var rows = Rows(connection, "SELECT * FROM " + Q(name)).Select(value => JsonSerializer.Serialize(value)).Order(StringComparer.Ordinal).ToArray();
            result[name] = new { count = rows.Length, sha256 = Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(rows))) };
        }
        return JsonSerializer.Serialize(result);
    }
    public static object Checks(string filename) {
        using var connection = Open(filename);
        var foreignKeys = Rows(connection, "PRAGMA foreign_key_check"); var integrity = Rows(connection, "PRAGMA integrity_check");
        if (foreignKeys.Length != 0 || integrity.Length != 1 || integrity[0][0] as string != "ok") throw new InvalidOperationException("The controlled Native SQLite failed integrity/FK checks.");
        return new { foreignKeys, integrity };
    }
    public static object Storage(string filename, Guid id) {
        using var connection = Open(filename); using var command = connection.CreateCommand();
        command.CommandText = "SELECT Id,hex(CAST(Id AS BLOB)),Data,hex(CAST(Data AS BLOB)) FROM BaseItems WHERE CAST(Id AS BLOB) IN (CAST($upper AS BLOB),CAST($lower AS BLOB))";
        command.Parameters.AddWithValue("$upper", id.ToString("D").ToUpperInvariant()); command.Parameters.AddWithValue("$lower", id.ToString("D").ToLowerInvariant());
        using var reader = command.ExecuteReader(); if (!reader.Read()) throw new InvalidOperationException("The controlled physical row is absent.");
        var row = new { rawId = reader.GetString(0), idHex = reader.GetString(1), data = reader.IsDBNull(2) ? null : reader.GetString(2), dataHex = reader.GetString(3) };
        if (reader.Read()) throw new InvalidOperationException("The producer created duplicate physical spellings of the same Guid.");
        reader.Close();
        var indexes = Rows(connection, "PRAGMA index_list('BaseItems')");
        var identities = "X'" + Convert.ToHexString(Encoding.UTF8.GetBytes(id.ToString("D").ToUpperInvariant())) + "',X'"
            + Convert.ToHexString(Encoding.UTF8.GetBytes(id.ToString("D").ToLowerInvariant())) + "'";
        var providers = Rows(connection, "SELECT ProviderId,ProviderValue,hex(CAST(ProviderValue AS BLOB)) FROM BaseItemProviders WHERE CAST(ItemId AS BLOB) IN ("
            + identities + ") ORDER BY CAST(ProviderId AS BLOB)").Select(value => new { key = value[0], value = value[1], valueHex = value[2] }).ToArray();
        return new { row, baseItemsSql = Rows(connection, "SELECT sql FROM sqlite_schema WHERE type='table' AND name='BaseItems'"),
            providers, indexes, indexColumns = indexes.Select(value => new { name = value[1], columns = Rows(connection, "PRAGMA index_xinfo(" + Q((string)value[1]!) + ")") }).ToArray() };
    }
    sealed record CellTable(string[] Columns, string[][] Rows);
    static SortedDictionary<string, CellTable> Cells(SqliteConnection connection) {
        var result = new SortedDictionary<string, CellTable>(StringComparer.Ordinal);
        foreach (var table in Rows(connection, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
            var name = (string)table[0]!;
            var columns = Rows(connection, "PRAGMA table_info(" + Q(name) + ")").Select(value => (string)value[1]!).ToArray();
            var projections = columns.Select(column => "typeof(" + Q(column) + ") || ':' || hex(CAST(" + Q(column) + " AS BLOB))");
            result[name] = new CellTable(columns, Rows(connection, "SELECT " + string.Join(',', projections) + " FROM " + Q(name))
                .Select(row => row.Select(value => (string)value!).ToArray()).ToArray());
        }
        return result;
    }
    static string SortedRows(IEnumerable<string[]> rows) => JsonSerializer.Serialize(rows.Select(row => JsonSerializer.Serialize(row)).Order(StringComparer.Ordinal));
    static string Digest(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    public static object LowercaseIdentity(string filename, Guid id) {
        using var connection = Open(filename); var upper = id.ToString("D").ToUpperInvariant(); var lower = id.ToString("D").ToLowerInvariant();
        var columns = new HashSet<(string Table, string Column)> { ("BaseItems", "Id"), ("KeyframeData", "ItemId"), ("MediaSegments", "ItemId"), ("TrickplayInfos", "ItemId") };
        foreach (var row in Rows(connection, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
            var table = (string)row[0]!;
            foreach (var key in Rows(connection, "PRAGMA foreign_key_list(" + Q(table) + ")"))
                if (key[2] as string == "BaseItems" && key[4] as string == "Id") columns.Add((table, (string)key[3]!));
        }
        var before = Cells(connection);
        using var transaction = connection.BeginTransaction();
        using (var defer = connection.CreateCommand()) { defer.Transaction = transaction; defer.CommandText = "PRAGMA defer_foreign_keys = ON"; defer.ExecuteNonQuery(); }
        var observations = new List<object>();
        foreach (var entry in columns.OrderBy(value => value.Table, StringComparer.Ordinal).ThenBy(value => value.Column, StringComparer.Ordinal)) {
            using var command = connection.CreateCommand(); command.Transaction = transaction;
            command.CommandText = "UPDATE " + Q(entry.Table) + " SET " + Q(entry.Column) + "=$lower WHERE CAST(" + Q(entry.Column) + " AS BLOB)=CAST($upper AS BLOB)";
            command.Parameters.AddWithValue("$lower", lower); command.Parameters.AddWithValue("$upper", upper);
            observations.Add(new { table = entry.Table, column = entry.Column, changed = command.ExecuteNonQuery(), parameterType = "SQLite string" });
        }
        transaction.Commit();
        var after = Cells(connection); var verification = new List<object>();
        var oldCell = "text:" + Convert.ToHexString(Encoding.UTF8.GetBytes(upper));
        var newCell = "text:" + Convert.ToHexString(Encoding.UTF8.GetBytes(lower));
        if (!before.Keys.SequenceEqual(after.Keys)) throw new InvalidOperationException("The controlled conversion changed table membership.");
        foreach (var (name, table) in before) {
            var actual = after[name];
            if (!table.Columns.SequenceEqual(actual.Columns)) throw new InvalidOperationException("The controlled conversion changed columns in " + name);
            var expectedRows = table.Rows.Select(row => row.Select((cell, index) => columns.Contains((name, table.Columns[index])) && cell == oldCell ? newCell : cell).ToArray());
            var expected = SortedRows(expectedRows); var observed = SortedRows(actual.Rows);
            if (expected != observed) throw new InvalidOperationException("The controlled conversion changed an undeclared cell in " + name);
            verification.Add(new { table = name, rows = actual.Rows.Length, beforeSha256 = Digest(SortedRows(table.Rows)),
                expectedSha256 = Digest(expected), actualSha256 = Digest(observed) });
        }
        return new { controlledRepresentationOnly = true, ordinaryNativeWriterNotClaimed = true, upper, lower, observations,
            allOtherCellsPreserved = true, verification };
    }
}
