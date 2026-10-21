using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using BitFaster.Caching.Lru;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Extensions.Json;
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
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.LiveTv;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

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
var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
    "get_CommonApplicationPaths" or "get_ApplicationPaths" => paths,
    "get_Configuration" => new ServerConfiguration { CacheSize = 256 },
    "GetConfiguration" => liveOptions,
    _ => Stub.Default(method.ReturnType)
});
BaseItem.ConfigurationManager = configuration;
BaseItem.Logger = NullLogger<BaseItem>.Instance;
BaseItem.LocalizationManager = Stub.Make<ILocalizationManager>((method, _) => Stub.Default(method.ReturnType));
BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
CollectionFolder.XmlSerializer = Stub.Make<IXmlSerializer>((method, _) => method.Name == "DeserializeFromFile"
    ? new LibraryOptions() : Stub.Default(method.ReturnType));
var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath"
    ? values![0] : Stub.Default(method.ReturnType));
CollectionFolder.ApplicationHost = appHost;
var factory = new SqlFactory(Path.Combine(root, "native.db"));
using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration, NullLogger<BaseItemRepository>.Instance);
BaseItem.ItemRepository = repository;
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
var folders = await manager.GetRecordingFoldersAsync(user);
string? userlessFoldersError = null;
try { await manager.GetRecordingFoldersAsync(null!); } catch (Exception error) { userlessFoldersError = error.GetType().Name; }
var assemblies = new[] { typeof(LiveTvManager).Assembly, typeof(LibraryManager).Assembly, typeof(BaseItemRepository).Assembly, typeof(BaseItem).Assembly }
    .Distinct().Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualLiveTvManager = true, actualRecordingDirectoryEnumeration = true,
    actualLibraryManagerAndEfRepository = true, controlledDtoProjection = true, emptyChannelProviderControl = true,
    recordingExecutorsStarted = false, inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), databaseFilename = factory.Filename,
    configuration = liveOptions, folderIds = folders.Select(item => item.Id.ToString("N")), providerCalls,
    userlessFoldersError, results, observedFields, assemblies,
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
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public string Filename => filename;
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
