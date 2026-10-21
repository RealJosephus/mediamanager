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
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Extensions.Json;
using Jellyfin.Api.Middleware;
using Jellyfin.LiveTv.Channels;
using Jellyfin.LiveTv;
using Jellyfin.LiveTv.Recordings;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Channels;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.LiveTv;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var sqliteNativeName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqliteNativeFilename = Path.Combine(AppContext.BaseDirectory, sqliteNativeName);
var sqliteNativeBytes = File.ReadAllBytes(sqliteNativeFilename);
var sqliteNativeHandle = NativeLibrary.Load(sqliteNativeFilename);
// Resolve only the native library supplied with this isolated reference build.
// An absent or unloadable packaged image must fail instead of finding a host copy.
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly,
    (name, _, _) => name == "e_sqlite3" ? sqliteNativeHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var bytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(bytes).RootElement;
var root = Path.GetFullPath(args[2]);
Directory.CreateDirectory(root);
string Map(string value) => value.Replace("{root}", root, StringComparison.Ordinal).Replace('/', Path.DirectorySeparatorChar);
var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
    "get_DataPath" => Path.Combine(root, "data"), "get_ProgramDataPath" => root,
    _ => Stub.Default(method.ReturnType)
});
var liveOptions = input.GetProperty("configuration").Deserialize<LiveTvOptions>(JsonDefaults.Options)!;
liveOptions.RecordingPath = Map(liveOptions.RecordingPath!);
liveOptions.MovieRecordingPath = Map(liveOptions.MovieRecordingPath!);
liveOptions.SeriesRecordingPath = Map(liveOptions.SeriesRecordingPath!);
foreach (var directory in input.GetProperty("directories").EnumerateArray()) Directory.CreateDirectory(Map(directory.GetString()!));
var serverConfiguration = new ServerConfiguration { CacheSize = 256 };
var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
    "get_CommonApplicationPaths" or "get_ApplicationPaths" => paths,
    "get_Configuration" => serverConfiguration,
    "GetConfiguration" => liveOptions,
    _ => Stub.Default(method.ReturnType)
});
BaseItem.ConfigurationManager = configuration;
BaseItem.Logger = NullLogger<BaseItem>.Instance;
BaseItem.LocalizationManager = Stub.Make<ILocalizationManager>((method, _) => Stub.Default(method.ReturnType));
BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
var disabledOptions = new HashSet<string>(StringComparer.Ordinal);
CollectionFolder.XmlSerializer = Stub.Make<IXmlSerializer>((method, values) => method.Name == "DeserializeFromFile"
    ? new LibraryOptions { Enabled = !disabledOptions.Contains((string)values![^1]!) } : Stub.Default(method.ReturnType));
var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath"
    ? values![0] : Stub.Default(method.ReturnType));
CollectionFolder.ApplicationHost = appHost;
// EnsureCreated produces today's EF model rather than the pinned migrated
// instance schema. Seed only a byte copy of the supplied, stopped database.
var sourceDatabaseFilename = Path.GetFullPath(args[3]);
var databaseFilename = Path.Combine(root, "native.db");
if (string.Equals(sourceDatabaseFilename, databaseFilename, StringComparison.OrdinalIgnoreCase))
    throw new InvalidOperationException("The controlled database must be a private copy.");
var sourceDatabaseSha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(sourceDatabaseFilename)));
File.Copy(sourceDatabaseFilename, databaseFilename, overwrite: false);
var copiedDatabaseSha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(databaseFilename)));
if (copiedDatabaseSha256 != sourceDatabaseSha256) throw new InvalidOperationException("The stopped database copy differs.");
var factory = new SqlFactory(databaseFilename);
string DatabaseSchemaAndHistory() {
    using var database = factory.CreateDbContext();
    var connection = database.Database.GetDbConnection(); connection.Open();
    using var command = connection.CreateCommand();
    command.CommandText = "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name";
    var schema = new List<object>();
    using (var reader = command.ExecuteReader()) while (reader.Read()) schema.Add(new {
        type = reader.GetString(0), name = reader.GetString(1), table = reader.GetString(2), sql = reader.IsDBNull(3) ? null : reader.GetString(3) });
    command.CommandText = "SELECT MigrationId, ProductVersion FROM __EFMigrationsHistory ORDER BY MigrationId";
    var migrations = new List<object>();
    using (var reader = command.ExecuteReader()) while (reader.Read()) migrations.Add(new { id = reader.GetString(0), productVersion = reader.GetString(1) });
    if (migrations.Count == 0) throw new InvalidOperationException("The designated stopped database must retain its migration history.");
    return JsonSerializer.Serialize(new { schema, migrations });
}
var schemaAndHistory = DatabaseSchemaAndHistory();
Dictionary<string, int> resetRows = [];
using (var initial = factory.CreateDbContext()) {
    using var transaction = initial.Database.BeginTransaction();
    // Only this private component's library graph is controlled. Accounts,
    // pinned columns, indices and migration history retain their source shape.
    foreach (var table in new[] { "LinkedChildren", "BaseItems", "ItemValues" })
        resetRows[table] = initial.Database.ExecuteSqlRaw($"DELETE FROM \"{table}\"");
    transaction.Commit();
}
var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration, NullLogger<BaseItemRepository>.Instance);
BaseItem.ItemRepository = repository;
object ChannelProjection(Channel channel) => new {
    type = channel.GetType().FullName, sourceType = channel.SourceType.ToString(), mediaType = channel.MediaType.ToString(),
    unratedType = channel.GetBlockUnratedType().ToString(), channel.IsFolder, channel.IsHidden, channel.IsDisplayedAsFolder,
    channel.SupportsPlayedStatus, channel.SupportsPositionTicksResume, canDelete = channel.CanDelete(),
    channel.IsRoot, channel.Container, channel.Width, channel.Height, channel.Size,
    id = channel.Id.ToString("N"), channelId = channel.ChannelId.ToString("N"), channel.Name, channel.Path,
    serialized = JsonSerializer.Serialize(channel, JsonDefaults.Options)
};
var channelCases = new List<object>();
foreach (var sample in input.GetProperty("channelCases").EnumerateArray()) {
    var row = new BaseItemEntity { Id = Guid.Parse(sample.GetProperty("id").GetString()!), Type = typeof(Channel).FullName,
        Name = "Persisted channel", Path = Map("{root}/channel"), IsFolder = false, MediaType = "Video",
        ChannelId = Guid.Empty, Size = 17, Width = 12, Height = null,
        Data = sample.GetProperty("data").ValueKind == JsonValueKind.Null ? null : sample.GetProperty("data").GetString() };
    var logger = new CaptureLogger();
    var mapped = (Channel)BaseItemMapper.DeserializeBaseItem(row, logger, appHost)!;
    serverConfiguration.SkipDeserializationForBasicTypes = sample.GetProperty("skipBasic").GetBoolean();
    var repositoryMapped = (Channel)repository.DeserializeBaseItem(row)!;
    serverConfiguration.SkipDeserializationForBasicTypes = false;
    channelCases.Add(new { name = sample.GetProperty("name").GetString(), row, value = ChannelProjection(mapped),
        repositoryValue = ChannelProjection(repositoryMapped), jsonErrors = logger.Errors });
}
var channelContract = new {
    requiresJson = BaseItemMapper.TypeRequiresDeserialization(typeof(Channel)), constructor = ChannelProjection(new Channel()),
    properties = JsonDefaults.Options.GetTypeInfo(typeof(Channel)).Properties.Where(property => property.Get is not null || property.Set is not null).Select(property => new {
        name = property.Name, getterOnly = property.Set is null, type = property.PropertyType.FullName }), cases = channelCases
};
void Set(object target, string name, object value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
var library = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
Set(library, "_cache", new FastConcurrentLru<Guid, BaseItem>(256));
Set(library, "_itemRepository", repository);
Set(library, "_configurationManager", configuration);
BaseItem.LibraryManager = library;
var user = new User("recordings-component", "fixture", "fixture") { Id = Guid.Parse(input.GetProperty("userId").GetString()!) };
user.Permissions.Add(new Permission(PermissionKind.EnableAllFolders, true));
var users = Stub.Make<IUserManager>((method, values) => method.Name == "GetUserById" && (Guid)values![0]! == user.Id ? user : Stub.Default(method.ReturnType));
var items = new List<BaseItem>();
var entities = new List<BaseItemEntity>();
foreach (var source in input.GetProperty("items").EnumerateArray()) {
    var type = source.GetProperty("type").GetString();
    BaseItem item = type switch {
        "AggregateFolder" => new AggregateFolder(), "UserRootFolder" => new UserRootFolder(), "CollectionFolder" => new CollectionFolder(),
        "Folder" => new Folder(), "Movie" => new Movie(), "Episode" => new Episode(), "Audio" => new Audio(), _ => new Video()
    };
    item.Id = Guid.Parse(source.GetProperty("id").GetString()!);
    item.Name = source.GetProperty("name").GetString();
    item.Path = Map(source.GetProperty("path").GetString()!);
    item.SortName = source.GetProperty("sortName").GetString();
    item.DateCreated = source.TryGetProperty("dateCreated", out var date) ? date.GetDateTime() : new DateTime(2025, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    if (source.TryGetProperty("parentId", out var parent)) item.ParentId = Guid.Parse(parent.GetString()!);
    if (source.TryGetProperty("ownerId", out var owner)) item.OwnerId = Guid.Parse(owner.GetString()!);
    if (source.TryGetProperty("primaryVersionId", out var primary) && item is Video version) version.PrimaryVersionId = Guid.Parse(primary.GetString()!);
    if (source.TryGetProperty("tags", out var tags)) item.Tags = tags.EnumerateArray().Select(value => value.GetString()!).ToArray();
    if (source.TryGetProperty("genres", out var genres)) item.Genres = genres.EnumerateArray().Select(value => value.GetString()!).ToArray();
    item.IsVirtualItem = source.TryGetProperty("isVirtualItem", out var virtualItem) && virtualItem.GetBoolean();
    if (item is CollectionFolder collection) {
        collection.PhysicalLocationsList = source.GetProperty("physicalLocations").EnumerateArray().Select(value => Map(value.GetString()!)).ToArray();
    }
    if (source.TryGetProperty("presentation", out var presentation)) item.PresentationUniqueKey = presentation.GetString();
    else item.PresentationUniqueKey = item.Id.ToString("N");
    var entity = new BaseItemEntity { Id = item.Id, Type = item.GetType().FullName, Name = item.Name, SortName = item.SortName,
        Path = item.Path, ParentId = item.ParentId == Guid.Empty ? null : item.ParentId, IsFolder = item.IsFolder,
        MediaType = source.TryGetProperty("mediaType", out var mediaType) ? mediaType.GetString() : null,
        DateCreated = item.DateCreated, IsVirtualItem = item.IsVirtualItem, PresentationUniqueKey = item.PresentationUniqueKey,
        Tags = string.Join('|', item.Tags), Genres = string.Join('|', item.Genres),
        OwnerId = item.OwnerId == Guid.Empty ? null : item.OwnerId,
        PrimaryVersionId = source.TryGetProperty("primaryVersionId", out var storedPrimary) ? Guid.Parse(storedPrimary.GetString()!) : null,
        Data = JsonSerializer.Serialize(item, item.GetType(), JsonDefaults.Options)
    };
    entities.Add(entity); items.Add(item);
}
using (var database = factory.CreateDbContext()) {
    database.BaseItems.AddRange(entities); database.SaveChanges();
    foreach (var source in input.GetProperty("items").EnumerateArray()) {
        var id = Guid.Parse(source.GetProperty("id").GetString()!);
        if (!source.TryGetProperty("ancestors", out var ancestors)) continue;
        foreach (var ancestor in ancestors.EnumerateArray()) {
            var parent = Guid.Parse(ancestor.GetString()!);
            database.AncestorIds.Add(new AncestorId { ItemId = id, ParentItemId = parent,
                Item = entities.Single(value => value.Id == id), ParentItem = entities.Single(value => value.Id == parent) });
        }
    }
    var values = new Dictionary<string, ItemValue>(StringComparer.Ordinal);
    foreach (var entity in entities) foreach (var genre in (entity.Genres ?? "").Split('|', StringSplitOptions.RemoveEmptyEntries)) {
        if (!values.TryGetValue(genre, out var value)) {
            value = new ItemValue { ItemValueId = Guid.NewGuid(), Type = ItemValueType.Genre, Value = genre, CleanValue = genre.ToLowerInvariant() };
            values.Add(genre, value); database.ItemValues.Add(value);
        }
        database.ItemValuesMap.Add(new ItemValueMap { ItemId = entity.Id, ItemValueId = value.ItemValueId, Item = entity, ItemValue = value });
    }
    database.SaveChanges();
}
var userRoot = items.OfType<UserRootFolder>().Single();
userRoot.Children = items.Where(item => item.ParentId == userRoot.Id).ToArray();
Set(library, "_userRootFolder", userRoot);
Set(library, "_rootFolder", items.OfType<AggregateFolder>().Single());
var recordings = (RecordingsManager)RuntimeHelpers.GetUninitializedObject(typeof(RecordingsManager));
Set(recordings, "_config", configuration);
var manager = (LiveTvManager)RuntimeHelpers.GetUninitializedObject(typeof(LiveTvManager));
Set(manager, "_recordingsManager", recordings); Set(manager, "_libraryManager", library); Set(manager, "_userManager", users);
var providerCalls = new List<object>();
var channels = Stub.Make<IChannelManager>((method, values) => {
    if (method.Name != "GetChannelsInternalAsync") return Stub.Default(method.ReturnType);
    var query = (MediaBrowser.Model.Channels.ChannelQuery)values![0]!;
    providerCalls.Add(new { query.IsRecordingsFolder, query.RefreshLatestChannelItems, UserId = query.UserId.ToString("N") });
    return Task.FromResult(new QueryResult<Channel>());
});
Set(manager, "_channelManager", channels);
var observedFields = new List<string[]>();
var dto = Stub.Make<IDtoService>((method, values) => {
    if (method.Name != "GetBaseItemDtos") return Stub.Default(method.ReturnType);
    var options = (DtoOptions)values![1]!;
    observedFields.Add(options.Fields.Select(value => value.ToString()).ToArray());
    return ((IReadOnlyList<BaseItem>)values[0]!).Where(item => item.IsVisible(user)).Select(item => new BaseItemDto {
        Id = item.Id, Name = item.Name, Type = item.GetBaseItemKind(),
        Tags = options.ContainsField(ItemFields.Tags) ? item.Tags : null,
        CanDelete = options.ContainsField(ItemFields.CanDelete) ? true : null,
        CanDownload = options.ContainsField(ItemFields.CanDownload) ? true : null,
        DisplayPreferencesId = options.ContainsField(ItemFields.DisplayPreferencesId) ? "controlled" : null,
        Etag = options.ContainsField(ItemFields.Etag) ? "controlled" : null
    }).ToArray();
});
Set(manager, "_dtoService", dto);
var results = new List<object>();
foreach (var sample in input.GetProperty("requests").EnumerateArray()) {
    var query = sample.GetProperty("query").Deserialize<RecordingQuery>(JsonDefaults.Options)!;
    query.UserId = sample.TryGetProperty("userless", out var noUser) && noUser.GetBoolean() ? Guid.Empty : user.Id;
    var options = new DtoOptions(false) { Fields = query.Fields ?? [] };
    var value = await manager.GetRecordingsAsync(query, options);
    results.Add(new { name = sample.GetProperty("name").GetString(), value, fields = options.Fields.Select(field => field.ToString()).ToArray() });
}
// The original live Children array deliberately retains its explicitly assigned
// SortName cache. Keep that consumer, then independently read a new root and its
// children through the real repository instead of reusing those warm instances.
object[] FolderSortNames(IEnumerable<BaseItem> values) => values.Select(item => (object)new {
    id = item.Id.ToString("N"), storedSortName = entities.Single(row => row.Id == item.Id).SortName,
    liveSortName = item.SortName
}).ToArray();
var warmFolders = await manager.GetRecordingFoldersAsync(user);
var warmFolderSortNames = FolderSortNames(warmFolders);
Set(library, "_cache", new FastConcurrentLru<Guid, BaseItem>(256));
var coldUserRoot = (UserRootFolder)library.GetItemById(userRoot.Id)!;
if (ReferenceEquals(coldUserRoot, userRoot)) throw new InvalidOperationException("The cold root reused the controlled warm instance.");
Set(library, "_userRootFolder", coldUserRoot);
// Children is intentionally left unassigned: UserRootFolder.LoadChildren calls
// Folder.GetCachedChildren and the actual SQLite repository hydrates each row.
var coldChildren = coldUserRoot.Children.ToArray();
if (coldChildren.Any(child => items.Any(warm => ReferenceEquals(child, warm))))
    throw new InvalidOperationException("Cold root children reused controlled warm instances.");
var coldFolders = await manager.GetRecordingFoldersAsync(user);
var coldFolderSortNames = FolderSortNames(coldFolders);
string? userlessFoldersError = null;
var statusMethod = typeof(ExceptionMiddleware).GetMethod("GetStatusCode", BindingFlags.Static | BindingFlags.NonPublic)!;
int Status(Exception error) => (int)statusMethod.Invoke(null, [error])!;
int? userlessFoldersStatus = null;
try { await manager.GetRecordingFoldersAsync(null!); }
catch (Exception error) { userlessFoldersError = error.GetType().Name; userlessFoldersStatus = Status(error); }
var folderFailures = new List<object>();
var originalOptions = liveOptions;
var targetId = Guid.Parse(input.GetProperty("folderFailureTargetId").GetString()!);
BaseItemEntity originalSource;
using (var database = factory.CreateDbContext()) originalSource = database.BaseItems.AsNoTracking().Single(row => row.Id == targetId);
try {
    foreach (var sample in input.GetProperty("folderFailureCases").EnumerateArray()) {
        var sourcePath = sample.GetProperty("path").ValueKind == JsonValueKind.Null ? null : Map(sample.GetProperty("path").GetString()!);
        if (sample.TryGetProperty("directory", out var directory) && directory.GetBoolean()) Directory.CreateDirectory(sourcePath!);
        liveOptions = JsonSerializer.Deserialize<LiveTvOptions>(JsonSerializer.Serialize(originalOptions, JsonDefaults.Options), JsonDefaults.Options)!;
        liveOptions.RecordingPath = sourcePath; liveOptions.SeriesRecordingPath = null;
        liveOptions.MovieRecordingPath = sample.TryGetProperty("nextPhysical", out var next) && next.GetBoolean() ? Map("{root}/movies") : null;
        BaseItemEntity sourceRow = originalSource;
        if (sample.TryGetProperty("type", out var sourceType)) {
            BaseItem source = sourceType.GetString() switch {
                "Folder" => new Folder(), "UserRootFolder" => new UserRootFolder(), "UserView" => new UserView(),
                "Channel" => new Channel(), "CollectionFolder" => new CollectionFolder(), "BoxSet" => new BoxSet(), "Playlist" => new Playlist(),
                _ => throw new InvalidOperationException("Unknown nullable recording source.")
            };
            source.Id = targetId; source.Name = "Nullable source"; source.Path = sourcePath; source.ParentId = originalSource.ParentId.GetValueOrDefault();
            if (source is CollectionFolder collection) collection.PhysicalLocationsList = [sourcePath!];
            if (source is Playlist playlist && sample.TryGetProperty("openAccess", out var open)) playlist.OpenAccess = open.GetBoolean();
            sourceRow = BaseItemMapper.Map(source, appHost);
        }
        using (var database = factory.CreateDbContext()) {
            var stored = database.BaseItems.Single(row => row.Id == targetId); database.Entry(stored).CurrentValues.SetValues(sourceRow); database.SaveChanges();
        }
        disabledOptions.Clear();
        var disabled = sample.TryGetProperty("disabled", out var disabledInput) && disabledInput.GetBoolean();
        if (disabled) disabledOptions.Add((string)typeof(CollectionFolder).GetMethod("GetLibraryOptionsPath", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, [sourcePath])!);
        Set(library, "_cache", new FastConcurrentLru<Guid, BaseItem>(256));
        object? failure = null;
        try { await manager.GetRecordingFoldersAsync(null!); }
        catch (Exception error) { failure = new { type = error.GetType().Name, status = Status(error), error.Message, error.StackTrace }; }
        folderFailures.Add(new { name = sample.GetProperty("name").GetString(), configuration = liveOptions, sourceRow,
            disabled, failure, actualManagerAndTypedRepository = true, actualExceptionMiddlewareStatus = true });
    }
} finally {
    liveOptions = originalOptions; disabledOptions.Clear();
    using var database = factory.CreateDbContext(); var stored = database.BaseItems.Single(row => row.Id == targetId);
    database.Entry(stored).CurrentValues.SetValues(originalSource); database.SaveChanges();
    Set(library, "_cache", new FastConcurrentLru<Guid, BaseItem>(256));
}
// BaseItem's display getter resolves ChannelId before testing an empty provider
// inventory. Nonempty missing/wrong-type identities do not evaluate a predicate.
var displayManager = (ChannelManager)RuntimeHelpers.GetUninitializedObject(typeof(ChannelManager));
Set(displayManager, "_libraryManager", library); Set(displayManager, "<Channels>k__BackingField", Array.Empty<IChannel>());
BaseItem.ChannelManager = displayManager;
var displayCases = new List<object>();
foreach (var (name, item) in new (string, BaseItem)[] {
    ("channel empty id", new Channel()), ("channel missing id", new Channel { ChannelId = Guid.NewGuid() }),
    ("channel wrong-type id with empty provider inventory", new Channel { ChannelId = targetId }),
    ("ordinary folder empty id", new Folder()), ("plugin item empty id is ordinary library source", new Video()),
    ("plugin item missing id", new Video { ChannelId = Guid.NewGuid() })
}) {
    object? failure = null; bool? value = null;
    try { value = item.EnableMediaSourceDisplay; }
    catch (Exception error) { failure = new { type = error.GetType().Name, status = Status(error), error.Message, error.StackTrace }; }
    displayCases.Add(new { name, nativeType = item.GetType().FullName, channelId = item.ChannelId.ToString("N"), sourceType = item.SourceType.ToString(), value, failure });
}
var deleteCases = new List<object>();
var deleteDtoService = new DtoService(NullLogger<DtoService>.Instance, library, null!, null!, null!, Video.RecordingsManager,
    appHost, null!, null!, null!, null!);
object ObserveDeleteDto(BaseItem item, User? viewer) {
    try {
        var projected = deleteDtoService.GetBaseItemDto(item, new DtoOptions(false) {
            Fields = [ItemFields.CanDelete], EnableImages = false, EnableUserData = false
        }, viewer);
        return new { value = new { projected.CanDelete } };
    } catch (Exception error) {
        return new { failure = new { type = error.GetType().Name, status = Status(error), error.Message, error.StackTrace } };
    }
}
foreach (var (name, item) in new (string, BaseItem)[] {
    ("missing channel file item", new Video { ChannelId = Guid.NewGuid(), Path = Map("{root}/channel-file.mkv") }),
    ("missing channel remote item", new Video { ChannelId = Guid.NewGuid(), Path = "http://controlled.invalid/channel" }),
    ("missing channel pathless item", new Video { ChannelId = Guid.NewGuid() }),
    ("wrong-type channel referent", new Folder { ChannelId = targetId, Path = Map("{root}/channel-folder") }),
    ("channel overrides provider deletion", new Channel { Path = Map("{root}/channel") })
}) {
    deleteCases.Add(new { name, id = item.Id.ToString("N"), nativeType = item.GetType().FullName, channelId = item.ChannelId.ToString("N"),
        sourceType = item.SourceType.ToString(), path = item.Path, value = item.CanDelete(),
        dto = new[] { new { userless = true, result = ObserveDeleteDto(item, null) }, new { userless = false, result = ObserveDeleteDto(item, user) } } });
}
var assemblies = new[] { typeof(LiveTvManager).Assembly, typeof(LibraryManager).Assembly, typeof(BaseItemRepository).Assembly,
    typeof(BaseItem).Assembly, typeof(ExceptionMiddleware).Assembly }
    .Distinct().Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
if (DatabaseSchemaAndHistory() != schemaAndHistory) throw new InvalidOperationException("Controlled EF writes changed the pinned schema or migration history.");
if (Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(sourceDatabaseFilename))) != sourceDatabaseSha256)
    throw new InvalidOperationException("The supplied stopped database changed.");
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualLiveTvManager = true, actualRecordingDirectoryEnumeration = true,
    actualLibraryManagerAndEfRepository = true, controlledDtoProjection = true, emptyChannelProviderControl = true,
    recordingExecutorsStarted = false, actualDeleteDtoService = true, inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), databaseFilename = factory.Filename,
    configuration = liveOptions, warmFolderIds = warmFolders.Select(item => item.Id.ToString("N")), warmFolderSortNames,
    coldFolderIds = coldFolders.Select(item => item.Id.ToString("N")), coldFolderSortNames,
    actualColdUserRootChildRepositoryHydration = true, coldChildIds = coldChildren.Select(item => item.Id.ToString("N")), providerCalls,
    userlessFoldersError, userlessFoldersStatus, folderFailures, displayCases, deleteCases, results, observedFields, assemblies, channelContract,
    databasePreparation = new { sourceFilename = sourceDatabaseFilename, sourceSha256 = sourceDatabaseSha256,
        copiedSha256 = copiedDatabaseSha256, copiedBeforeEf = true, controlledLibraryGraphReset = resetRows,
        schemaAndMigrationHistory = JsonDocument.Parse(schemaAndHistory).RootElement,
        schemaAndMigrationHistorySha256 = Convert.ToHexStringLower(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(schemaAndHistory))),
        retainedSchemaAndMigrationHistory = true, schemaCreated = false, migrationsApplied = false },
    nativeLibraries = new[] { new { filename = sqliteNativeFilename, runtimeIdentifier = RuntimeInformation.RuntimeIdentifier,
        bytes = sqliteNativeBytes.Length, sha256 = Convert.ToHexStringLower(SHA256.HashData(sqliteNativeBytes)), requiredPackagedImage = true } } }, JsonDefaults.Options));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class CaptureLogger : ILogger {
    public int Errors { get; private set; }
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) {
        if (level >= LogLevel.Error) Errors++;
    }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public string Filename => filename;
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False;Foreign Keys=True").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
