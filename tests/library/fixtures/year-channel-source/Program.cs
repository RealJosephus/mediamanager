using System.Globalization;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Dto;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Api.Middleware;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv.Channels;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Channels;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
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
using MediaBrowser.Model.Querying;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqliteFile = Path.Combine(AppContext.BaseDirectory, sqliteName); var sqliteHandle = NativeLibrary.Load(sqliteFile);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) => name == "e_sqlite3" ? sqliteHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
var root = Path.GetFullPath(args[2]); Directory.CreateDirectory(root);
var exceptionStatus = typeof(ExceptionMiddleware).GetMethod("GetStatusCode", BindingFlags.Static | BindingFlags.NonPublic)!;
object Failure(Exception error) {
    while (error is TargetInvocationException { InnerException: not null } target) error = target.InnerException;
    return new { type = error.GetType().Name, error.Message, status = (int)exceptionStatus.Invoke(null, [error])!, error.StackTrace };
}
var fields = input.GetProperty("fields").EnumerateArray().Select(value => Enum.Parse<ItemFields>(value.GetString()!)).ToArray();
JsonElement Project(BaseItemDto item) => JsonSerializer.SerializeToElement(item, JsonDefaults.Options);
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var owned = Path.Combine(root, results.Count.ToString(CultureInfo.InvariantCulture)); Directory.CreateDirectory(owned);
    var metadataPath = Path.Combine(owned, "metadata"); var cachePath = Path.Combine(owned, "cache");
    var calls = new List<object>(); var queue = new List<object>(); var persistenceCalls = new List<object>(); LibraryManager? manager = null;
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_ProgramDataPath" => owned, "get_RootFolderPath" => Path.Combine(owned, "root"), "get_DataPath" => Path.Combine(owned, "data"),
        "get_InternalMetadataPath" => metadataPath, "get_CachePath" => cachePath, "get_TrickplayPath" => Path.Combine(owned, "data", "trickplay"),
        "get_GenrePath" => Path.Combine(metadataPath, "Genre"), "get_MusicGenrePath" => Path.Combine(metadataPath, "MusicGenre"),
        "get_YearPath" => Path.Combine(metadataPath, "Year"), _ => Stub.Default(method.ReturnType) });
    var settings = new ServerConfiguration { CacheSize = 128, EnableCaseSensitiveItemIds = true, EnableNormalizedItemByNameIds = true, MetadataCountryCode = "US" };
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => settings, "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths, "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType) });
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name switch {
        "ExpandVirtualPath" or "ReverseVirtualPath" => values![0], "get_SystemId" => "channel-items", _ => Stub.Default(method.ReturnType) });
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []); var directoryService = new DirectoryService(fileSystem);
    var localization = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance); await localization.LoadAll();
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance; BaseItem.FileSystem = fileSystem; BaseItem.LocalizationManager = localization;
    BaseItem.MediaSegmentManager = Stub.Make<IMediaSegmentManager>((method, _) => method.Name == "IsTypeSupported" ? false : throw new InvalidOperationException("Media segments cannot execute."));
    var recordings = Stub.Make<IRecordingsManager>((method, _) => method.Name == "GetActiveRecordingInfo" ? null : throw new InvalidOperationException("Recording cannot execute.")); Video.RecordingsManager = recordings;
    var user = new User("channel-items", "controlled", "controlled") { Id = Guid.Parse(input.GetProperty("userId").GetString()!) };
    user.SetPermission(PermissionKind.EnableAllFolders, true); user.SetPermission(PermissionKind.EnableAllChannels, true);
    var users = Stub.Make<IUserManager>((method, _) => method.Name == "GetUserById" ? user : Stub.Default(method.ReturnType));
    var factory = new SqlFactory(Path.Combine(owned, "native.db")); using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var realUserData = new UserDataManager(config, factory);
    var userData = Stub.Make<IUserDataManager>((method, values) => method.Name switch {
        "GetUserDataBatch" or "GetResumeUserDataBatch" or "GetUserData" or "GetUserDataDto" or "GetResumeUserData"
            => Stub.Forward(realUserData, method, values),
        _ => throw new InvalidOperationException("User data writes cannot execute.") });
    BaseItem.UserDataManager = userData;
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance); BaseItem.ItemRepository = repository;
    var realPersistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var persistence = Stub.Make<IItemPersistenceService>((method, values) => {
        persistenceCalls.Add(new { method = method.Name }); return Stub.Forward(realPersistence, method, values);
    });
    var external = Stub.Make<IExternalDataManager>((method, _) => Stub.Default(method.ReturnType));
    var providers = Stub.Make<IProviderManager>((method, values) => {
        if (method.Name == "RefreshSingleItem") return Task.FromResult(ItemUpdateType.None);
        if (method.Name == "QueueRefresh") { queue.Add(new { id = ((Guid)values![0]!).ToString("N"), priority = values[2]!.ToString() }); return null; }
        if (method.Name == "GetExternalUrls") return Array.Empty<MediaBrowser.Model.Providers.ExternalUrl>();
        return Stub.Default(method.ReturnType);
    }); BaseItem.ProviderManager = providers;
    var library = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions(), _ => Stub.Forward(manager!, method, values) }); BaseItem.LibraryManager = library;
    manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, users, config, null!, new(() => null!), fileSystem,
        new(() => providers), new(() => null!), repository, persistence, null!, null!, new LinkedChildrenService(factory, new ItemTypeLookup(), repository),
        Stub.Make<IImageProcessor>((method, _) => Stub.Default(method.ReturnType)), new Emby.Naming.Common.NamingOptions(), directoryService,
        null!, new PathManager(NullLogger<PathManager>.Instance, config, paths), new DotIgnoreIgnoreRule(), localization, null!, new(() => external));
    var userRoot = new UserRootFolder { Id = Guid.Parse("ce100000000000000000000000000099"), Name = "User root", Children = [] };
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, userRoot);
    using var media = new MediaSourceManager(appHost, null!, paths, localization, users, library, NullLogger<MediaSourceManager>.Instance,
        fileSystem, userData, null!, directoryService, Stub.Make<IMediaStreamRepository>((method, _) => method.Name == "GetMediaStreams" ? Array.Empty<MediaStream>() : Stub.Default(method.ReturnType)),
        Stub.Make<IMediaAttachmentRepository>((method, _) => method.Name == "GetMediaAttachments" ? Array.Empty<MediaAttachment>() : Stub.Default(method.ReturnType)));
    BaseItem.MediaSourceManager = media;
    media.AddParts([]);
    var imageProcessor = Stub.Make<IImageProcessor>((method, _) => Stub.Default(method.ReturnType));
    var dto = new DtoService(NullLogger<DtoService>.Instance, library, userData, imageProcessor, providers, recordings, appHost, media, null!, null!, null!);
    var declarations = sample.GetProperty("providers").EnumerateArray().ToArray();
    var inventory = declarations.Select(value => new ControlledProvider(value, calls)).ToArray();
    Guid ChannelId(string name) => manager.GetNewItemId("Channel " + name, typeof(Channel));
    foreach (var provider in inventory) {
        var id = ChannelId(provider.Name); var directory = Channel.GetInternalMetadataPath(metadataPath, id); Directory.CreateDirectory(directory);
        manager.CreateItem(new Channel { Id = id, Name = provider.Name, ChannelId = id, Path = directory, DateCreated = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc) }, null);
    }
    if (sample.TryGetProperty("orphan", out var orphan) && orphan.GetBoolean()) {
        var id = ChannelId("Absent"); var directory = Channel.GetInternalMetadataPath(metadataPath, id); Directory.CreateDirectory(directory);
        var absent = new Channel { Id = id, Name = "Absent", ChannelId = id, Path = directory,
            DateCreated = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc) };
        manager.CreateItem(absent, null);
        manager.CreateItem(new Movie { Id = Guid.Parse("ce310000000000000000000000000222"), Name = "Retained missing-provider source",
            ProductionYear = 2025, ChannelId = id, ParentId = id }, absent);
    }
    using var cache = new MemoryCache(new MemoryCacheOptions());
    using var channels = new ChannelManager(users, dto, library, NullLogger<ChannelManager>.Instance, config, fileSystem, userData, providers, cache, inventory); BaseItem.ChannelManager = channels;
    Folder.UserViewManager = new UserViewManager(library, localization, channels, null!, config);
    var yearController = new YearsController(library, users, dto) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
        User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, UserRoles.Administrator)], "component")) } } };
    var viewProvider = inventory.Length == 0 ? "Absent" : inventory[0].Name;
    var view = new UserView { Id = Guid.Parse(input.GetProperty("viewId").GetString()!), Name = "Channel Years reader",
        ViewType = CollectionType.unknown, DisplayParentId = ChannelId(viewProvider),
        DateCreated = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc) };
    manager.CreateItem(view, null);
    var tableNames = new[] { "BaseItems", "AncestorIds", "LinkedChildren", "ItemValues", "ItemValuesMap", "UserData",
        "MediaStreamInfos", "Peoples", "PeopleBaseItemMap", "BaseItemImageInfos", "BaseItemProviders", "BaseItemMetadataFields" };
    async Task<Dictionary<string, object[]>> Tables() {
        using var db = factory.CreateDbContext(); var connection = db.Database.GetDbConnection(); await connection.OpenAsync();
        var result = new Dictionary<string, object[]>();
        foreach (var table in tableNames) {
            using var command = connection.CreateCommand(); command.CommandText = "SELECT * FROM \"" + table + "\"";
            using var reader = await command.ExecuteReaderAsync(); var rows = new List<object>();
            while (await reader.ReadAsync()) rows.Add(Enumerable.Range(0, reader.FieldCount)
                .ToDictionary(reader.GetName, index => reader.IsDBNull(index) ? null : reader.GetValue(index)));
            result[table] = rows.ToArray();
        }
        return result;
    }
    object[] beforeRows;
    using (var db = factory.CreateDbContext()) {
        var connection = db.Database.GetDbConnection(); await connection.OpenAsync();
        using var command = connection.CreateCommand(); command.CommandText = "SELECT * FROM BaseItems";
        using var reader = await command.ExecuteReaderAsync(); var rawRows = new List<object>();
        while (await reader.ReadAsync()) rawRows.Add(Enumerable.Range(0, reader.FieldCount)
            .ToDictionary(reader.GetName, index => reader.IsDBNull(index) ? null : reader.GetValue(index)));
        beforeRows = rawRows.ToArray();
    }
    var beforeTables = await Tables();
    persistenceCalls.Clear(); var steps = new List<object>();
    foreach (var step in sample.GetProperty("steps").EnumerateArray()) {
        var kind = step.GetProperty("kind").GetString(); object action;
        try {
            if (kind == "expire") {
                foreach (var file in Directory.Exists(cachePath) ? Directory.EnumerateFiles(cachePath, "*", SearchOption.AllDirectories) : []) File.SetLastWriteTimeUtc(file, DateTime.UnixEpoch);
                action = new { value = true };
            } else if (kind == "cache") {
                var provider = inventory.Single(value => value.Name == step.GetProperty("provider").GetString());
                var method = typeof(ChannelManager).GetMethod("GetChannelDataCachePath", BindingFlags.Instance | BindingFlags.NonPublic)!;
                var file = (string)method.Invoke(channels, [provider, null, null, null, false])!; Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                File.WriteAllText(file, step.GetProperty("content").GetString()); action = new { value = true };
            } else if (kind == "years") {
                var query = step.GetProperty("query");
                var providerName = step.GetProperty("provider").GetString()!;
                BaseItem parent = manager.GetItemById(ChannelId(providerName))!;
                if (step.TryGetProperty("parentExternalId", out var parentExternal)) {
                    using var db = factory.CreateDbContext();
                    var id = db.BaseItems.AsNoTracking().Single(row => row.ExternalId == parentExternal.GetString()).Id;
                    parent = manager.GetItemById(id)!;
                }
                // This live relationship is an explicit metadata consumer
                // input. It is deliberately unsaved; the actual UserView
                // action must resolve its current Guid through the manager.
                ((UserView)manager.GetItemById(view.Id)!).DisplayParentId = parent.Id;
                if (step.TryGetProperty("warmExternalId", out var warmExternal)) {
                    using var db = factory.CreateDbContext();
                    var id = db.BaseItems.AsNoTracking().Single(row => row.ExternalId == warmExternal.GetString()).Id;
                    manager.GetItemById(id)!.ProductionYear = step.GetProperty("warmProductionYear").GetInt32();
                }
                T[] Enums<T>(string name) where T : struct, Enum => query.TryGetProperty(name, out var values)
                    ? values.EnumerateArray().Select(value => Enum.Parse<T>(value.GetString()!)).ToArray() : [];
                var selectedUser = step.GetProperty("user").GetBoolean() ? user.Id : (Guid?)null;
                var result = yearController.GetYears(query.TryGetProperty("StartIndex", out var start) ? start.GetInt32() : null,
                    query.TryGetProperty("Limit", out var limit) ? limit.GetInt32() : null, [], view.Id, fields,
                    Enums<BaseItemKind>("ExcludeItemTypes"), Enums<BaseItemKind>("IncludeItemTypes"), Enums<MediaType>("MediaTypes"), [],
                    true, null, [], selectedUser, !query.TryGetProperty("Recursive", out var recursive) || recursive.GetBoolean(), false).Value!;
                action = new { value = new { Items = result.Items.Select(Project).ToArray(), result.TotalRecordCount, result.StartIndex } };
            } else throw new InvalidOperationException("Unknown source step.");
        } catch (Exception error) { action = new { failure = Failure(error) }; }
        using var state = factory.CreateDbContext(); var rows = state.BaseItems.AsNoTracking().ToArray();
        object Item(BaseItem value) => new { Id = value.Id.ToString("N"), value.Name, value.Path, value.ExternalId, value.ProductionYear, value.RunTimeTicks, value.Genres, value.Tags,
            value.Overview, channelId = value.ChannelId.ToString("N"), parentId = value.ParentId.ToString("N"), type = value.GetType().FullName,
            displayParentId = value is UserView userView ? userView.DisplayParentId.ToString("N") : null,
            artists = value is IHasArtist artist ? artist.Artists : null, albumArtists = value is IHasAlbumArtist album ? album.AlbumArtists : null };
        var persisted = rows.Where(row => row.Type != "PLACEHOLDER").Select(row => BaseItemMapper.DeserializeBaseItem(row, NullLogger.Instance, appHost)!).OrderBy(item => item.Id).Select(Item).ToArray();
        var warm = rows.Where(row => row.Type != "PLACEHOLDER").Select(row => manager.GetItemById(row.Id)!).OrderBy(item => item.Id).Select(Item).ToArray();
        object[] Files(string directory) => Directory.Exists(directory) ? Directory.EnumerateFiles(directory, "*.json", SearchOption.AllDirectories).Order(StringComparer.Ordinal)
            .Select(file => (object)new { path = Path.GetRelativePath(owned, file).Replace('\\', '/'), text = File.ReadAllText(file) }).ToArray() : [];
        var directories = rows.Where(row => row.Type == typeof(Year).FullName).Select(row => {
            var info = new DirectoryInfo(row.Path!); return new { id = row.Id.ToString("N"),
                createdTicks = info.CreationTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture),
                modifiedTicks = info.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture) };
        }).ToArray();
        steps.Add(new { name = step.GetProperty("name").GetString(), kind, action, persisted, warm, tables = await Tables(), directories,
            cacheFiles = Files(cachePath), mediaFiles = Files(metadataPath), calls = calls.ToArray(), queue = queue.ToArray(), persistenceCalls = persistenceCalls.ToArray() });
    }
    results.Add(new { name = sample.GetProperty("name").GetString(), root = owned, metadataPath, cachePath, beforeRows, beforeTables, steps,
        identities = inventory.Select(value => new { name = value.Name, id = ChannelId(value.Name).ToString("N") }) });
}
var assemblies = new[] { typeof(ChannelManager).Assembly, typeof(LibraryManager).Assembly, typeof(DtoService).Assembly, typeof(BaseItemRepository).Assembly, typeof(JellyfinDbContext).Assembly, typeof(YearsController).Assembly, typeof(UserView).Assembly }.Distinct()
    .Select(value => new { filename = value.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(value.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), actualChannelManager = true, actualRepositoryAndTypedMapper = true,
    actualEfPersistence = true, actualRawSqliteBeforeRows = true, actualDtoService = true, actualControllerActions = true, controlledProviderAndMetadataExecution = true, mediaExecutionStarted = false, assemblies,
    sqliteNative = new { filename = sqliteFile, runtimeIdentifier = RuntimeInformation.RuntimeIdentifier, explicitResolver = true, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(sqliteFile))) }, results },
    new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never }));

public class ControlledProvider(JsonElement spec, List<object> calls) : IChannel, IHasCacheKey {
    readonly Dictionary<string, int> offsets = new();
    public string Name => spec.GetProperty("name").GetString()!; public string Description => "Controlled original catalog"; public string DataVersion => spec.GetProperty("dataVersion").GetString()!;
    public string HomePageUrl => null!; public ChannelParentalRating ParentalRating => ChannelParentalRating.GeneralAudience;
    public InternalChannelFeatures GetChannelFeatures() => new(); public bool IsEnabledFor(string userId) => true;
    public string? GetCacheKey(string? userId) { calls.Add(new { kind = "key", name = Name, userId }); return spec.GetProperty("cacheKey").GetString(); }
    public Task<ChannelItemResult> GetChannelItems(InternalChannelItemQuery query, CancellationToken token) {
        calls.Add(new { kind = "items", name = Name, UserId = query.UserId.ToString("N"), query.FolderId, SortBy = query.SortBy?.ToString(), query.SortDescending, query.StartIndex, query.Limit, canBeCanceled = token.CanBeCanceled });
        var key = query.FolderId ?? "root"; var values = spec.GetProperty("responses").GetProperty(key); var index = offsets.GetValueOrDefault(key); offsets[key] = index + 1;
        var node = JsonNode.Parse(values[Math.Min(index, values.GetArrayLength() - 1)].GetRawText());
        return Task.FromResult(node?.Deserialize<ChannelItemResult>(JsonDefaults.Options)!);
    }
    public Task<DynamicImageResponse> GetChannelImage(ImageType type, CancellationToken token) => Task.FromResult<DynamicImageResponse>(null!);
    public IEnumerable<ImageType> GetSupportedChannelImages() => [];
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
