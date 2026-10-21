using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv.Channels;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Channels;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Channels;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;

var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqliteFile = Path.Combine(AppContext.BaseDirectory, sqliteName); var sqliteHandle = NativeLibrary.Load(sqliteFile);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) => name == "e_sqlite3" ? sqliteHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
Guid Key(string name) => Guid.Parse(input.GetProperty(name).GetString()!);
var alternateKeys = input.GetProperty("alternateIds").EnumerateArray().Select(value => Guid.Parse(value.GetString()!)).ToArray();
var root = Path.GetFullPath(args[2]); Directory.CreateDirectory(root);
var status = typeof(ExceptionMiddleware).GetMethod("GetStatusCode", BindingFlags.Static | BindingFlags.NonPublic)!;
object Failure(Exception error) {
    while (error is TargetInvocationException { InnerException: not null } target) error = target.InnerException;
    return new { type = error.GetType().Name, error.Message, status = (int)status.Invoke(null, [error])!, error.StackTrace };
}
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var owned = Path.Combine(root, results.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)); Directory.CreateDirectory(owned);
    var calls = new List<object>(); var active = false; LibraryManager? manager = null;
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_ProgramDataPath" => owned, "get_RootFolderPath" => Path.Combine(owned, "root"), "get_DataPath" => Path.Combine(owned, "data"),
        "get_InternalMetadataPath" => Path.Combine(owned, "metadata"), "get_TrickplayPath" => Path.Combine(owned, "data", "trickplay"), _ => Stub.Default(method.ReturnType) });
    var settings = new ServerConfiguration { CacheSize = 64, EnableCaseSensitiveItemIds = true };
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => settings, "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths, "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType) });
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ExpandVirtualPath" or "ReverseVirtualPath" ? values![0] : Stub.Default(method.ReturnType));
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []); var directoryService = new DirectoryService(fileSystem);
    var localization = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance); await localization.LoadAll();
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance; BaseItem.FileSystem = fileSystem; BaseItem.LocalizationManager = localization;
    BaseItem.MediaSegmentManager = Stub.Make<IMediaSegmentManager>((method, _) => method.Name == "IsTypeSupported" ? false : throw new InvalidOperationException("Media segments cannot execute."));
    Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => method.Name == "GetActiveRecordingInfo" ? null : throw new InvalidOperationException("Recording cannot execute."));
    var sourceCapabilities = (MediaSourceManager)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(MediaSourceManager));
    typeof(MediaSourceManager).GetField("_fileSystem", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(sourceCapabilities, fileSystem);
    BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, values) => method.Name switch {
        "GetPathProtocol" => sourceCapabilities.GetPathProtocol((string)values![0]!),
        "SupportsDirectStream" => sourceCapabilities.SupportsDirectStream((string)values![0]!, (MediaProtocol)values[1]!),
        "GetMediaStreams" => Array.Empty<MediaStream>(), "GetMediaAttachments" => Array.Empty<MediaAttachment>(),
        _ => throw new InvalidOperationException("Media execution is outside this component: " + method.Name) });
    var factory = new SqlFactory(Path.Combine(owned, "native.db")); using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance); BaseItem.ItemRepository = repository;
    var realPersistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var tracked = new List<Video>();
    object State() {
        using var db = factory.CreateDbContext();
        return tracked.Select(item => new { id = item.Id.ToString("N"), source = File.Exists(item.Path),
            internalMetadata = File.Exists(Path.Combine(item.GetInternalMetadataPath(), "marker")), externalMetadata = File.Exists(Path.Combine(owned, "external", item.Id.ToString("N"), "marker")),
            row = db.BaseItems.Any(value => value.Id == item.Id), cached = manager!.GetItemById(item.Id) is not null,
            parentId = item.ParentId.ToString("N"), ownerId = item.OwnerId.ToString("N"), primaryVersionId = item.PrimaryVersionId?.ToString("N"),
            localCount = item.LocalAlternateVersions.Length, linkedCount = item.LinkedAlternateVersions.Length }).ToArray();
    }
    var persistence = Stub.Make<IItemPersistenceService>((method, values) => {
        if (active && method.Name == "DeleteItem") calls.Add(new { kind = "persist", ids = ((IReadOnlyList<Guid>)values![0]!).Select(value => value.ToString("N")).ToArray(), state = State() });
        return Stub.Forward(realPersistence, method, values);
    });
    var externalData = Stub.Make<IExternalDataManager>((method, values) => {
        if (method.Name == "DeleteExternalItemFiles") {
            var item = (BaseItem)values![0]!;
            if (active) calls.Add(new { kind = "external", id = item.Id.ToString("N"), state = State() });
            var marker = Path.Combine(owned, "external", item.Id.ToString("N"), "marker"); if (File.Exists(marker)) File.Delete(marker);
        }
        return Stub.Default(method.ReturnType);
    });
    var providers = Stub.Make<IProviderManager>((method, _) => Stub.Default(method.ReturnType));
    var library = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions(), _ => Stub.Forward(manager!, method, values) }); BaseItem.LibraryManager = library;
    var linked = new LinkedChildrenService(factory, new ItemTypeLookup(), repository);
    manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => null!), fileSystem,
        new(() => providers), new(() => null!), repository, persistence, null!, null!, linked,
        Stub.Make<IImageProcessor>((method, _) => Stub.Default(method.ReturnType)), new Emby.Naming.Common.NamingOptions(), directoryService,
        null!, new PathManager(NullLogger<PathManager>.Instance, config, paths), new DotIgnoreIgnoreRule(), localization, null!, new(() => externalData));
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, new UserRootFolder { Id = Key("userId"), Children = [] });
    var channel = new Channel { Id = manager.GetNewItemId("Channel Supported", typeof(Channel)), Name = "Supported" }; manager.CreateItem(channel, null);
    var parent = new Folder { Id = Key("parentId"), Name = "Parent", Path = Path.Combine(owned, "media") }; Directory.CreateDirectory(parent.Path); manager.CreateItem(parent, null);
    var primary = new Video { Id = Key("primaryId"), Name = "Ordinary primary", Path = Path.Combine(parent.Path, "primary.mkv"), ParentId = parent.Id,
        IsInMixedFolder = true, VideoType = VideoType.VideoFile }; File.WriteAllBytes(primary.Path, [1, 3, 5, 7]); manager.CreateItem(primary, parent); tracked.Add(primary);
    var local = sample.GetProperty("kind").GetString() == "local"; var count = sample.GetProperty("count").GetInt32();
    for (var index = 0; index < count; index++) {
        var alternate = new Video { Id = alternateKeys[index], Name = "Alternate " + index, Path = Path.Combine(parent.Path, "alternate" + index + ".mkv"), ParentId = parent.Id,
            IsInMixedFolder = true, VideoType = VideoType.VideoFile, ChannelId = channel.Id, ExternalId = "owned-external-" + index, OwnerId = local ? primary.Id : Guid.Empty };
        alternate.SetPrimaryVersionId(primary.Id); manager.CreateItem(alternate, parent); tracked.Add(alternate);
        manager.UpsertLinkedChild(primary.Id, alternate.Id, local ? MediaBrowser.Controller.Entities.LinkedChildType.LocalAlternateVersion : MediaBrowser.Controller.Entities.LinkedChildType.LinkedAlternateVersion);
        if (sample.TryGetProperty("survivor", out var survivor) && survivor.GetBoolean()) File.WriteAllBytes(alternate.Path, [2, 4, 6, 8]);
    }
    primary.LocalAlternateVersions = local ? tracked.Skip(1).Select(item => item.Path).ToArray() : [];
    primary.LinkedAlternateVersions = local ? [] : tracked.Skip(1).Select(item => new LinkedChild { ItemId = item.Id }).ToArray();
    // The real repository links are committed independently of these live arrays.
    if (sample.TryGetProperty("clearWarmVersions", out var clear) && clear.GetBoolean()) { primary.LocalAlternateVersions = []; primary.LinkedAlternateVersions = []; }
    parent.Children = tracked.Cast<BaseItem>().ToArray(); parent.UserData = [];
    foreach (var item in tracked) {
        var internalMarker = Path.Combine(item.GetInternalMetadataPath(), "marker"); Directory.CreateDirectory(Path.GetDirectoryName(internalMarker)!); File.WriteAllText(internalMarker, "internal");
        var externalMarker = Path.Combine(owned, "external", item.Id.ToString("N"), "marker"); Directory.CreateDirectory(Path.GetDirectoryName(externalMarker)!); File.WriteAllText(externalMarker, "external");
    }
    using var cache = new MemoryCache(new MemoryCacheOptions());
    var controlled = new DeletionProvider(sample, (id, token) => calls.Add(new { kind = "provider", externalId = id, canBeCanceled = token.CanBeCanceled, state = State() }));
    using var channels = new ChannelManager(null!, null!, library, NullLogger<ChannelManager>.Instance, config, fileSystem, null!, providers, cache, [controlled]); BaseItem.ChannelManager = channels;
    manager.ItemRemoved += (_, change) => calls.Add(new { kind = "event", id = change.Item.Id.ToString("N"), parentId = change.Parent?.Id.ToString("N"), state = State() });
    using var beforeDb = factory.CreateDbContext(); var beforeRows = beforeDb.BaseItems.AsNoTracking().ToArray(); var beforeLinks = beforeDb.LinkedChildren.AsNoTracking().ToArray(); var before = State();
    var warmIdentity = tracked.All(item => ReferenceEquals(item, manager.GetItemById(item.Id)));
    active = true; object action; var options = new DeleteOptions { DeleteFileLocation = false, DeleteFromExternalProvider = sample.GetProperty("outerProvider").GetBoolean() };
    try { manager.DeleteItem(primary, options, parent, true); action = new { value = new { options.DeleteFileLocation, options.DeleteFromExternalProvider } }; }
    catch (Exception error) { action = new { failure = Failure(error) }; }
    using var final = factory.CreateDbContext();
    results.Add(new { name = sample.GetProperty("name").GetString(), root = owned, providerId = channel.Id.ToString("N"), beforeRows, beforeLinks, before, warmIdentity, action, calls,
        after = State(), rows = final.BaseItems.AsNoTracking().OrderBy(item => item.Id).Select(item => new { item.Id, item.Name, item.ParentId, item.OwnerId, item.PrimaryVersionId }).ToArray(),
        links = final.LinkedChildren.AsNoTracking().OrderBy(item => item.ParentId).ThenBy(item => item.SortOrder).ToArray(),
        parentChildrenInvalidated = typeof(Folder).GetField("_children", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(parent) is null, parentUserDataInvalidated = parent.UserData is null });
}
var assemblies = new[] { typeof(ChannelManager).Assembly, typeof(LibraryManager).Assembly, typeof(BaseItem).Assembly, typeof(BaseItemRepository).Assembly, typeof(JellyfinDbContext).Assembly, typeof(ExceptionMiddleware).Assembly }.Distinct()
    .Select(value => new { filename = value.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(value.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), actualLibraryManager = true, actualChannelManager = true, actualEfPersistence = true,
    controlledExternalProvider = true, mediaExecutionStarted = false, assemblies, sqliteNative = new { filename = sqliteFile, runtimeIdentifier = RuntimeInformation.RuntimeIdentifier,
        explicitResolver = true, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(sqliteFile))) }, results },
    new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never }));

public class DeletionProvider(JsonElement sample, Action<string, CancellationToken> observe) : IChannel, ISupportsDelete {
    public string Name => "Supported"; public string Description => "Owned external versions"; public string DataVersion => "component"; public string HomePageUrl => null!;
    public ChannelParentalRating ParentalRating => ChannelParentalRating.GeneralAudience;
    public InternalChannelFeatures GetChannelFeatures() => new(); public bool IsEnabledFor(string userId) => true; public bool CanDelete(BaseItem item) => throw new InvalidOperationException("This direct deletion does not evaluate permissions.");
    public Task<ChannelItemResult> GetChannelItems(InternalChannelItemQuery query, CancellationToken token) => throw new InvalidOperationException("Catalog execution is forbidden.");
    public Task<DynamicImageResponse> GetChannelImage(ImageType type, CancellationToken token) => throw new InvalidOperationException("Image execution is forbidden.");
    public IEnumerable<ImageType> GetSupportedChannelImages() => [];
    public Task DeleteItem(string id, CancellationToken token) {
        if (id is not ("owned-external-0" or "owned-external-1")) throw new InvalidOperationException("Provider deletion escaped the fixture input.");
        observe(id, token); var index = int.Parse(id[^1..], System.Globalization.CultureInfo.InvariantCulture);
        if (!sample.TryGetProperty("failAt", out var at) || at.GetInt32() != index) return Task.CompletedTask;
        return sample.GetProperty("outcome").GetString() switch {
            "argument" => Task.FromException(new ArgumentException("Controlled recursive provider argument.")),
            "io" => Task.FromException(new IOException("Controlled recursive provider I/O failure.")),
            _ => Task.FromException(new InvalidOperationException("Controlled recursive provider failure.")) };
    }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values) { try { return method.Invoke(target, values); } catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; } }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
