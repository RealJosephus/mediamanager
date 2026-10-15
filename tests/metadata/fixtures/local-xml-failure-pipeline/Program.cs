using System.Globalization;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Emby.Naming.Common;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.LocalMetadata.Savers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Providers.BoxSets;
using MediaBrowser.Providers.Manager;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init(); CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
var stateRoot = Path.GetFullPath(args[1]); Directory.CreateDirectory(stateRoot);
var results = new List<object>();
var input = JsonDocument.Parse(File.ReadAllBytes(args[0]));
foreach (var fault in input.RootElement.GetProperty("faults").EnumerateArray().Select(value => value.GetString()!)) {
    var root = Path.Combine(stateRoot, fault); var directory = Path.Combine(root, "collection"); Directory.CreateDirectory(directory);
    var target = Path.Combine(directory, "collection.xml"); var calls = new List<object>(); bool active = false;
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_ProgramDataPath" => root, "get_DataPath" => Path.Combine(root, "data"), "get_InternalMetadataPath" => Path.Combine(root, "metadata"),
        _ => Stub.Default(method.ReturnType)
    });
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => new ServerConfiguration { CacheSize = 64, SaveMetadataHidden = false }, "get_ApplicationPaths" => paths,
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name switch {
        "GetPathProtocol" => MediaProtocol.File, "GetMediaStreams" => new List<MediaStream>(), _ => Stub.Default(method.ReturnType)
    });
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []); BaseItem.FileSystem = fileSystem;
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? values![0] : Stub.Default(method.ReturnType));
    var factory = new SqlFactory(Path.Combine(root, "native.db"));
    using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance); BaseItem.ItemRepository = repository;
    var realPersistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var persistence = Stub.Make<IItemPersistenceService>((method, values) => {
        if (active && method.Name == "SaveImagesAsync") calls.Add(new { action = "images" });
        if (active && method.Name == "SaveItems") calls.Add(new { action = "save", cancellable = ((CancellationToken)values![1]!).CanBeCanceled });
        return Stub.Forward(realPersistence, method, values);
    });
    LibraryManager? manager = null; ProviderManager? provider = null;
    var library = Stub.Make<ILibraryManager>((method, values) => {
        if (method.Name == "GetLibraryOptions") return new LibraryOptions { MetadataSavers = ["Emby Xml", "Other"] };
        if (method.Name == "GetCollectionFolders") return new List<Folder>();
        if (active && method.Name == "GetPeople") {
            calls.Add(new { action = "people", length = new FileInfo(target).Length });
            if (fault == "people") throw new IOException("Controlled people lookup failure");
            return new List<PersonInfo>();
        }
        if (active && method.Name == "GetItemList") {
            calls.Add(new { action = "linked-items", length = new FileInfo(target).Length });
            if (fault == "links") throw new IOException("Controlled linked-item lookup failure");
            return new BaseItem[] { new Movie { Id = Guid.Parse("cd310000-0000-0000-0000-000000000002"), Path = "Z:\\NeutralMedia\\member.mkv" } };
        }
        return Stub.Forward(manager!, method, values);
    });
    BaseItem.LibraryManager = library;
    var monitor = Stub.Make<ILibraryMonitor>((method, values) => {
        if (active && method.Name == "ReportFileSystemChangeBeginning") calls.Add(new { action = "monitor-begin" });
        if (active && method.Name == "ReportFileSystemChangeComplete") calls.Add(new { action = "monitor-complete", reset = (bool)values![1]! });
        return Stub.Default(method.ReturnType);
    });
    var logger = new CaptureLogger<ProviderManager>(calls);
    using var memory = new MemoryCache(new MemoryCacheOptions());
    provider = new ProviderManager(null!, null!, config, monitor, logger, fileSystem, paths, library, null!, null!, memory, null!, null!);
    provider.AddParts([], [], [], [new BoxSetXmlSaver(fileSystem, config, library, NullLogger<BoxSetXmlSaver>.Instance), new OtherSaver(calls)], [], []);
    manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => monitor), fileSystem,
        new(() => provider), new(() => null!), repository, persistence, null!, null!, new LinkedChildrenService(factory, new ItemTypeLookup(), repository),
        null!, new NamingOptions(), new DirectoryService(fileSystem), null!, null!, null!, BaseItem.LocalizationManager, null!, new(() => null!));
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, new UserRootFolder { Children = [] });
    var member = new Movie { Id = Guid.Parse("cd310000-0000-0000-0000-000000000002"), Name = "Member", Path = Path.Combine(root, "member.mkv") };
    manager.CreateItem(member, null);
    var item = new BoxSet { Id = Guid.Parse("cd310000-0000-0000-0000-000000000001"), Path = directory, Name = "Stored name",
        Overview = "Stored overview", OfficialRating = "PG", DateCreated = new DateTime(2026, 10, 13, 0, 0, 0, DateTimeKind.Utc) };
    manager.CreateItem(item, null);
    File.WriteAllText(target, "<Item><LocalTitle>Old complete document</LocalTitle></Item>", new UTF8Encoding(false));
    item.Name = "New common title"; item.Overview = fault == "xml" ? "Before \0 after" : fault == "xml-control" ? "Before \u0001 after" : "New overview";
    item.LinkedChildren = [new LinkedChild { ItemId = member.Id, Type = LinkedChildType.Manual }];
    manager.ItemUpdated += (_, change) => calls.Add(new { action = "event", reason = (int)change.UpdateReason });
    var service = new BoxSetMetadataService(config, NullLogger<BoxSetMetadataService>.Instance, provider, fileSystem, library, null!, repository);
    var save = typeof(MetadataService<BoxSet, BoxSetInfo>).GetMethod("SaveItemAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
    active = true; string? failure = null;
    try { await (Task)save.Invoke(service, [new MetadataResult<BoxSet> { Item = item }, ItemUpdateType.MetadataEdit, false, CancellationToken.None])!; }
    catch (Exception error) { failure = (error is TargetInvocationException wrapped ? wrapped.InnerException! : error).GetType().Name; }
    using var final = factory.CreateDbContext(); var stored = final.BaseItems.AsNoTracking().Single(row => row.Id == item.Id);
    var bytes = File.ReadAllBytes(target); bool valid = true; try { using var reader = System.Xml.XmlReader.Create(new MemoryStream(bytes)); while (reader.Read()) {} } catch { valid = false; }
    results.Add(new { fault, failure, calls, fileBytes = bytes.Length, fileSha256 = Hash(bytes), fileValid = valid,
        storedName = stored.Name, storedOverview = stored.Overview, storedLinkedChildren = final.LinkedChildren.Count(row => row.ParentId == item.Id),
        storedSavedAt = stored.DateLastSaved is not null, body = Encoding.UTF8.GetString(bytes) });
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location))
    .OrderBy(value => value.GetName().Name).Select(value => new { name = value.GetName().Name, location = value.Location, sha256 = Hash(File.ReadAllBytes(value.Location)) }).ToArray();
File.WriteAllText(args[2], JsonSerializer.Serialize(new { results, assemblies, actualMetadataServiceSaveItem = true, actualProviderManager = true,
    actualLibraryManager = true, actualItemPersistence = true, actualEfSqlite = true, peopleAndLinksControlled = true,
    metadataRefreshProvidersExecuted = false, databaseMigrationHistoryValidated = false, phaseAcceptance = false }, new JsonSerializerOptions { WriteIndented = true }) + "\n", new UTF8Encoding(false));
Console.WriteLine(JsonSerializer.Serialize(new { cases = results.Count }));
static string Hash(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();

public class OtherSaver(List<object> calls) : IMetadataSaver {
    public string Name => "Other";
    public bool IsEnabledFor(BaseItem item, ItemUpdateType updateType) => true;
    public Task SaveAsync(BaseItem item, CancellationToken token) { calls.Add(new { action = "other-saver", cancellable = token.CanBeCanceled }); return Task.CompletedTask; }
}
public class CaptureLogger<T>(List<object> calls) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
        if (level >= LogLevel.Error) calls.Add(new { action = "logger", message = formatter(state, error), error = error?.GetType().Name });
    }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values) {
        try { return method.Invoke(target, values); } catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; }
    }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
