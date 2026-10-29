using System.Globalization;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Naming.Common;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Library.Resolvers;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo("en-US");
var nativeName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var nativeFilename = Path.Combine(AppContext.BaseDirectory, nativeName);
var nativeHandle = NativeLibrary.Load(nativeFilename);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) => name == "e_sqlite3" ? nativeHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var inputBytes = File.ReadAllBytes(args[0]); using var document = JsonDocument.Parse(inputBytes); var input = document.RootElement;
var output = Path.GetFullPath(args[1]); var privateRoot = Path.GetFullPath(args[2]); Directory.CreateDirectory(privateRoot);
var sourceFilename = Path.GetFullPath(args[3]); var sourceHash = Evidence.Hash(sourceFilename);
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var name = sample.GetString()!;
    var caseRoot = Path.Combine(privateRoot, name); Directory.CreateDirectory(caseRoot);
    var program = Path.Combine(caseRoot, "program"); Directory.CreateDirectory(program);
    var databaseFilename = Path.Combine(caseRoot, "native.db"); File.Copy(sourceFilename, databaseFilename, false);
    var schema = Evidence.Schema(databaseFilename); Evidence.Clear(databaseFilename);
    var paths = new ServerApplicationPaths(program, Path.Combine(program, "log"), Path.Combine(program, "config"), Path.Combine(program, "cache"), Path.Combine(program, "web"));
    var settings = JsonSerializer.Deserialize<ServerConfiguration>(input.GetProperty("configuration").GetRawText())!;
    var configuration = Stub.Make<IServerConfigurationManager>((method, values) => method.Name switch {
        "get_Configuration" or "get_CommonConfiguration" => settings,
        "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths,
        "GetConfiguration" when values?[0] as string == "metadata" => new MetadataConfiguration(),
        _ when method.Name.StartsWith("add_", StringComparison.Ordinal) || method.Name.StartsWith("remove_", StringComparison.Ordinal) => null,
        _ => throw new NotSupportedException("Unused configuration collaborator: " + method.Name)
    });
    // This component consumes only the user-root path, outside DataPath and
    // InternalMetadataPath; its native virtual-path mapping is the identity.
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name switch {
        "ExpandVirtualPath" or "ReverseVirtualPath" => values![0],
        _ => throw new NotSupportedException("Unused application collaborator: " + method.Name)
    });
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var factory = new SqlFactory(databaseFilename);
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration, NullLogger<BaseItemRepository>.Instance);
    var persistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    BaseItem.ConfigurationManager = configuration; BaseItem.FileSystem = fileSystem; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.ItemRepository = repository;
    // Root persistence asks the actual media-source gateway for PathProtocol.
    // Its resolver consumes only the real ManagedFileSystem supplied here.
    var protocols = (MediaSourceManager)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(MediaSourceManager));
    typeof(MediaSourceManager).GetField("_fileSystem", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(protocols, fileSystem);
    BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, values) => method.Name == "GetPathProtocol"
        ? protocols.GetPathProtocol((string)values![0]!)
        : throw new InvalidOperationException("Unexpected root media-source access: " + method.Name));
    var faultPending = name == "lookup-failure";
    var controlledFailures = new List<object>();
    var observedRepository = Stub.Make<IItemRepository>((method, values) => {
        if (method.Name == "RetrieveItem" && faultPending) {
            faultPending = false;
            controlledFailures.Add(new { operation = method.Name, id = values![0], message = "controlled root repository lookup" });
            throw new IOException("controlled root repository lookup");
        }
        return Stub.Forward(repository, method, values);
    });
    LibraryManager Manager(IItemRepository source) {
        var collaborators = new Dictionary<Type, object> {
            [typeof(IServerApplicationHost)] = appHost, [typeof(IServerConfigurationManager)] = configuration,
            [typeof(ILoggerFactory)] = NullLoggerFactory.Instance, [typeof(IItemRepository)] = source,
            [typeof(IItemPersistenceService)] = persistence, [typeof(IFileSystem)] = fileSystem,
            [typeof(NamingOptions)] = new NamingOptions(), [typeof(IDirectoryService)] = new DirectoryService(fileSystem),
        };
        var constructor = typeof(LibraryManager).GetConstructors().Single();
        var manager = (LibraryManager)constructor.Invoke(constructor.GetParameters().Select(parameter => collaborators.GetValueOrDefault(parameter.ParameterType)).ToArray());
        manager.AddParts([], [new SpecialFolderResolver(fileSystem, paths), new FolderResolver()], [], [], []);
        return manager;
    }
    var library = Manager(observedRepository); BaseItem.LibraryManager = library;
    var id = library.GetNewItemId(paths.DefaultUserViewsPath, typeof(UserRootFolder));
    if (name is "stored" or "wrong-type") {
        BaseItem seed = name == "stored" ? new UserRootFolder() : new Folder();
        seed.Id = id; seed.Path = Path.Combine(program, "old-root"); Apply(seed, input.GetProperty("seed"));
        persistence.SaveItems([seed], CancellationToken.None);
    }
    Folder Child(string key) => new() { Id = library.GetNewItemId(Path.Combine(program, "children", key), typeof(Folder)),
        Name = "Root child " + key, Path = Path.Combine(program, "children", key), ParentId = id,
        DateCreated = DateTime.Parse("2026-10-20T01:02:03.1234567Z", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
        DateModified = DateTime.Parse("2026-10-21T01:02:03.2345678Z", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind) };
    var originalChild = Child("original"); var lateChild = Child("late");
    if (name == "wrong-type") persistence.SaveItems([originalChild], CancellationToken.None);
    // Actual seed persistence collects ancestors through GetCollectionFolders,
    // which may acquire this manager's user root before the child is committed.
    // Measure a fresh actual manager only after all supplied rows are frozen,
    // matching the independent Node runtime that imports this initial database.
    library = Manager(observedRepository); BaseItem.LibraryManager = library;
    var initialDatabaseFilename = Path.Combine(caseRoot, "initial.db"); File.Copy(databaseFilename, initialDatabaseFilename, false);
    var before = Evidence.Tables(databaseFilename);
    var initialRows = Evidence.RawRows(databaseFilename, "BaseItems");
    object? directoryFailure = null;
    if (name == "blocked-directory") {
        Directory.CreateDirectory(Path.GetDirectoryName(paths.DefaultUserViewsPath)!);
        File.WriteAllText(paths.DefaultUserViewsPath, input.GetProperty("blockedBytes").GetString());
        try { library.GetUserRootFolder(); throw new InvalidOperationException("The real directory collision must reject."); }
        catch (IOException exception) { directoryFailure = new { status = "rejected", name = exception.GetType().Name, message = exception.Message, bytesUnchanged = File.ReadAllText(paths.DefaultUserViewsPath) == input.GetProperty("blockedBytes").GetString() }; }
        File.Delete(paths.DefaultUserViewsPath);
    }
    var startedAt = DateTime.UtcNow;
    var concurrent = Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(library.GetUserRootFolder))).GetAwaiter().GetResult();
    var root = (UserRootFolder)concurrent[0];
    var finishedAt = DateTime.UtcNow;
    var initial = Project(root);
    root.Overview = input.GetProperty("warmOverview").GetString();
    var concurrentValues = concurrent.Select(Project).ToArray();
    var repeats = Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(library.GetUserRootFolder))).GetAwaiter().GetResult();
    var repeated = repeats.Select(Project).ToArray();
    var byIdBeforeSave = library.GetItemById(id);
    var byIdBeforeSaveValue = byIdBeforeSave is null ? null : Project(byIdBeforeSave);
    var afterRead = Evidence.Tables(databaseFilename);
    if (JsonSerializer.Serialize(before) != JsonSerializer.Serialize(afterRead)) throw new InvalidOperationException("Reading the singleton changed native tables.");
    object[] initialChildren = [], warmChildren = [], reloadedChildren = [];
    if (name == "wrong-type") {
        initialChildren = root.Children.Select(Project).ToArray();
        persistence.SaveItems([lateChild], CancellationToken.None);
        warmChildren = root.Children.Select(Project).ToArray();
        root.ReleaseCachedChildren();
        reloadedChildren = root.Children.Select(Project).ToArray();
    }
    var beforeCancelledSave = Evidence.Tables(databaseFilename);
    Apply(root, input.GetProperty("saved"));
    using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
    object? cancellation = null;
    try { persistence.SaveItems([root], cancelled.Token); }
    catch (OperationCanceledException exception) { cancellation = new { status = "rejected", name = exception.GetType().Name, message = exception.Message }; }
    if (cancellation is null || JsonSerializer.Serialize(beforeCancelledSave) != JsonSerializer.Serialize(Evidence.Tables(databaseFilename))) throw new InvalidOperationException("Cancelled root saving changed native tables.");
    persistence.SaveItems([root], CancellationToken.None);
    var afterSaved = Evidence.Tables(databaseFilename);
    var warm = Project(root);
    library.RegisterItem(root);
    var registeredSame = ReferenceEquals(root, library.GetItemById(id));
    root.Overview = input.GetProperty("warmOverview").GetString();
    var registered = Project(library.GetItemById(id)!);
    root.Overview = input.GetProperty("saved").GetProperty("overview").GetString();
    var coldLibrary = Manager(repository); BaseItem.LibraryManager = coldLibrary;
    var beforeCold = Evidence.Tables(databaseFilename);
    var cold = (UserRootFolder)coldLibrary.GetUserRootFolder();
    var coldProjection = Project(cold);
    if (JsonSerializer.Serialize(beforeCold) != JsonSerializer.Serialize(Evidence.Tables(databaseFilename))) throw new InvalidOperationException("Cold singleton reads changed native tables.");
    if (Evidence.Schema(databaseFilename) != schema) throw new InvalidOperationException("Root lifecycle changed the native schema/history.");
    results.Add(new { name, programDataPath = program, id, initialDatabaseFilename, initialDatabaseSha256 = Evidence.Hash(initialDatabaseFilename),
        databaseFilename, databaseSha256 = Evidence.Hash(databaseFilename), directoryFailure, controlledFailures,
        initial, concurrent = concurrentValues, repeated, repeatedSame = repeats.All(item => ReferenceEquals(item, root)), directoryExists = Directory.Exists(paths.DefaultUserViewsPath),
        byIdBeforeSave = byIdBeforeSaveValue, before, afterRead, cancellation,
        initialChildren, warmChildren, reloadedChildren, beforeCancelledSave, childIds = new { original = originalChild.Id, late = lateChild.Id },
        initialRows, savedRows = Evidence.RawRows(databaseFilename, "BaseItems"), savedProviders = Evidence.RawRows(databaseFilename, "BaseItemProviders"),
        warm, registered, cold = coldProjection, registeredSame, afterSaved, beforeCold, startedAt, finishedAt,
        foreignKeys = Evidence.ForeignKeys(databaseFilename) });
}
if (Evidence.Hash(sourceFilename) != sourceHash) throw new InvalidOperationException("The supplied stopped source changed.");
File.WriteAllText(output, JsonSerializer.Serialize(new { inputSha256 = Evidence.Hash(args[0]), sourceSha256 = sourceHash,
    actualLibraryManagerConstructor = true, actualGetUserRootFolder = true, actualSpecialFolderResolver = true,
        actualManagedFileSystem = true, actualRepositoryAndTypedMapper = true, actualSqlitePersistence = true,
        measuredManagerConstructedAfterSeedPersistence = true,
    schemaCreated = false, schemaHistoryPreserved = true, results,
    assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location))
        .Select(value => new { name = value.GetName().Name, filename = value.Location, sha256 = Evidence.Hash(value.Location) }),
    nativeLibraries = new[] { new { filename = nativeFilename, sha256 = Evidence.Hash(nativeFilename), rid = RuntimeInformation.RuntimeIdentifier, loadedByExplicitResolver = true } },
    phaseAcceptance = false, releaseAcceptance = false,
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static void Apply(BaseItem item, JsonElement values) {
    item.Name = values.GetProperty("name").GetString(); item.Overview = values.GetProperty("overview").GetString();
    item.Tags = values.GetProperty("tags").EnumerateArray().Select(value => value.GetString()!).ToArray();
    item.DateCreated = DateTime.Parse(values.GetProperty("dateCreated").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    item.DateModified = DateTime.Parse(values.GetProperty("dateModified").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    item.DateLastSaved = DateTime.Parse(values.GetProperty("dateLastSaved").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    if (values.TryGetProperty("providerIds", out var providers)) foreach (var provider in providers.EnumerateObject()) item.ProviderIds[provider.Name] = provider.Value.GetString()!;
}
static object Project(BaseItem item) => new { id = item.Id.ToString("D"), nativeType = item.GetType().FullName, name = item.Name, path = item.Path,
    parentId = item.ParentId.ToString("D"), IsRoot = item is Folder folder && folder.IsRoot, item.IsFolder, item.IsLocked, overview = item.Overview,
    tags = item.Tags.ToArray(), genres = item.Genres.ToArray(), providerIds = new Dictionary<string, string>(item.ProviderIds),
    dateCreated = item.DateCreated.ToString("O"), dateModified = item.DateModified.ToString("O"), dateLastSaved = item.DateLastSaved.ToString("O") };
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var result = Create<T, Stub>(); ((Stub)(object)result).Handler = handler; return result; }
    public static object? Forward(object target, MethodInfo method, object?[]? values) {
        try { return method.Invoke(target, values); }
        catch (TargetInvocationException exception) { ExceptionDispatchInfo.Capture(exception.InnerException!).Throw(); throw; }
    }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false, ForeignKeys = true }.ToString()).Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
public static class Evidence {
    public static string Hash(string filename) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename)));
    static SqliteConnection Open(string filename, bool foreignKeys = true) { var value = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false, ForeignKeys = foreignKeys }.ToString()); value.Open(); return value; }
    static object?[][] Rows(SqliteConnection connection, string sql) {
        using var command = connection.CreateCommand(); command.CommandText = sql; using var reader = command.ExecuteReader(); var rows = new List<object?[]>();
        while (reader.Read()) rows.Add(Enumerable.Range(0, reader.FieldCount).Select(index => reader.IsDBNull(index) ? null : reader.GetValue(index)).ToArray()); return rows.ToArray();
    }
    public static object RawRows(string filename, string table) {
        using var connection = Open(filename); using var command = connection.CreateCommand();
        command.CommandText = "SELECT * FROM \"" + table.Replace("\"", "\"\"") + "\"";
        using var reader = command.ExecuteReader(); var rows = new List<Dictionary<string, object?>>();
        while (reader.Read()) rows.Add(Enumerable.Range(0, reader.FieldCount).ToDictionary(index => reader.GetName(index),
            index => reader.IsDBNull(index) ? null : reader.GetValue(index)));
        return rows;
    }
    public static string Schema(string filename) { using var connection = Open(filename); return JsonSerializer.Serialize(new[] {
        Rows(connection, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"),
        Rows(connection, "SELECT MigrationId,ProductVersion FROM __EFMigrationsHistory ORDER BY MigrationId") }); }
    public static void Clear(string filename) {
        using var connection = Open(filename, false);
        foreach (var row in Rows(connection, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__EFMigrationsHistory' ORDER BY name")) {
            using var command = connection.CreateCommand(); command.CommandText = "DELETE FROM \"" + ((string)row[0]!).Replace("\"", "\"\"") + "\""; command.ExecuteNonQuery();
        }
        using var reset = connection.CreateCommand(); reset.CommandText = "DELETE FROM sqlite_sequence"; reset.ExecuteNonQuery();
    }
    public static object Tables(string filename) {
        using var connection = Open(filename); var result = new Dictionary<string, object>();
        foreach (var entry in Rows(connection, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
            var table = (string)entry[0]!; var rows = Rows(connection, "SELECT * FROM \"" + table.Replace("\"", "\"\"") + "\"")
                .Select(row => JsonSerializer.Serialize(row)).Order(StringComparer.Ordinal).ToArray();
            result[table] = new { count = rows.Length, sha256 = Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(rows))) };
        }
        return result;
    }
    public static object ForeignKeys(string filename) {
        using var connection = Open(filename); var violations = Rows(connection, "PRAGMA foreign_key_check");
        if (Convert.ToInt64(Rows(connection, "PRAGMA foreign_keys")[0][0]) != 1 || violations.Length != 0) throw new InvalidOperationException("Native root relations violate foreign keys.");
        return new { enabled = true, violations };
    }
}
