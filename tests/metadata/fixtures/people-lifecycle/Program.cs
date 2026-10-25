// Actual LibraryManager people lifecycle with EF SQLite and real instance directories.
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Naming.Common;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
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
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Providers.Manager;
using MediaBrowser.Providers.Movies;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Person = MediaBrowser.Controller.Entities.Person;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
BaseItem.MediaSourceManager = DispatchProxy.Create<IMediaSourceManager, SourcesProxy>();
var json = new JsonSerializerOptions { WriteIndented = true }; json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement; var results = new List<object>();
foreach (var sample in input.EnumerateArray()) {
    var name = sample.GetProperty("name").GetString()!;
    var root = Path.Combine(args[2], name); Directory.CreateDirectory(root); Projection.Root = root;
    var calls = new List<object>();
    var paths = DispatchProxy.Create<IServerApplicationPaths, PathsProxy>(); ((PathsProxy)(object)paths).Root = root;
    var config = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>(); var configuration = (ConfigurationProxy)(object)config;
    configuration.Paths = paths;
    if (sample.TryGetProperty("caseSensitive", out var cs)) configuration.Data.EnableCaseSensitiveItemIds = cs.GetBoolean();
    if (sample.TryGetProperty("normalized", out var normalized)) configuration.Data.EnableNormalizedItemByNameIds = normalized.GetBoolean();
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    var localization = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance); await localization.LoadAll(); BaseItem.LocalizationManager = localization;
    var fs = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []); BaseItem.FileSystem = fs;
    var appHost = DispatchProxy.Create<IServerApplicationHost, ApplicationHostProxy>();
    var factory = new SqlFactory(Path.Combine(root, "native.db")); using (var context = factory.CreateDbContext()) context.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var nativePersistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var persistence = DispatchProxy.Create<IItemPersistenceService, PersistenceProxy>(); var saves = (PersistenceProxy)(object)persistence;
    saves.Real = nativePersistence; saves.Calls = calls;
    var nativePeople = new PeopleRepository(factory, new ItemTypeLookup(), null!);
    var peopleRepo = DispatchProxy.Create<IPeopleRepository, PeopleProxy>(); var creditsControl = (PeopleProxy)(object)peopleRepo;
    creditsControl.Real = nativePeople; creditsControl.Calls = calls;
    var libraryProxy = DispatchProxy.Create<ILibraryManager, LibraryProxy>(); var bridge = (LibraryProxy)(object)libraryProxy;
    IProviderManager? providers = null;
    var manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => null!), fs,
        new(() => providers!), new(() => null!), repository, persistence, null!, null!, new LinkedChildrenService(factory, new ItemTypeLookup(), repository), null!, new NamingOptions(),
        new DirectoryService(fs), peopleRepo, null!, null!, localization, null!, new(() => null!));
    bridge.Real = manager; BaseItem.LibraryManager = libraryProxy;
    using var nativeProviders = new ProviderManager(null!, null!, config, null!, NullLogger<ProviderManager>.Instance, fs,
        null!, libraryProxy, null!, null!, null!, null!, null!); nativeProviders.AddParts([], [], [], [], [], []); providers = nativeProviders;
    var parent = sample.TryGetProperty("unsupported", out var unsupported) && unsupported.GetBoolean()
        ? (BaseItem)new Person() : new Movie();
    parent.Id = Guid.Parse("96000000-0000-0000-0000-000000000001"); parent.Name = "Original Parent";
    manager.CreateItem(parent, null);
    nativePeople.UpdatePeople(parent.Id, [new PersonInfo { Name = "Old Credit", Type = Jellyfin.Data.Enums.PersonKind.Actor, Role = "Old Role" }]);
    if (sample.TryGetProperty("existing", out var existing)) foreach (var definition in existing.EnumerateArray()) {
        var personName = definition.GetProperty("Name").GetString()!; var path = Person.GetPath(personName);
        Directory.CreateDirectory(path);
        var id = manager.GetNewItemId(path, typeof(Person));
        if (configuration.Data.EnableNormalizedItemByNameIds && configuration.Data.EnableCaseSensitiveItemIds) {
            // GetPerson supplies the canonical item-by-name id even when ordinary IDs are case sensitive.
            id = (Guid)typeof(LibraryManager).GetMethod("GetItemByNameId", BindingFlags.NonPublic | BindingFlags.Instance)!.MakeGenericMethod(typeof(Person)).Invoke(manager, [path])!;
        }
        var item = new Person { Id = id, Path = path, Name = personName, DateCreated = DateTime.Parse("2025-01-02T03:04:05Z").ToUniversalTime(),
            DateModified = DateTime.Parse("2025-01-02T03:04:05Z").ToUniversalTime(), DateLastSaved = DateTime.Parse("2025-01-02T03:04:05Z").ToUniversalTime(),
            Overview = "Original Person", PresentationUniqueKey = "Person-" + personName };
        if (definition.TryGetProperty("ProviderIds", out var ids)) item.ProviderIds = JsonSerializer.Deserialize<Dictionary<string,string>>(ids.GetRawText())!;
        manager.CreateItem(item, null);
    }
    var people = JsonSerializer.Deserialize<PersonInfo?[]>(sample.GetProperty("people").GetRawText(), json)!;
    using var cancellation = new CancellationTokenSource();
    if (sample.TryGetProperty("cancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
    saves.Active = true; creditsControl.Active = true;
    if (sample.TryGetProperty("failure", out var failure)) { saves.Failure = failure.GetString(); creditsControl.Failure = failure.GetString(); }
    if (sample.TryGetProperty("failureAt", out var at)) saves.FailureAt = at.GetInt32();
    if (sample.TryGetProperty("directoryFailure", out var directoryFailure)) {
        var failedPath = Person.GetPath(directoryFailure.GetString()!); Directory.CreateDirectory(Path.GetDirectoryName(failedPath)!); File.WriteAllText(failedPath, "blocked directory");
    }
    manager.ItemAdded += (_, eventArgs) => {
        calls.Add(new { action = "added", item = Projection.Item(eventArgs.Item), parent = eventArgs.Parent?.Id });
        if (sample.TryGetProperty("cancelOnAdded", out var co) && co.GetBoolean()) cancellation.Cancel();
        if (sample.TryGetProperty("eventThrows", out var et) && et.GetBoolean()) throw new IOException("Injected event failure");
    };
    manager.ItemUpdated += (_, eventArgs) => calls.Add(new { action = "updated", item = Projection.Item(eventArgs.Item), reason = (int)eventArgs.UpdateReason });
    string? exception = null;
    try {
        if (sample.TryGetProperty("mode", out var mode) && mode.GetString() == "save-item") {
            parent.Name = "Saved Parent";
            var service = new MovieMetadataService(config, NullLogger<MovieMetadataService>.Instance, providers, fs, libraryProxy, null!, repository);
            var metadata = new MetadataResult<Movie> { Item = (Movie)parent, People = people!.ToList()! };
            await (Task)service.GetType().GetMethod("SaveItemAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(service, [metadata, ItemUpdateType.MetadataDownload, false, cancellation.Token])!;
        } else await manager.UpdatePeopleAsync(parent, people!, cancellation.Token);
    } catch (Exception error) {
        exception = (error is TargetInvocationException wrapped ? wrapped.InnerException : error)!.GetType().Name;
        if (!sample.TryGetProperty("expectException", out var expected) || exception != expected.GetString()) throw;
    }
    if (exception is null && sample.TryGetProperty("expectException", out _)) throw new InvalidOperationException("Expected failure not raised: " + name);
    using var final = factory.CreateDbContext();
    var credits = final.PeopleBaseItemMap.Include(map => map.People).Where(map => map.ItemId == parent.Id).OrderBy(map => map.ListOrder).AsEnumerable()
        .Select(map => new { map.People.Name, Type = map.People.PersonType, map.Role, map.ListOrder, map.SortOrder }).ToArray();
    var items = final.BaseItems.Where(item => item.Id != parent.Id && item.Type != "PLACEHOLDER").AsEnumerable().OrderBy(item => item.Id.ToString("D"), StringComparer.Ordinal)
        .Select(item => Projection.Entity(item)).ToArray();
    var idsAfter = final.BaseItems.Where(item => item.Id != parent.Id).Select(item => item.Id).ToArray();
    var providersAfter = final.BaseItemProviders.Where(provider => idsAfter.Contains(provider.ItemId)).AsEnumerable()
        .OrderBy(provider => provider.ItemId.ToString("D"), StringComparer.Ordinal).ThenBy(provider => provider.ProviderId, StringComparer.Ordinal)
        .Select(provider => new { provider.ItemId, provider.ProviderId, provider.ProviderValue }).ToArray();
    var directories = Directory.Exists(Path.Combine(root, "metadata")) ? Directory.GetDirectories(Path.Combine(root, "metadata"), "*", SearchOption.AllDirectories).Select(Projection.PathValue).Order(StringComparer.Ordinal).ToArray() : [];
    results.Add(new { name, exception, calls, credits, items, providers = providersAfter, directories,
        parentName = final.BaseItems.Single(item => item.Id == parent.Id).Name,
        ancestors = final.AncestorIds.Count(), images = final.BaseItemImageInfos.Count() });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual LibraryManager UpdatePeopleAsync/GetOrCreatePerson/CreateItems/RunMetadataSavers and MetadataService.SaveItemAsync with real EF SQLite PeopleRepository/ItemPersistenceService/BaseItemRepository hydration and real directories. Empty saver/image collections; library options, collection folders and path expansion are controls. Persistence/credit failures and cancellation/event faults are injected before actual boundaries. Remote image/NFO content and full HTTP refresh excluded." }, json) + "\n");

public static class Projection {
    public static string Root = "";
    public static string? PathValue(string? path) => path is null ? null : path.Replace(Root, "$STATE", StringComparison.Ordinal);
    public static object Item(BaseItem item) => new { item.Id, item.Name, Type = item.GetType().Name, Path = PathValue(item.Path),
        saved = item.DateLastSaved != DateTime.MinValue, ProviderIds = item.ProviderIds.ToDictionary(), imageCount = item.ImageInfos.Length };
    public static Dictionary<string,object?> Entity(BaseItemEntity item) {
        var result = new Dictionary<string,object?>();
        foreach (var field in typeof(BaseItemEntity).GetProperties()) {
            if (field.PropertyType != typeof(string) && field.PropertyType != typeof(Guid) && field.PropertyType != typeof(Guid?)
                && !field.PropertyType.IsValueType) continue;
            var value = field.GetValue(item);
            if (field.Name is "DateCreated" or "DateModified" or "DateLastSaved") value = value is DateTime date ? date.Year == 2025 ? date.ToString("O") : "$RECENT" : null;
            else if (value is DateTime date) value = date.ToString("O");
            else if (value is Guid guid) value = guid.ToString("D");
            if (value is string text && field.Name == "Path") value = PathValue(text);
            result[field.Name] = value;
        }
        return result;
    }
}
public static class DelegateCall {
    public static object? Invoke(object target, MethodInfo method, object?[]? args) {
        try { return method.Invoke(target, args); } catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; }
    }
}
public class PathsProxy : DispatchProxy {
    public string Root = "";
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_ProgramDataPath" => Root, "get_PeoplePath" => Path.Combine(Root, "metadata", "People"),
        "get_InternalMetadataPath" => Path.Combine(Root, "metadata"), "get_TempDirectory" => Path.Combine(Root, "temp"),
        _ => throw new NotSupportedException(method.Name)
    };
}
public class ConfigurationProxy : DispatchProxy {
    public IServerApplicationPaths Paths = null!; public ServerConfiguration Data = new() { MetadataCountryCode = "US", CacheSize = 64 };
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_Configuration" => Data, "get_ApplicationPaths" => Paths, "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
public class ApplicationHostProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? args![0] : throw new NotSupportedException(method.Name);
}
public class LibraryProxy : DispatchProxy {
    public LibraryManager Real = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions(),
        _ => DelegateCall.Invoke(Real, method, args)
    };
}
public class PersistenceProxy : DispatchProxy {
    public ItemPersistenceService Real = null!; public List<object> Calls = []; public bool Active; public string? Failure; public int FailureAt = 1; private int _personSave;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (Active && method!.Name == "SaveItems") {
            var items = (IReadOnlyList<BaseItem>)args![0]!;
            foreach (var item in items) {
                Calls.Add(new { action = "save", item = Projection.Item(item), cancellable = ((CancellationToken)args[1]!).CanBeCanceled });
                if (item is Person && Failure == "person" && ++_personSave == FailureAt) throw new IOException("Injected person save failure");
                if (item is Movie && Failure == "parent") throw new IOException("Injected parent save failure");
            }
        }
        return DelegateCall.Invoke(Real, method!, args);
    }
}
public class PeopleProxy : DispatchProxy {
    public PeopleRepository Real = null!; public List<object> Calls = []; public bool Active; public string? Failure;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (Active && method!.Name == "UpdatePeople") {
            Calls.Add(new { action = "credits", people = ((IReadOnlyList<PersonInfo>)args![1]!).Select(person => new { person.Name, person.Type, person.Role, person.SortOrder, person.ProviderIds }).ToArray() });
            if (Failure == "credits") throw new IOException("Injected credits failure");
        }
        return DelegateCall.Invoke(Real, method!, args);
    }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}
public class SourcesProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetPathProtocol" ? MediaProtocol.File : throw new NotSupportedException(method.Name);
}
