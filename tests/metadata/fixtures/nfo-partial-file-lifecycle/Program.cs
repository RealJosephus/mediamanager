// Actual LibraryManager people lifecycle with EF SQLite and real instance directories.
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Net;
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
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Drawing;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Providers.Manager;
using MediaBrowser.Providers.Movies;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Caching.Memory;
using MediaBrowser.XbmcMetadata.Savers;
using MediaBrowser.XbmcMetadata.Configuration;
using Person = MediaBrowser.Controller.Entities.Person;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
BaseItem.MediaSourceManager = DispatchProxy.Create<IMediaSourceManager, SourcesProxy>();
var json = new JsonSerializerOptions { WriteIndented = true }; json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement; var results = new List<object>();
foreach (var sample in input.EnumerateArray()) {
    var name = sample.GetProperty("name").GetString()!;
    var root = Path.GetFullPath(Path.Combine(args[2], name)); Directory.CreateDirectory(root); Projection.Root = root;
    var calls = new List<object>();
    var picture = File.ReadAllBytes(args[3]);
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
    ((SourcesProxy)(object)BaseItem.MediaSourceManager).Streams = new MediaStreamRepository(factory, appHost, localization);
    BaseItem.ItemRepository = repository;
    var nativePersistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var persistence = DispatchProxy.Create<IItemPersistenceService, PersistenceProxy>(); var saves = (PersistenceProxy)(object)persistence;
    saves.Real = nativePersistence; saves.Calls = calls; saves.Factory = factory;
    var nativePeople = new PeopleRepository(factory, new ItemTypeLookup(), null!);
    var peopleRepo = DispatchProxy.Create<IPeopleRepository, PeopleProxy>(); var creditsControl = (PeopleProxy)(object)peopleRepo;
    creditsControl.Real = nativePeople; creditsControl.Calls = calls;
    var libraryProxy = DispatchProxy.Create<ILibraryManager, LibraryProxy>(); var bridge = (LibraryProxy)(object)libraryProxy;
    var imageProcessor = DispatchProxy.Create<IImageProcessor, ImageProcessorProxy>(); ((ImageProcessorProxy)(object)imageProcessor).Sample = sample;
    IProviderManager? providers = null;
    var manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => null!), fs,
        new(() => providers!), new(() => null!), repository, persistence, null!, null!, new LinkedChildrenService(factory, new ItemTypeLookup(), repository), imageProcessor, new NamingOptions(),
        new DirectoryService(fs), peopleRepo, null!, null!, localization, null!, new(() => null!));
    bridge.Real = manager; BaseItem.LibraryManager = libraryProxy;
    using var clients = new ControlledClients(picture);
    using var memory = new MemoryCache(new MemoryCacheOptions());
    var monitor = DispatchProxy.Create<ILibraryMonitor, MonitorProxy>();
    using var nativeProviders = new ProviderManager(clients, null!, config, monitor, new CaptureLogger<ProviderManager>(calls), fs,
        paths, libraryProxy, null!, null!, memory, null!, null!);
    nativeProviders.AddParts([], [], [], [new MovieNfoSaver(fs, config, libraryProxy, null!, null!, new CaptureLogger<MovieNfoSaver>(calls))], [], []);
    providers = DispatchProxy.Create<IProviderManager, ProviderProxy>(); var providerControl = (ProviderProxy)(object)providers;
    providerControl.Real = nativeProviders; providerControl.Calls = calls; providerControl.Picture = picture;
    var parent = sample.TryGetProperty("unsupported", out var unsupported) && unsupported.GetBoolean()
        ? (BaseItem)new Person() : new Movie();
    parent.Id = Guid.Parse("96000000-0000-0000-0000-000000000001"); parent.Name = "Original Parent";
    var media = Path.Combine(root, "media"); Directory.CreateDirectory(media); parent.Path = Path.Combine(media, "movie.mkv");
    parent.DateCreated = DateTime.Parse("2025-01-02T03:04:05Z").ToUniversalTime(); parent.DateModified = parent.DateCreated;
    if (sample.TryGetProperty("nfoBlock", out var nfoBlock) && nfoBlock.GetBoolean()) Directory.CreateDirectory(Path.Combine(media, "movie.nfo"));
    if (sample.TryGetProperty("nfoText", out var nfoText)) File.WriteAllText(Path.Combine(media, "movie.nfo"), nfoText.GetString());
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
        if (definition.TryGetProperty("primary", out var primary)) {
            var primaryPath = primary.GetString()!;
            if (primaryPath == "local") { primaryPath = Path.Combine(path, "folder.png"); File.WriteAllBytes(primaryPath, picture); }
            item.SetImage(new ItemImageInfo { Path = primaryPath, Type = ImageType.Primary, Width = 1, Height = 1, BlurHash = "controlled" }, 0);
        }
        manager.CreateItem(item, null);
    }
    var people = JsonSerializer.Deserialize<PersonInfo?[]>(sample.GetProperty("people").GetRawText(), json)!;
    using var cancellation = new CancellationTokenSource();
    if (sample.TryGetProperty("cancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
    saves.Active = true; creditsControl.Active = true;
    if (sample.TryGetProperty("failure", out var failure)) { saves.Failure = failure.GetString(); creditsControl.Failure = failure.GetString(); }
    if (sample.TryGetProperty("failureAt", out var at)) saves.FailureAt = at.GetInt32();
    if (sample.TryGetProperty("imageFailureAt", out var imageAt)) saves.ImageFailureAt = imageAt.GetInt32();
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
    var imageRows = final.BaseItemImageInfos.AsEnumerable().OrderBy(image => image.ItemId.ToString("D"), StringComparer.Ordinal)
        .Select(image => new { image.ItemId, Path = Projection.PathValue(image.Path), Type = image.ImageType, image.Width, image.Height,
            Blurhash = image.Blurhash is null ? null : System.Text.Encoding.UTF8.GetString(image.Blurhash),
            DateModified = image.DateModified is DateTime imageDate ? imageDate.Year > 2025 ? "$RECENT" : imageDate.ToString("O") : null }).ToArray();
    var files = Directory.GetFiles(root, "*", SearchOption.AllDirectories).Where(filename => !filename.EndsWith(".db", StringComparison.Ordinal))
        .Order(StringComparer.Ordinal).Select(filename => new { Path = Projection.PathValue(filename), bytes = new FileInfo(filename).Length,
            sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(filename))).ToLowerInvariant(),
            text = filename.EndsWith(".nfo", StringComparison.Ordinal) ? File.ReadAllText(filename) : null }).ToArray();
    var directories = Directory.Exists(Path.Combine(root, "metadata")) ? Directory.GetDirectories(Path.Combine(root, "metadata"), "*", SearchOption.AllDirectories).Select(Projection.PathValue).Order(StringComparer.Ordinal).ToArray() : [];
    results.Add(new { name, exception, calls, credits, items, providers = providersAfter, directories,
        parentName = final.BaseItems.Single(item => item.Id == parent.Id).Name,
        ancestors = final.AncestorIds.Count(), images = imageRows, files });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    imageSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[3]))).ToLowerInvariant(),
    boundary = "Actual LibraryManager people/image lifecycle, ProviderManager/HttpClient/ImageSaver file writes, MovieNfoSaver, ConvertImageToLocal/UpdateImages/UpdateItems/CreateItems and real EF SQLite writes. Real directories/files; controlled HTTP handler responses and dimensions/BlurHash, not actual sockets/image decoder/full HTTP refresh." }, json) + "\n");

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
public sealed class CaptureLogger<T>(List<object> calls) : ILogger<T> {
    public bool IsEnabled(LogLevel level) => level >= LogLevel.Warning;
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? error, Func<TState, Exception?, string> format) {
        if (IsEnabled(level)) calls.Add(new { action = "log", level = level.ToString(), exception = error?.GetType().Name, message = Projection.PathValue(format(state, error)) });
    }
}
public class PathsProxy : DispatchProxy {
    public string Root = "";
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_ProgramDataPath" => Root, "get_PeoplePath" => Path.Combine(Root, "metadata", "People"),
        "get_InternalMetadataPath" => Path.Combine(Root, "metadata"), "get_TempDirectory" => Path.Combine(Root, "temp"), "get_CachePath" => Path.Combine(Root, "cache"),
        _ => throw new NotSupportedException(method.Name)
    };
}
public class ConfigurationProxy : DispatchProxy {
    public IServerApplicationPaths Paths = null!; public ServerConfiguration Data = new() { MetadataCountryCode = "US", CacheSize = 64 };
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_Configuration" => Data, "get_ApplicationPaths" => Paths, "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null,
        "GetConfiguration" => new XbmcMetadataOptions(),
        _ => throw new NotSupportedException(method.Name)
    };
}
public class ApplicationHostProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? args![0] : throw new NotSupportedException(method.Name);
}
public class LibraryProxy : DispatchProxy {
    public LibraryManager Real = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => args![0] is Movie ? new LibraryOptions { MetadataSavers = ["Nfo"], SaveLocalMetadata = true } : new LibraryOptions(),
        _ => DelegateCall.Invoke(Real, method, args)
    };
}
public class PersistenceProxy : DispatchProxy {
    public ItemPersistenceService Real = null!; public List<object> Calls = []; public bool Active; public string? Failure; public int FailureAt = 1; private int _personSave;
    public SqlFactory Factory = null!; public int ImageFailureAt; private int _imageSave;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (Active && method!.Name == "SaveImagesAsync") {
            Calls.Add(new { action = "images", item = Projection.Item((BaseItem)args![0]!) });
            if (++_imageSave == ImageFailureAt) {
                // A real SQLite insert error after SaveImagesAsync's independently
                // committed ExecuteDelete, rather than an entry-point exception.
                using var fault = Factory.CreateDbContext();
                fault.Database.ExecuteSqlRaw("CREATE TRIGGER fail_image_insert BEFORE INSERT ON BaseItemImageInfos BEGIN SELECT RAISE(ABORT, 'Injected image insert failure'); END");
            }
        }
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
    public MediaStreamRepository Streams = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetPathProtocol" => MediaProtocol.File,
        "GetMediaStreams" => Streams.GetMediaStreams(args![0] is MediaStreamQuery query ? query : new MediaStreamQuery { ItemId = (Guid)args[0]! }),
        _ => throw new NotSupportedException(method.Name)
    };
}
public class ImageProcessorProxy : DispatchProxy {
    public JsonElement Sample;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "GetImageDimensions") {
            if (Sample.TryGetProperty("dimensionFailure", out var failure) && failure.GetBoolean()) throw new IOException("Injected image dimension failure");
            if (Sample.TryGetProperty("dimensions", out var dimensions)) return new ImageDimensions(dimensions.GetProperty("Width").GetInt32(), dimensions.GetProperty("Height").GetInt32());
            return new ImageDimensions(1, 1);
        }
        if (method.Name == "GetImageBlurHash") {
            if (Sample.TryGetProperty("blurFailure", out var failure) && failure.GetBoolean()) throw new IOException("Injected image BlurHash failure");
            return "controlled";
        }
        throw new NotSupportedException(method.Name);
    }
}
public class ProviderProxy : DispatchProxy {
    public ProviderManager Real = null!; public List<object> Calls = []; public byte[] Picture = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name != "SaveImage") return DelegateCall.Invoke(Real, method, args);
        var item = (BaseItem)args![0]!; var url = (string)args[1]!;
        Calls.Add(new { action = "fetch", url, cancellable = ((CancellationToken)args[4]!).CanBeCanceled });
        return DelegateCall.Invoke(Real, method, args);
    }
}
public class MonitorProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name is "ReportFileSystemChangeBeginning" or "ReportFileSystemChangeComplete" ? null : throw new NotSupportedException(method.Name);
}
public class ControlledClients(byte[] picture) : IHttpClientFactory, IDisposable {
    private readonly HttpClient _client = new(new ControlledResponses(picture));
    public HttpClient CreateClient(string name) => _client;
    public void Dispose() => _client.Dispose();
}
public class ControlledResponses(byte[] picture) : HttpMessageHandler {
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
        var url = request.RequestUri!.OriginalString;
        if (url.EndsWith("io", StringComparison.Ordinal)) throw new IOException("Injected image download failure");
        var status = url.EndsWith("404", StringComparison.Ordinal) ? HttpStatusCode.NotFound : url.EndsWith("500", StringComparison.Ordinal) ? HttpStatusCode.InternalServerError : HttpStatusCode.OK;
        var response = new HttpResponseMessage(status) { Content = new ByteArrayContent(picture) };
        response.Content.Headers.ContentType = new("image/png");
        return Task.FromResult(response);
    }
}
