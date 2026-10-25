// Actual frozen LibraryManager resolution/batch persistence and independent fast deletion.
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Emby.Naming.Common;
using Emby.Naming.Video;
using Jellyfin.Data.Enums;
using Emby.Server.Implementations.Library.Resolvers.Movies;
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
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
BaseItem.ChannelManager = Stub.Make<MediaBrowser.Controller.Channels.IChannelManager>((method, _) =>
    method.Name == "GetStaticMediaSources" ? Array.Empty<MediaSourceInfo>() : Stub.Default(method.ReturnType));
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
    BaseItem? deletingItem = null;
    string? deletionSourcePath = null;
    string? deletionInternalMarker = null;
    string[] deletionExternalMarkers = [];
    LibraryManager? manager = null;
    var expectedType = ItemType(sample.GetProperty("expectedType").GetString()!);
    var resolverType = ItemType(sample.GetProperty("resolverType").GetString()!);
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_RootFolderPath" => Path.Combine(root, "root"), "get_ProgramDataPath" => root, "get_InternalMetadataPath" => Path.Combine(root, "metadata"),
        "get_DataPath" => Path.Combine(root, "data"), "get_TrickplayPath" => Path.Combine(root, "data", "trickplay"),
        _ => Stub.Default(method.ReturnType)
    });
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => new ServerConfiguration { CacheSize = 64 }, "get_ApplicationPaths" => paths,
        "GetConfiguration" => new MetadataConfiguration { UseFileCreationTimeForDateAdded = !Bool("useResolveTime") },
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
        if (active && method.Name == "DeleteItem") {
            var ids = ((IReadOnlyList<Guid>)values![0]!).Select(Id).ToArray();
            if (Bool("recordDeletePhases")) calls.Add(new { action = "delete", ids, state = DeletionState() });
            else calls.Add(new { action = "delete", ids });
        }
        return Stub.Forward(realPersistence, method, values);
    });
    var provider = Stub.Make<IProviderManager>((method, values) => {
        if (active && method.Name == "SaveMetadataAsync") calls.Add(new { action = "saver", id = Id(((BaseItem)values![0]!).Id), reason = (int)(ItemUpdateType)values[1]! });
        return Stub.Default(method.ReturnType);
    });
    var pathManager = new PathManager(NullLogger<PathManager>.Instance, config, paths);
    var externalData = Stub.Make<IExternalDataManager>((method, values) => {
        if (method.Name == "DeleteExternalItemFiles") {
            var item = (BaseItem)values![0]!;
            if (Bool("recordDeletePhases")) calls.Add(new { action = "external-files", id = Id(item.Id), state = DeletionState() });
            else calls.Add(new { action = "external-files", id = Id(item.Id) });
            foreach (var directory in pathManager.GetExtractedDataPaths(item)) if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
        return Stub.Default(method.ReturnType);
    });
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
    var realResolver = new MovieResolver(null!, NullLogger<MovieResolver>.Instance, naming, directoryService, new VideoListResolver(naming));
    var resolver = new RecordingMovieResolver(realResolver, value => { if (active) calls.Add(value); }, ProjectPath);
    var folderResolver = new RecordingFolderResolver(new FolderResolver(), value => { if (active) calls.Add(value); }, ProjectPath);
    manager.AddParts([new CoreResolutionIgnoreRule(naming, paths), dotIgnore], [resolver, folderResolver], [], [], []);
    var parent = new Folder { Id = Guid.Parse("98c00000-0000-0000-0000-000000000002"), Name = "Parent", Path = Path.Combine(root, "media"), IsLocked = Bool("parentLocked") };
    AggregateFolder? aggregate = null;
    if (Bool("aggregateParent")) {
        aggregate = new AggregateFolder { Id = Guid.Parse("98c00000-0000-0000-0000-000000000003"), Name = "Aggregate", Path = Path.Combine(root, "physical-root"), IsRoot = true };
        manager.CreateItem(aggregate, null); parent.ParentId = aggregate.Id;
    }
    manager.CreateItem(parent, aggregate); Directory.CreateDirectory(parent.Path);
    foreach (var filename in sample.GetProperty("files").EnumerateArray()) {
        var file = Path.Combine(parent.Path, filename.GetString()!.Replace('/', Path.DirectorySeparatorChar)); Directory.CreateDirectory(Path.GetDirectoryName(file)!); File.WriteAllText(file, "media control", Encoding.UTF8);
        File.SetCreationTimeUtc(file, DateTime.Parse("2025-01-02T03:04:05Z").ToUniversalTime()); File.SetLastWriteTimeUtc(file, DateTime.Parse("2025-01-03T04:05:06Z").ToUniversalTime());
    }
    foreach (var ignore in sample.GetProperty("ignoreFiles").EnumerateArray()) {
        var ignorePath = Path.Combine(root, ignore.GetProperty("path").GetString()!);
        Directory.CreateDirectory(Path.GetDirectoryName(ignorePath)!);
        Encoding encoding = ignore.TryGetProperty("encoding", out var value) && value.GetString() == "utf16le"
            ? new UnicodeEncoding(false, true) : new UTF8Encoding(false);
        File.WriteAllText(ignorePath, ignore.GetProperty("text").GetString()!, encoding);
        File.SetCreationTimeUtc(ignorePath, DateTime.Parse("2025-01-02T03:04:05Z").ToUniversalTime());
        File.SetLastWriteTimeUtc(ignorePath, DateTime.Parse("2025-01-03T04:05:06Z").ToUniversalTime());
    }
    foreach (var directory in sample.GetProperty("directories").EnumerateArray())
        Directory.CreateDirectory(Path.Combine(parent.Path, directory.GetString()!.Replace('/', Path.DirectorySeparatorChar)));
    foreach (var directory in Directory.GetDirectories(parent.Path, "*", SearchOption.AllDirectories).Append(parent.Path)) {
        Directory.SetCreationTimeUtc(directory, DateTime.Parse("2024-02-03T04:05:06Z").ToUniversalTime());
        Directory.SetLastWriteTimeUtc(directory, DateTime.Parse("2024-02-04T05:06:07Z").ToUniversalTime());
    }
    var owner = (Video)Activator.CreateInstance(expectedType)!;
    owner.Id = Guid.Parse("98c00000-0000-0000-0000-000000000001"); owner.Name = "Stored owner";
    owner.Path = Path.Combine(parent.Path, "primary.mkv"); owner.ParentId = parent.Id; owner.IsInMixedFolder = Bool("mixed");
    File.WriteAllText(owner.Path, "primary control"); manager.CreateItem(owner, parent);
    var target = Path.Combine(parent.Path, sample.GetProperty("files")[0].GetString()!.Replace('/', Path.DirectorySeparatorChar));
    Video? old = null;
    if (Bool("wrongType") || Bool("existingType") || Bool("dropExisting")) {
        old = (Video)Activator.CreateInstance(Bool("wrongType") ? typeof(Video) : expectedType)!;
        old.Id = manager.GetNewItemId(target, old.GetType()); old.Name = "Old version"; old.Path = target; old.ParentId = parent.Id;
        if (sample.TryGetProperty("runtimeTicks", out var runtimeTicks)) old.RunTimeTicks = long.Parse(runtimeTicks.GetString()!);
        manager.CreateItem(old, parent);
        if (Bool("dropExisting")) {
            owner.LocalAlternateVersions = [target]; realPersistence.SaveItems([owner], CancellationToken.None);
            old.Name = "Cached stale name";
        }
        foreach (var directory in new[] { old.GetInternalMetadataPath() }.Concat(pathManager.GetExtractedDataPaths(old)).Distinct()) {
            Directory.CreateDirectory(directory); File.WriteAllText(Path.Combine(directory, "marker.txt"), "owned marker");
        }
    }
    parent.Children = old is null ? [owner] : [owner, old]; parent.UserData = [];
    if (sample.TryGetProperty("failure", out var failure)) using (var fault = factory.CreateDbContext()) {
        fault.Database.ExecuteSqlRaw(failure.GetString() == "delete"
            ? "CREATE TRIGGER fail_delete BEFORE DELETE ON BaseItems BEGIN SELECT RAISE(ABORT, 'Injected delete failure'); END"
            : "CREATE TRIGGER fail_save BEFORE UPDATE ON BaseItems BEGIN SELECT RAISE(ABORT, 'Injected save failure'); END");
    }
    manager.ItemUpdated += (_, change) => calls.Add(new { action = "event", kind = "updated", id = Id(change.Item.Id), reason = (int)change.UpdateReason });
    manager.ItemAdded += (_, change) => calls.Add(new { action = "event", kind = "added", id = Id(change.Item.Id) });
    manager.ItemRemoved += (_, change) => {
        if (Bool("recordDeletePhases")) calls.Add(new { action = "event", kind = "removed", id = Id(change.Item.Id), state = DeletionState() });
        else calls.Add(new { action = "event", kind = "removed", id = Id(change.Item.Id) });
    };
    owner.Name = "Updated owner";
    owner.LocalAlternateVersions = (sample.TryGetProperty("versions", out var versions) ? versions.EnumerateArray()
        : sample.GetProperty("files").EnumerateArray()).Select(value => value.ValueKind == JsonValueKind.Null ? null! : value.GetString() == "" ? "" : Path.Combine(parent.Path, value.GetString()!)).ToArray();
    using var cancellation = new CancellationTokenSource(); if (Bool("cancelled")) cancellation.Cancel();
    if (Bool("failInsert")) using (var fault = factory.CreateDbContext()) {
        fault.Database.ExecuteSqlRaw("CREATE TRIGGER fail_insert BEFORE INSERT ON BaseItems BEGIN SELECT RAISE(ABORT, 'Injected insert failure'); END");
    }
    if (Bool("failInsertAlternate")) using (var fault = factory.CreateDbContext()) {
        fault.Database.ExecuteSqlRaw("CREATE TRIGGER fail_alternate_insert BEFORE INSERT ON BaseItems WHEN NEW.OwnerId IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Injected alternate insert failure'); END");
    }
    if (Bool("failLinks")) using (var fault = factory.CreateDbContext()) {
        fault.Database.ExecuteSqlRaw("CREATE TRIGGER fail_link_insert BEFORE INSERT ON LinkedChildren BEGIN SELECT RAISE(ABORT, 'Injected link insert failure'); END");
    }
    var createdResolvedIds = new HashSet<Guid>();
    var createdLookupIds = new HashSet<Guid>();
    active = true; object? resolved = null; string? exception = null;
    try {
        if (sample.GetProperty("operation").GetString() == "resolvepaths") {
            var nativeFiles = sample.GetProperty("entries").EnumerateArray().Select(file => fileSystem.GetFileSystemInfo(Path.Combine(parent.Path, file.GetString()!.Replace('/', Path.DirectorySeparatorChar)))).ToArray();
            var nativeItems = manager.ResolvePaths(nativeFiles, directoryService, parent, new LibraryOptions(), Enum.Parse<CollectionType>(sample.GetProperty("collectionType").GetString()!), [resolver, folderResolver]).ToArray();
            resolved = nativeItems.Select(ProjectItem).ToArray();
            foreach (var item in nativeItems) createdResolvedIds.Add(item.Id);
            foreach (var item in nativeItems) {
                createdLookupIds.Add(item.Id);
                if (item is Video video) foreach (var path in video.LocalAlternateVersions)
                    if (!string.IsNullOrEmpty(path)) createdLookupIds.Add(manager.GetNewItemId(path, video.GetType()));
                if (Bool("nullAlternates") && item is Video nullVideo) nullVideo.LocalAlternateVersions = null!;
                if (Bool("channelOriginal")) item.ChannelId = Guid.Parse("98c00000-0000-0000-0000-000000000009");
            }
            manager.CreateItems(nativeItems, Bool("nullParent") ? null : parent, Bool("cancelled") ? cancellation.Token : CancellationToken.None);
            if (Bool("repeatCreate")) manager.CreateItems(nativeItems, parent, CancellationToken.None);
            if (Bool("deleteCreated")) {
                var deleted = nativeItems[0];
                deletingItem = deleted;
                if (Bool("deleteAlternate") && deleted is Video primary) {
                    var alternateId = manager.GetLocalAlternateVersionIds(primary).First();
                    deleted = manager.GetItemById(alternateId)!;
                }
                if (Bool("createDescendants") && deleted is Folder deletedFolder) await CreateDescendants(deletedFolder);
                if (sample.TryGetProperty("removeAlternatesBeforeDelete", out var removeAlternates) && deleted is Video alternateOwner) {
                    var removeIds = manager.GetLocalAlternateVersionIds(alternateOwner);
                    if (removeAlternates.GetString() == "first") removeIds = removeIds.Take(1).ToArray();
                    foreach (var id in removeIds) {
                        var file = manager.GetItemById(id)!.Path;
                        if (!Path.GetFullPath(file).StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Missing-alternate control escaped sample root.");
                        File.Delete(file);
                    }
                }
                if (sample.TryGetProperty("persistedVideoType", out var persistedVideoType)) using (var drift = factory.CreateDbContext()) {
                    var row = drift.BaseItems.Single(row => row.Id == deleted.Id);
                    var data = JsonNode.Parse(row.Data!)!.AsObject();
                    data["VideoType"] = persistedVideoType.GetString();
                    row.Data = data.ToJsonString();
                    drift.SaveChanges();
                }
                if (sample.TryGetProperty("liveVideoType", out var liveVideoType) && deleted is Video driftVideo)
                    driftVideo.VideoType = Enum.Parse<VideoType>(liveVideoType.GetString()!);
                if (Bool("safetyDivergence")) {
                    using var drift = factory.CreateDbContext();
                    var data = JsonNode.Parse(drift.BaseItems.AsNoTracking().Single(row => row.Id == deleted.Id).Data!)!.AsObject();
                    calls.Add(new {
                        action = "video-type-drift",
                        persisted = data["VideoType"]!.GetValue<string>(),
                        live = ((Video)deleted).VideoType.ToString()
                    });
                }
                var markerItems = new[] { deleted }.Concat(deleted is Folder markerFolder ? markerFolder.GetRecursiveChildren(false) : []);
                foreach (var markerItem in markerItems) foreach (var directory in new[] { markerItem.GetInternalMetadataPath() }.Concat(pathManager.GetExtractedDataPaths(markerItem)).Distinct()) {
                    var absolute = Path.GetFullPath(directory);
                    if (!absolute.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Deletion marker escaped the controlled state root.");
                    Directory.CreateDirectory(absolute); File.WriteAllText(Path.Combine(absolute, "marker.txt"), "delete marker");
                }
                deletionInternalMarker = Path.Combine(deleted.GetInternalMetadataPath(), "marker.txt");
                deletionExternalMarkers = pathManager.GetExtractedDataPaths(deleted).Select(directory => Path.Combine(directory, "marker.txt")).ToArray();
                var deletePaths = deleted.GetDeletePaths().ToArray();
                deletionSourcePath = deletePaths.FirstOrDefault()?.FullName;
                if (Bool("removeSourceBeforeDelete") && deletionSourcePath is not null && Directory.Exists(deletionSourcePath)) Directory.Delete(deletionSourcePath, true);
                if (Bool("recordDeletePhases")) calls.Add(new {
                    action = "delete-paths",
                    paths = deletePaths.Select(entry => new { path = ProjectPath(entry.FullName), directory = entry.IsDirectory }).ToArray(),
                    state = DeletionState()
                });
                parent.Children = nativeItems; parent.UserData = [];
                if (Bool("failDelete")) using (var fault = factory.CreateDbContext())
                    fault.Database.ExecuteSqlRaw("CREATE TRIGGER delete_failure BEFORE DELETE ON BaseItems BEGIN SELECT RAISE(ABORT, 'Controlled deletion failure'); END");
                FileStream? sourceLock = null;
                string? readOnlyFile = null;
                try {
                    if (Bool("lockSource") && deletionSourcePath is not null) {
                        var lockFile = Directory.GetFiles(deletionSourcePath, "*", SearchOption.AllDirectories).First();
                        sourceLock = new FileStream(lockFile, FileMode.Open, FileAccess.Read, FileShare.None);
                    }
                    if (Bool("readOnlySource") && deletionSourcePath is not null) {
                        readOnlyFile = Directory.GetFiles(deletionSourcePath, "*", SearchOption.AllDirectories).First();
                        File.SetAttributes(readOnlyFile, File.GetAttributes(readOnlyFile) | FileAttributes.ReadOnly);
                    }
                    manager.DeleteItem(deleted, new DeleteOptions { DeleteFileLocation = Bool("deleteSource"), DeleteFromExternalProvider = false },
                        Bool("nullDeleteParent") ? null! : parent, !Bool("noNotify"));
                }
                finally {
                    sourceLock?.Dispose();
                    if (readOnlyFile is not null && File.Exists(readOnlyFile)) File.SetAttributes(readOnlyFile, FileAttributes.Normal);
                }
            }
            if (sample.TryGetProperty("mutateRepeats", out var mutations)) foreach (var mutation in mutations.EnumerateArray()) {
                foreach (var item in nativeItems) foreach (var field in mutation.EnumerateObject()) {
                    var property = item.GetType().GetProperty(field.Name) ?? throw new InvalidOperationException("Missing native field " + field.Name);
                    if (!property.CanWrite) throw new InvalidOperationException("Read-only native field " + field.Name);
                    property.SetValue(item, JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, json));
                }
                manager.CreateItems(nativeItems, parent, CancellationToken.None);
            }
            if (sample.TryGetProperty("staleColumns", out var staleColumns)) {
                using (var corrupt = factory.CreateDbContext()) {
                    foreach (var item in nativeItems) {
                        var row = corrupt.BaseItems.Single(row => row.Id == item.Id);
                        foreach (var field in staleColumns.EnumerateObject()) {
                            var property = row.GetType().GetProperty(field.Name) ?? throw new InvalidOperationException("Missing mapped field " + field.Name);
                            property.SetValue(row, JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, json));
                        }
                        var data = JsonNode.Parse(row.Data!)!.AsObject(); data["UnknownStoredField"] = "stale-data"; row.Data = data.ToJsonString();
                    }
                    corrupt.SaveChanges();
                }
                manager.CreateItems(nativeItems, parent, CancellationToken.None);
            }
        }
        else if (sample.GetProperty("operation").GetString() == "resolve") resolved = ProjectItem(manager.ResolveAlternateVersion(target, expectedType, parent, null));
        else await manager.UpdateItemAsync(owner, parent, ItemUpdateType.MetadataImport, cancellation.Token);
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
        dateCreated = createdResolvedIds.Contains(row.Id) && (row.Type == typeof(Folder).FullName || Bool("useResolveTime")) ? ResolveDate(row.DateCreated ?? DateTime.MinValue) : Date(row.DateCreated), dateModified = Date(row.DateModified), dateLastSavedSet = row.DateLastSaved.HasValue,
        data = ProjectData(row.Data)
    }).OrderBy(row => row.id, StringComparer.Ordinal).ToArray();
    var links = final.LinkedChildren.AsNoTracking().AsEnumerable().Select(link => new { parentId = Id(link.ParentId), childId = Id(link.ChildId), childType = (int)link.ChildType, sortOrder = link.SortOrder }).OrderBy(link => link.parentId, StringComparer.Ordinal).ThenBy(link => link.sortOrder).ToArray();
    var files = Directory.GetFiles(root, "*", SearchOption.AllDirectories).Where(file => !file.EndsWith(".db", StringComparison.Ordinal))
        .Order(StringComparer.Ordinal).Select(file => new { path = ProjectPath(file), sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant() }).ToArray();
    var ancestors = final.AncestorIds.AsNoTracking().AsEnumerable().Select(row => new {
        itemId = Id(row.ItemId), parentItemId = Id(row.ParentItemId)
    }).OrderBy(row => row.itemId, StringComparer.Ordinal).ThenBy(row => row.parentItemId, StringComparer.Ordinal).ToArray();
    var providers = final.BaseItemProviders.AsNoTracking().AsEnumerable().Select(row => new {
        itemId = Id(row.ItemId), providerId = row.ProviderId, providerValue = row.ProviderValue
    }).OrderBy(row => row.itemId, StringComparer.Ordinal).ThenBy(row => row.providerId, StringComparer.Ordinal).ToArray();
    var properties = final.Model.FindEntityType(typeof(Jellyfin.Database.Implementations.Entities.BaseItemEntity))!.GetProperties().ToArray();
    var columns = final.BaseItems.AsNoTracking().Where(row => row.Type != "PLACEHOLDER").AsEnumerable()
        .OrderBy(row => row.Id.ToString("D"), StringComparer.Ordinal)
        .Select(row => properties.ToDictionary(property => property.Name, property => {
            if (property.PropertyInfo is null) throw new InvalidOperationException("A mapped column has no CLR property: " + property.Name);
            object? value = property.PropertyInfo.GetValue(row);
            if (value is null) return (object?)null;
            if (property.Name == "Data") return ProjectData((string)value);
            if (value is Guid identifier) return Id(identifier);
            if (value is DateTime timestamp) {
                if (property.Name == "DateLastSaved" && timestamp != DateTime.MinValue) {
                    if (timestamp < sampleStartedAt || timestamp > DateTime.UtcNow) throw new InvalidOperationException("Saved UTC is outside the actual sample.");
                    return "$UTC_SAVE";
                }
                if (property.Name == "DateCreated" && createdResolvedIds.Contains(row.Id)
                    && (row.Type == typeof(Folder).FullName || Bool("useResolveTime"))) return ResolveDate(timestamp);
                return Date(timestamp);
            }
            if (value is string text) return ProjectPath(text);
            return value;
        })).ToArray();
    var createdLookup = createdLookupIds.OrderBy(Id, StringComparer.Ordinal).Select(id => new { id = Id(id), item = ProjectItem(manager.GetItemById(id)) }).ToArray();
    results.Add(new { name = sample.GetProperty("name").GetString(), exception, resolved, calls, rows, links, ancestors, providers, files, columns, createdLookup,
        parentChildrenCleared = typeof(Folder).GetField("_children", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(parent) is null,
        parentUserDataCleared = parent.UserData is null, oldLookupName = old is null ? null : manager.GetItemById(old.Id)?.Name });
    bool Bool(string name) => sample.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
    object DeletionState() {
        using var phase = factory.CreateDbContext();
        var itemId = deletingItem?.Id;
        return new {
            sourceExists = deletionSourcePath is not null && (Directory.Exists(deletionSourcePath) || File.Exists(deletionSourcePath)),
            internalExists = deletionInternalMarker is not null && File.Exists(deletionInternalMarker),
            externalExists = deletionExternalMarkers.Any(File.Exists),
            databaseExists = itemId.HasValue && phase.BaseItems.AsNoTracking().Any(row => row.Id == itemId.Value),
            cacheExists = itemId.HasValue && manager!.GetItemById(itemId.Value) is not null,
            parentId = deletingItem is null ? null : Id(deletingItem.ParentId)
        };
    }
    string? ProjectPath(string? value) => value?.Replace(root, "$STATE", StringComparison.Ordinal);
    Task CreateDescendants(Folder folder) {
        var entries = directoryService.GetFileSystemEntries(folder.Path);
        var children = manager.ResolvePaths(entries, directoryService, folder, new LibraryOptions(), CollectionType.movies, [resolver, folderResolver]).ToArray();
        foreach (var child in children) { createdLookupIds.Add(child.Id); createdResolvedIds.Add(child.Id); }
        manager.CreateItems(children, folder, CancellationToken.None); folder.Children = children;
        foreach (var child in children.OfType<Folder>()) CreateDescendants(child).GetAwaiter().GetResult();
        return Task.CompletedTask;
    }
    object? ProjectItem(BaseItem? item) => item is null ? null : new {
        id = Id(item.Id), type = item.GetType().FullName, name = item.Name, path = ProjectPath(item.Path), parentId = Id(item.ParentId),
        isFolder = item.IsFolder, mediaType = item.MediaType.ToString(), providerIds = item.ProviderIds, video3DFormat = item is Video format ? format.Video3DFormat?.ToString() : null,
        ownerId = Id(item.OwnerId), primaryVersionId = item is Video video ? video.PrimaryVersionId?.ToString("D") : null,
        mixed = item.IsInMixedFolder, locked = item.IsLocked, productionYear = item.ProductionYear, size = item.Size, runTimeTicks = item.RunTimeTicks,
        dateCreated = item.IsFolder || Bool("useResolveTime") ? ResolveDate(item.DateCreated) : Date(item.DateCreated), dateModified = Date(item.DateModified), dateLastSavedSet = item.DateLastSaved != DateTime.MinValue,
        videoType = item is Video typed ? typed.VideoType.ToString() : null, extraType = item.ExtraType?.ToString(),
        parts = item is Video stacked ? stacked.AdditionalParts.Select(ProjectPath).ToArray() : null,
        alternates = item is Video alternate ? alternate.LocalAlternateVersions.Select(ProjectPath).ToArray() : null
    };
    string ResolveDate(DateTime value) {
        if (value < sampleStartedAt || value > DateTime.UtcNow) throw new InvalidOperationException("Creation UTC must be inside the actual sample when directory metadata is minimum or configuration disables file creation time.");
        return "$UTC_RESOLVE";
    }
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
    actualFrozenDirectoryItemDeletion = true, inputSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(inputText))).ToLowerInvariant(), results,
    assemblies = new[] { typeof(BaseItem).Assembly, typeof(LibraryManager).Assembly, typeof(ItemPersistenceService).Assembly }.Select(assembly => new {
        name = assembly.GetName().Name, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
    }),
    scope = "Actual frozen ResolvePaths/CreateItems/ItemPersistenceService and LibraryManager.DeleteItem with controlled ordinary Movie/Folder sources and isolated direct or multi-disc DVD/Blu-ray Movie, MusicVideo and Video sources. Complete original resolved/dispatch/row/full Data/link/file/cache/event/created lookup projections, all 72 scalar columns and full ancestor/provider relations remain. Real internal metadata, extracted-data markers and media trees run inside a verified controlled state root. The recording covers DeleteFileLocation false and true, direct-disc Path deletion, the multi-disc single outer-parent delete path rather than per-part deletion, sidecar and sibling boundaries, already-missing sources, Windows read-only and exclusive-lock failures with partial recursive deletion, and source cleanup retained across a later real EF SQLite delete failure. Six counterexamples mutate persisted Data.VideoType and the live VideoType independently after CreateItems: native deletion follows only the live value, including the direct disc-to-VideoFile drift that derives and deletes the whole discovery parent with its Keep sentinel and sibling primary. Folder source failures additionally prove that only internal metadata is removed before the source attempt while extracted data is retained; Video source-failure ordering remains unchanged. Phase snapshots freeze internal/source/external/DB/cache/Parent/event ordering. The prior ordinary source retention/deletion, version promotion, alternate cleanup, recursive Folder descendants, channel suppression, null parent, no-notify and SQL-fault scenes remain. Metadata saver/provider, collection membership and media-source/channel-static-source dispatch are explicit empty controls; production deliberately rejects the recorded VideoType divergence, while disc owned/version families and arbitrary native types remain fail-closed and outside this recording, as are child MetadataService, migration, clients, performance and release acceptance."
}, json) + "\n");

static Type ItemType(string name) => name switch { "Movie" => typeof(Movie), "MusicVideo" => typeof(MusicVideo), "Episode" => typeof(Episode), "Trailer" => typeof(Trailer), "Video" => typeof(Video), _ => throw new ArgumentException(name) };
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

public sealed class RecordingMovieResolver(MovieResolver inner, Action<object> record, Func<string?, string?> normalize) : IItemResolver, IMultiItemResolver {
    public ResolverPriority Priority => inner.Priority;
    public BaseItem? ResolvePath(ItemResolveArgs args) {
        record(new { action = "resolve", path = normalize(args.Path) });
        return inner.ResolvePath(args);
    }
    public MultiItemResolverResult ResolveMultiple(Folder parent, List<MediaBrowser.Model.IO.FileSystemMetadata> files, CollectionType? collectionType, IDirectoryService directoryService) {
        record(new { action = "multi", files = files.Select(file => normalize(file.FullName)).ToArray(), collectionType = collectionType?.ToString() });
        return inner.ResolveMultiple(parent, files, collectionType, directoryService);
    }
}

public sealed class RecordingFolderResolver(FolderResolver inner, Action<object> record, Func<string?, string?> normalize) : IItemResolver {
    public ResolverPriority Priority => inner.Priority;
    public BaseItem? ResolvePath(ItemResolveArgs args) {
        record(new { action = "folder", path = normalize(args.Path) });
        return inner.ResolvePath(args);
    }
}
