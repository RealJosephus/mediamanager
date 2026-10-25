// Actual frozen FindExtras and RefreshExtras over files and EF SQLite; provider saves are controlled.
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Emby.Naming.Common;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Library.Resolvers;
using Emby.Server.Implementations.Localization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Resolvers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Providers;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
BaseItem.MediaSegmentManager = Stub.Make<IMediaSegmentManager>((method, _) => Stub.Default(method.ReturnType));
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name switch {
    "GetPathProtocol" => MediaProtocol.File, "GetMediaStreams" => Array.Empty<MediaStream>(),
    "GetStaticMediaSources" => Array.Empty<MediaSourceInfo>(), "GetMediaAttachments" => Array.Empty<MediaAttachment>(),
    _ => Stub.Default(method.ReturnType)
});
var inputText = File.ReadAllText(args[0]); var input = JsonDocument.Parse(inputText).RootElement;
var json = new JsonSerializerOptions { WriteIndented = true }; json.Converters.Add(new JsonStringEnumConverter());
var results = new List<object>();
foreach (var sample in input.EnumerateArray()) {
    var sampleStartedAt = DateTime.UtcNow;
    var root = Path.GetFullPath(Path.Combine(args[2], sample.GetProperty("name").GetString()!)); Directory.CreateDirectory(root);
    var calls = new List<object>(); var active = false;
    var expectedType = ItemType(sample.GetProperty("expectedType").GetString()!);
    var resolverType = ItemType(sample.GetProperty("resolverType").GetString()!);
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_RootFolderPath" => Path.Combine(root, "root"), "get_ProgramDataPath" => root, "get_InternalMetadataPath" => Path.Combine(root, "metadata"),
        "get_DataPath" => Path.Combine(root, "data"), "get_TrickplayPath" => Path.Combine(root, "data", "trickplay"),
        _ => Stub.Default(method.ReturnType)
    });
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => new ServerConfiguration { CacheSize = 64 }, "get_ApplicationPaths" => paths,
        "GetConfiguration" => new MetadataConfiguration { UseFileCreationTimeForDateAdded = true },
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []); BaseItem.FileSystem = fileSystem;
    var directoryService = new DirectoryService(fileSystem);
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? values![0] : Stub.Default(method.ReturnType));
    var factory = new SqlFactory(Path.Combine(root, "native.db"));
    using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var realPersistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var persistence = Stub.Make<IItemPersistenceService>((method, values) => {
        if (active && method.Name == "SaveItems") calls.Add(new { action = "save", items = ((IReadOnlyList<BaseItem>)values![0]!).Select(item => ProjectItem(item)).ToArray(), cancellable = ((CancellationToken)values[1]!).CanBeCanceled });
        if (active && method.Name == "DeleteItem") calls.Add(new { action = "delete", ids = ((IReadOnlyList<Guid>)values![0]!).Select(Id).ToArray() });
        return Stub.Forward(realPersistence, method, values);
    });
    var provider = Stub.Make<IProviderManager>((method, values) => {
        if (active && method.Name == "SaveMetadataAsync") calls.Add(new { action = "saver", id = Id(((BaseItem)values![0]!).Id), reason = (int)(ItemUpdateType)values[1]! });

        if (method.Name == "RefreshSingleItem") {
            var child = (BaseItem)values![0]!; var options = (MetadataRefreshOptions)values[1]!;
            var token = (CancellationToken)values[2]!;
            calls.Add(new { action = "refresh", item = ProjectItem(child), forceSave = options.ForceSave,
                hasSearchResult = options.SearchResult is not null, cancellationRequested = token.IsCancellationRequested });
            token.ThrowIfCancellationRequested();
            return Task.FromResult(ItemUpdateType.None);
        }
        return Stub.Default(method.ReturnType);
    });
    BaseItem.ProviderManager = provider;
    var pathManager = new PathManager(NullLogger<PathManager>.Instance, config, paths);
    var externalData = Stub.Make<IExternalDataManager>((method, values) => {
        if (method.Name == "DeleteExternalItemFiles") {
            var item = (BaseItem)values![0]!; calls.Add(new { action = "external-files", id = Id(item.Id) });
            foreach (var directory in pathManager.GetExtractedDataPaths(item)) if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
        return Stub.Default(method.ReturnType);
    });
    LibraryManager? manager = null;
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions(),
        _ => Stub.Forward(manager!, method, values)
    });
    var naming = new NamingOptions();
    var dotIgnore = new DotIgnoreIgnoreRule();
    manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => null!), fileSystem,
        new(() => provider), new(() => null!), repository, persistence, null!, null!, new LinkedChildrenService(factory, new ItemTypeLookup(), repository),
        Stub.Make<IImageProcessor>((method, _) => Stub.Default(method.ReturnType)), naming, directoryService, null!, pathManager, dotIgnore, BaseItem.LocalizationManager,
        null!, new(() => externalData));
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, new UserRootFolder { Children = [] });
    var realResolver = (IItemResolver)Activator.CreateInstance(typeof(GenericVideoResolver<>).MakeGenericType(resolverType),
        NullLogger.Instance, naming, directoryService, Bool("parseName"))!;
    var resolver = Stub.Make<IItemResolver>((method, values) => {
        if (active && method.Name == "ResolvePath") calls.Add(new { action = "resolve", path = ProjectPath(((ItemResolveArgs)values![0]!).Path) });
        return Stub.Forward(realResolver, method, values);
    });
    manager.AddParts([dotIgnore, new CoreResolutionIgnoreRule(naming, paths)], [resolver, new Emby.Server.Implementations.Library.Resolvers.Audio.AudioResolver(naming)], [], [], []);
    var parent = new Folder { Id = Guid.Parse("98c00000-0000-0000-0000-000000000002"), Name = "Parent", Path = Path.Combine(root, "media") };
    manager.CreateItem(parent, null); Directory.CreateDirectory(parent.Path);
    foreach (var filename in sample.GetProperty("files").EnumerateArray()) {
        var file = Path.Combine(parent.Path, filename.GetString()!); Directory.CreateDirectory(Path.GetDirectoryName(file)!); File.WriteAllText(file, "media control", Encoding.UTF8);
        File.SetCreationTimeUtc(file, DateTime.Parse("2025-01-02T03:04:05Z").ToUniversalTime()); File.SetLastWriteTimeUtc(file, DateTime.Parse("2025-01-03T04:05:06Z").ToUniversalTime());
    }
    foreach (var ignore in sample.GetProperty("ignoreFiles").EnumerateArray()) {
        var ignorePath = Path.Combine(root, ignore.GetProperty("path").GetString()!);
        Directory.CreateDirectory(Path.GetDirectoryName(ignorePath)!);
        Encoding encoding = ignore.TryGetProperty("encoding", out var ignoreEncoding) && ignoreEncoding.GetString() == "utf16le"
            ? new UnicodeEncoding(false, true) : new UTF8Encoding(false);
        File.WriteAllText(ignorePath, ignore.GetProperty("text").GetString()!, encoding);
        File.SetCreationTimeUtc(ignorePath, DateTime.Parse("2025-01-02T03:04:05Z").ToUniversalTime());
        File.SetLastWriteTimeUtc(ignorePath, DateTime.Parse("2025-01-03T04:05:06Z").ToUniversalTime());
    }
    var owner = (BaseItem)Activator.CreateInstance(expectedType)!;
    owner.Id = Guid.Parse("98c00000-0000-0000-0000-000000000001"); owner.Name = "Stored owner";
    owner.Path = Path.Combine(parent.Path, sample.TryGetProperty("ownerPath", out var ownerPath) ? ownerPath.GetString()! : "primary.mkv"); owner.ParentId = parent.Id; owner.IsInMixedFolder = Bool("mixed");
    if (owner.IsFolder) Directory.CreateDirectory(owner.Path); else File.WriteAllText(owner.Path, "primary control"); manager.CreateItem(owner, parent);
    var target = Path.Combine(parent.Path, sample.GetProperty("files")[0].GetString()!);
    Video? old = null;
    if (Bool("wrongType") || Bool("existingType") || Bool("dropExisting")) {
        old = (Video)Activator.CreateInstance(typeof(Trailer))!;
        old.Id = manager.GetNewItemId(target, old.GetType()); old.Name = sample.TryGetProperty("oldName", out var oldName) ? oldName.GetString() : "Old version"; old.Path = target; old.ParentId = Bool("attached") ? parent.Id : Guid.Empty; old.ExtraType = ExtraType.Trailer;
        if (Bool("lockedName")) old.LockedFields = [MetadataField.Name];
        old.OwnerId = owner.Id;
        if (Bool("isAlternate") && !Bool("wrongType")) old.SetPrimaryVersionId(owner.Id);
        if (sample.TryGetProperty("runtimeTicks", out var runtimeTicks)) old.RunTimeTicks = long.Parse(runtimeTicks.GetString()!);
        manager.CreateItem(old, parent);
        if (Bool("dropExisting")) {
            ((Video)owner).LocalAlternateVersions = [target]; realPersistence.SaveItems([owner], CancellationToken.None);
            old.Name = "Cached stale name";
        }
        foreach (var directory in new[] { old.GetInternalMetadataPath() }.Concat(pathManager.GetExtractedDataPaths(old)).Distinct()) {
            Directory.CreateDirectory(directory); File.WriteAllText(Path.Combine(directory, "marker.txt"), "owned marker");
        }
    }
    parent.Children = old is null ? [owner] : [owner, old]; parent.UserData = [];
    if (Bool("missing")) File.Delete(target);
    if (sample.TryGetProperty("newFailure", out var newFailure)) using (var fault = factory.CreateDbContext()) {
        fault.Database.ExecuteSqlRaw(newFailure.GetString() == "delete"
            ? "CREATE TRIGGER fail_delete BEFORE DELETE ON BaseItems BEGIN SELECT RAISE(ABORT, 'Injected delete failure'); END"
            : "CREATE TRIGGER fail_create BEFORE INSERT ON BaseItems BEGIN SELECT RAISE(ABORT, 'Injected create failure'); END");
    }
    if (sample.TryGetProperty("failure", out var failure)) using (var fault = factory.CreateDbContext()) {
        fault.Database.ExecuteSqlRaw(failure.GetString() == "delete"
            ? "CREATE TRIGGER fail_delete BEFORE DELETE ON BaseItems BEGIN SELECT RAISE(ABORT, 'Injected delete failure'); END"
            : "CREATE TRIGGER fail_save BEFORE UPDATE ON BaseItems BEGIN SELECT RAISE(ABORT, 'Injected save failure'); END");
    }
    manager.ItemUpdated += (_, change) => calls.Add(new { action = "event", kind = "updated", id = Id(change.Item.Id), reason = (int)change.UpdateReason });
    manager.ItemAdded += (_, change) => calls.Add(new { action = "event", kind = "added", id = Id(change.Item.Id) });
    manager.ItemRemoved += (_, change) => calls.Add(new { action = "event", kind = "removed", id = Id(change.Item.Id) });
    owner.Name = "Updated owner"; owner.Genres = ["Owner genre"]; owner.Overview = "Owner overview";
    if (owner is Video ownerVideo) { ownerVideo.AdditionalParts = []; ownerVideo.LocalAlternateVersions = []; }
    using var cancellation = new CancellationTokenSource(); if (Bool("cancelled")) cancellation.Cancel();
    active = true; string? exception = null;
    try {
        await owner.RefreshMetadata(new MetadataRefreshOptions(directoryService) {
            MetadataRefreshMode = Bool("fullRefresh") ? MetadataRefreshMode.FullRefresh : MetadataRefreshMode.None, ImageRefreshMode = MetadataRefreshMode.None,
            SearchResult = new RemoteSearchResult { Name = "Owner search" }
        }, cancellation.Token);
    } catch (Exception error) {
        exception = error.GetType().Name;
        if (exception != (sample.TryGetProperty("expectException", out var expectedError) ? expectedError.GetString() : null)) Console.Error.WriteLine(sample.GetProperty("name").GetString() + ": " + error);
    }
    if (exception != (sample.TryGetProperty("expectException", out var expected) ? expected.GetString() : null)) {
        throw new InvalidOperationException("Unexpected exception for " + sample.GetProperty("name").GetString() + ": " + exception);
    }
    using var final = factory.CreateDbContext();
    var rows = final.BaseItems.AsNoTracking().Where(row => row.Type != "PLACEHOLDER").AsEnumerable().Select(row => new {
        id = Id(row.Id), type = row.Type, name = row.Name, path = ProjectPath(row.Path), parentId = row.ParentId.HasValue ? Id(row.ParentId.Value) : null,
        topParentId = row.TopParentId.HasValue ? Id(row.TopParentId.Value) : null, ownerId = row.OwnerId.HasValue ? Id(row.OwnerId.Value) : null,
        primaryVersionId = row.PrimaryVersionId.HasValue ? Id(row.PrimaryVersionId.Value) : null, presentationUniqueKey = row.PresentationUniqueKey,
        mixed = row.IsInMixedFolder, locked = row.IsLocked, productionYear = row.ProductionYear, size = row.Size, runTimeTicks = row.RunTimeTicks,
        dateCreated = Date(row.DateCreated), dateModified = Date(row.DateModified), dateLastSavedSet = row.DateLastSaved.HasValue,
        data = ProjectData(row.Data)
    }).OrderBy(row => row.id, StringComparer.Ordinal).ToArray();
    var links = final.LinkedChildren.AsNoTracking().AsEnumerable().Select(link => new { parentId = Id(link.ParentId), childId = Id(link.ChildId), childType = (int)link.ChildType, sortOrder = link.SortOrder }).OrderBy(link => link.parentId, StringComparer.Ordinal).ThenBy(link => link.sortOrder).ToArray();
    var files = Directory.GetFiles(root, "*", SearchOption.AllDirectories).Where(file => !file.EndsWith(".db", StringComparison.Ordinal))
        .Order(StringComparer.Ordinal).Select(file => new { path = ProjectPath(file), sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant() }).ToArray();
    results.Add(new { name = sample.GetProperty("name").GetString(), exception, liveOwner = ProjectItem(owner), calls, rows, links, files,
        parentChildrenCleared = typeof(Folder).GetField("_children", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(parent) is null,
        parentUserDataCleared = parent.UserData is null, oldLookupName = old is null ? null : manager.GetItemById(old.Id)?.Name });
    bool Bool(string name) => sample.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
    string? ProjectPath(string? value) => value?.Replace(root, "$STATE", StringComparison.Ordinal);
    object? ProjectItem(BaseItem? item) => item is null ? null : new {
        id = Id(item.Id), type = item.GetType().FullName, name = item.Name, path = ProjectPath(item.Path), parentId = Id(item.ParentId),
        ownerId = Id(item.OwnerId), primaryVersionId = item is Video video ? video.PrimaryVersionId?.ToString("D") : null,
        mixed = item.IsInMixedFolder, locked = item.IsLocked, productionYear = item.ProductionYear, size = item.Size, runTimeTicks = item.RunTimeTicks,
        dateCreated = Date(item.DateCreated), dateModified = Date(item.DateModified), dateLastSavedSet = item.DateLastSaved != DateTime.MinValue,
        videoType = item is Video typed ? typed.VideoType.ToString() : null, extraType = item.ExtraType?.ToString(),
        parts = item is Video stacked ? stacked.AdditionalParts.Select(ProjectPath).ToArray() : null,
        alternates = item is Video versioned ? versioned.LocalAlternateVersions.Select(ProjectPath).ToArray() : null,
        genres = item.Genres, overview = item.Overview
    };
    JsonNode? ProjectData(string? value) {
        if (value is null) return null; var node = JsonNode.Parse(value); Rewrite(node); return node;
        void Rewrite(JsonNode? current) {
            if (current is JsonObject obj) foreach (var (key, child) in obj.ToArray()) {
                if (child is JsonValue scalar && scalar.TryGetValue<string>(out var text)) {
                    if (key == "DateLastSaved" && DateTime.Parse(text).ToUniversalTime() != DateTime.MinValue) {
                        var savedAt = DateTime.Parse(text).ToUniversalTime();
                        if (savedAt < sampleStartedAt || savedAt > DateTime.UtcNow) throw new InvalidOperationException("Saved timestamp is outside this sample.");
                        obj[key] = "$UTC_SAVE";
                    } else obj[key] = ProjectPath(text);
                } else Rewrite(child);
            }
            else if (current is JsonArray array) for (var i = 0; i < array.Count; ++i) {
                if (array[i] is JsonValue scalar && scalar.TryGetValue<string>(out var text)) array[i] = ProjectPath(text); else Rewrite(array[i]);
            }
        }
    }
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    actualFrozenOwnedExtraIgnore = true, inputSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(inputText))).ToLowerInvariant(), results,
    assemblies = new[] { typeof(BaseItem).Assembly, typeof(LibraryManager).Assembly, typeof(ItemPersistenceService).Assembly }.Select(assembly => new {
        name = assembly.GetName().Name, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
    }),
    scope = "Actual frozen FindExtras/RefreshExtras with the same DotIgnoreIgnoreRule instance in root filtering and ResolvePath, plus CoreResolutionIgnoreRule. Executes actual file enumeration, dedicated extra/audio resolvers, cached item correction, independent missing deletion, ItemPersistenceService/EF SQLite, files and events. Rules cover root/ancestor/nearest, empty/comments/invalid/negation, nested exclusions and unchanged mixed counts, localized numbering, Unicode and UTF-16 BOM. Single-item provider performs no save; collection/saver/media-source/extracted-file dispatch and parent namespace are controls. No complete MetadataService, generic deletion, full scanner/network/symlink/concurrent cache or release acceptance."
}, json) + "\n");

static Type ItemType(string name) => name switch { "Movie" => typeof(Movie), "Episode" => typeof(Episode), "Trailer" => typeof(Trailer), "Video" => typeof(Video), "Series" => typeof(Series), "Season" => typeof(Season), "MusicArtist" => typeof(MusicArtist), "MusicAlbum" => typeof(MusicAlbum), _ => throw new ArgumentException(name) };
static string Id(Guid value) => value.ToString("D");
static string? Date(DateTime? value) => value?.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'");
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
