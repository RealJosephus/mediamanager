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
        "get_GenrePath" => Path.Combine(metadataPath, "Genre"), "get_MusicGenrePath" => Path.Combine(metadataPath, "MusicGenre"), _ => Stub.Default(method.ReturnType) });
    var settings = new ServerConfiguration { CacheSize = 128, EnableCaseSensitiveItemIds = true, MetadataCountryCode = "US" };
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => settings, "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths, "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType) });
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name switch {
        "ExpandVirtualPath" or "ReverseVirtualPath" => values![0], "get_SystemId" => "channel-items", _ => Stub.Default(method.ReturnType) });
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []); var directoryService = new DirectoryService(fileSystem);
    var localization = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance); await localization.LoadAll();
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance; BaseItem.FileSystem = fileSystem; BaseItem.LocalizationManager = localization;
    BaseItem.MediaSegmentManager = Stub.Make<IMediaSegmentManager>((method, _) => method.Name == "IsTypeSupported" ? false : throw new InvalidOperationException("Media segments cannot execute."));
    var recordings = Stub.Make<IRecordingsManager>((method, _) => method.Name == "GetActiveRecordingInfo" ? null : throw new InvalidOperationException("Recording cannot execute.")); Video.RecordingsManager = recordings;
    var user = new User("channel-items", "controlled", "controlled") { Id = Guid.Parse(input.GetProperty("userId").GetString()!), HidePlayedInLatest = false };
    user.SetPermission(PermissionKind.EnableAllFolders, true); user.SetPermission(PermissionKind.EnableAllChannels, true);
    var playedIds = new HashSet<Guid>();
    UserItemData ReadUserData(BaseItem item) => new() { Key = item.GetUserDataKeys()[0], Played = playedIds.Contains(item.Id), PlayCount = playedIds.Contains(item.Id) ? 1 : 0 };
    var users = Stub.Make<IUserManager>((method, _) => method.Name == "GetUserById" ? user : Stub.Default(method.ReturnType));
    var userData = Stub.Make<IUserDataManager>((method, values) => method.Name switch {
        "GetUserDataBatch" => ((IReadOnlyList<BaseItem>)values![0]!).ToDictionary(item => item.Id, ReadUserData),
        "GetResumeUserDataBatch" => new Dictionary<Guid, VersionResumeData>(), "GetUserData" => ReadUserData((BaseItem)values![1]!),
        _ => throw new InvalidOperationException("User data writes cannot execute.") });
    var factory = new SqlFactory(Path.Combine(owned, "native.db")); using (var initial = factory.CreateDbContext()) { initial.Database.EnsureCreated(); initial.Users.Add(user); initial.SaveChanges(); }
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
    var inventory = declarations.Select(value => ControlledProvider.Make(value, calls)).ToArray();
    Guid ChannelId(string name) => manager.GetNewItemId("Channel " + name, typeof(Channel));
    foreach (var provider in inventory) {
        var id = ChannelId(provider.Name); var directory = Channel.GetInternalMetadataPath(metadataPath, id); Directory.CreateDirectory(directory);
        manager.CreateItem(new Channel { Id = id, Name = provider.Name, ChannelId = id, Path = directory, DateCreated = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc) }, null);
    }
    var orphan = sample.TryGetProperty("orphan", out var orphanFlag) && orphanFlag.GetBoolean();
    if (orphan) {
        var id = ChannelId("Absent"); var directory = Channel.GetInternalMetadataPath(metadataPath, id); Directory.CreateDirectory(directory);
        var channel = new Channel { Id = id, Name = "Absent", ChannelId = id, Path = directory, DateCreated = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc) };
        manager.CreateItem(channel, null);
        manager.CreateItem(new Movie { Id = Guid.Parse("ce200000000000000000000000000044"), Name = "Retained absent-provider movie",
            ChannelId = id, ParentId = id, PresentationUniqueKey = "retained-absent-provider", DateCreated = new DateTime(2026, 10, 2, 0, 0, 0, DateTimeKind.Utc) }, channel);
    }
    using var cache = new MemoryCache(new MemoryCacheOptions());
    using var channels = new ChannelManager(users, dto, library, NullLogger<ChannelManager>.Instance, config, fileSystem, userData, providers, cache, inventory); BaseItem.ChannelManager = channels;
    var views = new UserViewManager(library, localization, channels, null!, config);
    var controller = new UserLibraryController(users, userData, library, dto, views, fileSystem, providers) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
        User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, UserRoles.Administrator)], "component")) } } };
    object[] beforeRows;
    using (var db = factory.CreateDbContext()) {
        var connection = db.Database.GetDbConnection(); await connection.OpenAsync();
        using var command = connection.CreateCommand(); command.CommandText = "SELECT * FROM BaseItems";
        using var reader = await command.ExecuteReaderAsync(); var rawRows = new List<object>();
        while (await reader.ReadAsync()) rawRows.Add(Enumerable.Range(0, reader.FieldCount)
            .ToDictionary(reader.GetName, index => reader.IsDBNull(index) ? null : reader.GetValue(index)));
        beforeRows = rawRows.ToArray();
    }
    persistenceCalls.Clear(); var steps = new List<object>();
    foreach (var step in sample.GetProperty("steps").EnumerateArray()) {
        var kind = step.GetProperty("kind").GetString(); object action;
        try {
            if (kind == "policy") {
                if (step.TryGetProperty("hidePlayed", out var hide)) user.HidePlayedInLatest = hide.GetBoolean();
                if (step.TryGetProperty("blockedTags", out var blocked)) user.SetPreference(PreferenceKind.BlockedTags, blocked.EnumerateArray().Select(value => value.GetString()!).ToArray());
                if (step.TryGetProperty("allowedTags", out var allowed)) user.SetPreference(PreferenceKind.AllowedTags, allowed.EnumerateArray().Select(value => value.GetString()!).ToArray());
                if (step.TryGetProperty("enableAllChannels", out var enabled)) user.SetPermission(PermissionKind.EnableAllChannels, enabled.GetBoolean());
                action = new { value = true };
            } else if (kind == "played") {
                using var seedData = factory.CreateDbContext();
                foreach (var externalId in step.GetProperty("externalIds").EnumerateArray()) {
                    var raw = seedData.BaseItems.AsNoTracking().Single(value => value.ExternalId == externalId.GetString());
                    var item = manager.GetItemById(raw.Id)!; playedIds.Add(item.Id);
                    foreach (var key in item.GetUserDataKeys()) seedData.UserData.Add(new UserData { UserId = user.Id, ItemId = item.Id,
                        CustomDataKey = key, Played = true, PlayCount = 1, PlaybackPositionTicks = 0 });
                }
                seedData.SaveChanges(); action = new { value = true };
            } else {
                var selectedFields = step.TryGetProperty("fields", out var stepFields) ? stepFields.EnumerateArray().Select(value => Enum.Parse<ItemFields>(value.GetString()!)).ToArray() : fields;
                var query = new InternalItemsQuery(user) { DtoOptions = new DtoOptions { Fields = selectedFields },
                    ChannelIds = [ChannelId(step.GetProperty("provider").GetString()!)] };
                var groupItems = true;
                if (step.TryGetProperty("query", out var values)) {
                    if (values.TryGetProperty("Limit", out var limit)) query.Limit = limit.GetInt32();
                    if (values.TryGetProperty("IsPlayed", out var played)) query.IsPlayed = played.GetBoolean();
                    if (values.TryGetProperty("GroupItems", out var grouped)) groupItems = grouped.GetBoolean();
                    if (values.TryGetProperty("IncludeItemTypes", out var types)) query.IncludeItemTypes = types.EnumerateArray().Select(value => Enum.Parse<BaseItemKind>(value.GetString()!)).ToArray();
                }
                if (kind == "parent-latest") {
                    var actionResult = controller.GetLatestMedia(user.Id, query.ChannelIds[0], selectedFields, query.IncludeItemTypes,
                        query.IsPlayed, null, null, [], null, query.Limit ?? 20, groupItems);
                    var result = (IEnumerable<BaseItemDto>)((OkObjectResult)actionResult.Result!).Value!;
                    action = new { value = result.Select(Project).ToArray() };
                } else {
                    var result = kind == "channel-latest-types" ? await channels.GetLatestChannelItems(query, CancellationToken.None)
                        : await channels.GetChannelItems(query, CancellationToken.None);
                    action = new { value = new { Items = result.Items.Select(Project).ToArray(), result.TotalRecordCount, result.StartIndex } };
                }
            }
        } catch (Exception error) { action = new { failure = Failure(error) }; }
        using var state = factory.CreateDbContext(); var rows = state.BaseItems.AsNoTracking().ToArray();
        object Item(BaseItem value, string persistedType) => new { Id = value.Id.ToString("N"), value.Name, value.Path, value.ExternalId, value.RunTimeTicks, value.Genres, value.Tags,
            value.Overview, channelId = value.ChannelId.ToString("N"), parentId = value.ParentId.ToString("N"), type = persistedType,
            artists = value is IHasArtist artist ? artist.Artists : null, albumArtists = value is IHasAlbumArtist album ? album.AlbumArtists : null };
        var persisted = rows.Where(row => row.Type != "PLACEHOLDER").OrderBy(row => row.Id)
            .Select(row => Item(BaseItemMapper.DeserializeBaseItem(row, NullLogger.Instance, appHost)!, row.Type)).ToArray();
        var dataRows = state.UserData.AsNoTracking().ToArray().Select(value => new { value.ItemId, value.UserId, value.CustomDataKey,
            value.Played, value.PlayCount, value.PlaybackPositionTicks }).ToArray();
        steps.Add(new { kind, action, persisted, userData = dataRows, calls = calls.ToArray(), queue = queue.ToArray(), persistenceCalls = persistenceCalls.ToArray() });
    }
    results.Add(new { name = sample.GetProperty("name").GetString(), root = owned, metadataPath, cachePath, beforeRows, steps,
        identities = inventory.Select(value => value.Name).Concat(orphan ? ["Absent"] : []).Select(name => new { name, id = ChannelId(name).ToString("N") }) });
}
var assemblies = new[] { typeof(ChannelManager).Assembly, typeof(LibraryManager).Assembly, typeof(UserLibraryController).Assembly, typeof(DtoService).Assembly, typeof(BaseItemRepository).Assembly, typeof(JellyfinDbContext).Assembly }.Distinct()
    .Select(value => new { filename = value.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(value.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), actualChannelManager = true, actualRepositoryAndTypedMapper = true,
    actualEfPersistence = true, actualRawSqliteBeforeRows = true, actualDtoService = true, actualUserViewManager = true,
    actualControllerActions = true, controlledProviderAndMetadataExecution = true, mediaExecutionStarted = false, assemblies,
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
        if (node is JsonObject result && result["Items"] is JsonArray items) foreach (var item in items) if (item is JsonObject info && info["MediaSources"] is JsonArray sources)
            for (var i = 0; i < sources.Count; i++) if (sources[i] is JsonObject source) sources[i] = source["mediaSource"]!.DeepClone();
        return Task.FromResult(node?.Deserialize<ChannelItemResult>(JsonDefaults.Options)!);
    }
    public Task<DynamicImageResponse> GetChannelImage(ImageType type, CancellationToken token) => Task.FromResult<DynamicImageResponse>(null!);
    public IEnumerable<ImageType> GetSupportedChannelImages() => [];
    public static IChannel Make(JsonElement spec, List<object> calls) {
        var latest = spec.TryGetProperty("latest", out var l) && l.GetBoolean(); var probe = spec.TryGetProperty("probe", out var p) && p.GetBoolean();
        if (spec.GetProperty("type").GetString() == "ControlledTrailerProvider") return new ControlledTrailerProvider(spec, calls);
        return latest ? probe ? new LatestProbeProvider(spec, calls) : new LatestProvider(spec, calls) : probe ? new ProbeProvider(spec, calls) : new ControlledProvider(spec, calls);
    }
}
public class LatestProvider(JsonElement spec, List<object> calls) : ControlledProvider(spec, calls), ISupportsLatestMedia {
    public Task<IEnumerable<ChannelItemInfo>> GetLatestMedia(ChannelLatestMediaSearch search, CancellationToken token) => throw new InvalidOperationException("The marker callback must never execute.");
}
public class ControlledTrailerProvider(JsonElement spec, List<object> calls) : LatestProvider(spec, calls) { }
public class LatestProbeProvider(JsonElement spec, List<object> calls) : LatestProvider(spec, calls), ISupportsMediaProbe { }
public class ProbeProvider(JsonElement spec, List<object> calls) : ControlledProvider(spec, calls), ISupportsMediaProbe { }
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
