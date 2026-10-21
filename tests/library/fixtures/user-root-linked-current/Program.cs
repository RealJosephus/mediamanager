using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using BitFaster.Caching.Lru;
using Emby.Server.Implementations.Collections;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Dto;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Sorting;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Extensions.Json;
using Jellyfin.Server.Extensions;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Common;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Sorting;
using MediaBrowser.Model.Activity;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.Library;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using DbLinkType = Jellyfin.Database.Implementations.Entities.LinkedChildType;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo("en-US");
var nativeName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var nativeFilename = Path.Combine(AppContext.BaseDirectory, nativeName);
var nativeHandle = NativeLibrary.Load(nativeFilename);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) => name == "e_sqlite3" ? nativeHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var inputBytes = File.ReadAllBytes(args[0]); using var document = JsonDocument.Parse(inputBytes); var input = document.RootElement;
var output = Path.GetFullPath(args[1]); var privateRoot = Path.GetFullPath(args[2]); Directory.CreateDirectory(privateRoot);
var databaseFilename = Path.Combine(privateRoot, "native.db"); var sourceFilename = Path.GetFullPath(args[3]);
var sourceHash = Evidence.Hash(sourceFilename); File.Copy(sourceFilename, databaseFilename, false);
if (Evidence.Hash(databaseFilename) != sourceHash) throw new InvalidOperationException("The private stopped database clone must match.");
var schemaBefore = Evidence.Schema(databaseFilename); Evidence.Clear(databaseFilename);
if (Evidence.Schema(databaseFilename) != schemaBefore) throw new InvalidOperationException("Data setup changed the actual migrated schema/history.");
var factory = new SqlFactory(databaseFilename);
var root = input.GetProperty("root").GetString()!;
string Map(string value) => value.Replace("{root}", root, StringComparison.Ordinal).Replace('/', Path.DirectorySeparatorChar);
var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
    "get_ProgramDataPath" => root, "get_DataPath" => Path.Combine(root, "data"), "get_InternalMetadataPath" => Path.Combine(root, "metadata"),
    "get_GenrePath" => Path.Combine(root, "metadata", "Genre"), "get_MusicGenrePath" => Path.Combine(root, "metadata", "MusicGenre"),
    "get_RootFolderPath" => Path.Combine(root, "root"), "get_DefaultUserViewsPath" => Path.Combine(root, "root", "default"),
    _ => Stub.Default(method.ReturnType)
});
var settings = new ServerConfiguration { CacheSize = 1024, EnableCaseSensitiveItemIds = true, MetadataCountryCode = "US", UICulture = "en-US" };
var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
    "get_Configuration" => settings, "get_CommonConfiguration" => settings, "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths,
    "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType)
});
var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name switch {
    "get_SystemId" => input.GetProperty("serverId").GetString(), "ExpandVirtualPath" or "ReverseVirtualPath" => values![0], _ => Stub.Default(method.ReturnType)
});
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
var localization = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
await localization.LoadAll();
var gRating = localization.GetRatingScore("G", "US"); var rRating = localization.GetRatingScore("R", "US");
if (gRating is null || rRating is null || gRating.Score > 5 || rRating.Score <= 5)
    throw new InvalidOperationException("The actual loaded US parental ratings must distinguish the controlled max score 5.");
var ratingResources = new[] {
    ("Emby.Server.Implementations.Localization.Ratings.us.json", "Emby.Server.Implementations/Localization/Ratings/us.json"),
    ("Emby.Server.Implementations.Localization.iso6392.txt", "Emby.Server.Implementations/Localization/iso6392.txt")
}.Select(resource => {
    using var stream = typeof(LocalizationManager).Assembly.GetManifestResourceStream(resource.Item1)
        ?? throw new InvalidOperationException("The real localization resource must exist: " + resource.Item1);
    return new { name = resource.Item1, sourcePath = resource.Item2, bytes = stream.Length,
        sha256 = Convert.ToHexStringLower(SHA256.HashData(stream)) };
}).ToArray();
BaseItem.ConfigurationManager = configuration; BaseItem.LocalizationManager = localization; BaseItem.FileSystem = fileSystem; BaseItem.Logger = NullLogger<BaseItem>.Instance;
CollectionFolder.XmlSerializer = new MyXmlSerializer(); CollectionFolder.ApplicationHost = appHost;
var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration, NullLogger<BaseItemRepository>.Instance);
var links = new LinkedChildrenService(factory, new ItemTypeLookup(), repository);
var counts = new ItemCountService(factory, new ItemTypeLookup(), repository);
var userData = new UserDataManager(configuration, factory);
BaseItem.ItemRepository = repository; BaseItem.ItemCountService = counts; BaseItem.UserDataManager = userData;
void Set(object target, string field, object value) => target.GetType().GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
var protocolParser = (MediaSourceManager)RuntimeHelpers.GetUninitializedObject(typeof(MediaSourceManager));
Set(protocolParser, "_fileSystem", fileSystem);
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, values) => method.Name == nameof(IMediaSourceManager.GetPathProtocol)
    ? protocolParser.GetPathProtocol((string)values![0]!) : throw new InvalidOperationException("Media execution is forbidden: " + method.Name));
var library = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
foreach (var pair in new (string, object)[] { ("_cache", new FastConcurrentLru<Guid, BaseItem>(1024)), ("_configurationManager", configuration),
    ("_itemRepository", repository), ("_appHost", appHost), ("_fileSystem", fileSystem), ("_logger", NullLogger<LibraryManager>.Instance),
    ("_linkedChildrenService", links), ("_countService", counts), ("_userDataManager", userData), ("_localization", localization),
    ("_peopleRepository", new PeopleRepository(factory, new ItemTypeLookup(), repository)) }) Set(library, pair.Item1, pair.Item2);
BaseItem.LibraryManager = library;
var rootIds = new Dictionary<string, Guid> {
    ["aggregate"] = library.GetNewItemId(Path.Combine(root, "root"), typeof(AggregateFolder)),
    ["user-root"] = library.GetNewItemId(Path.Combine(root, "root", "default"), typeof(UserRootFolder)),
    ["playlists"] = library.GetNewItemId(Path.Combine(root, "data", "playlists"), typeof(Emby.Server.Implementations.Playlists.PlaylistsFolder))
};
Guid Id(string value) => rootIds.GetValueOrDefault(value, Guid.TryParse(value, out var parsed) ? parsed : Guid.Empty);
var entities = new List<BaseItemEntity>();
void Add(BaseItem item) {
    item.DateCreated = new DateTime(2026, 10, 1, 1, 2, 3, DateTimeKind.Utc); item.DateModified = item.DateCreated;
    item.PresentationUniqueKey = item.Id.ToString("N"); entities.Add(BaseItemMapper.Map(item, appHost));
}
Add(new AggregateFolder { Id = rootIds["aggregate"], Name = "Aggregate", Path = Path.Combine(root, "root"), IsRoot = true });
Add(new UserRootFolder { Id = rootIds["user-root"], Name = "User root", Path = Path.Combine(root, "root", "default"), Tags = input.GetProperty("rootTags").EnumerateArray().Select(value => value.GetString()!).ToArray() });
Add(new Emby.Server.Implementations.Playlists.PlaylistsFolder { Id = rootIds["playlists"], Name = "Playlists", ParentId = rootIds["aggregate"], Path = Path.Combine(root, "data", "playlists") });
foreach (var source in input.GetProperty("items").EnumerateArray()) {
    BaseItem item = source.GetProperty("kind").GetString() switch { "BoxSet" => new BoxSet(), "Movie" => new Movie(), "MusicArtist" => new MusicArtist(), "CollectionFolder" => new CollectionFolder(), _ => new Folder() };
    item.Id = Id(source.GetProperty("id").GetString()!); item.Name = source.GetProperty("name").GetString(); item.Path = Map(source.GetProperty("path").GetString()!);
    item.ParentId = Id(source.GetProperty("parent").GetString()!);
    // The actual mapper assigns ForcedSortName after SortName on cold reads;
    // even null invalidates the cached SortName. A persisted forced input is
    // required to exercise one SortName bucket with different Unicode Names.
    if (source.TryGetProperty("sort", out var sort)) item.ForcedSortName = sort.GetString();
    if (source.TryGetProperty("rating", out var rating)) item.OfficialRating = rating.GetString();
    if (source.TryGetProperty("overview", out var overview)) item.Overview = overview.GetString();
    if (source.TryGetProperty("tags", out var tags)) item.Tags = tags.EnumerateArray().Select(value => value.GetString()!).ToArray();
    if (item is BoxSet box && source.TryGetProperty("libraryFolderIds", out var ids)) box.LibraryFolderIds = ids.EnumerateArray().Select(value => Id(value.GetString()!)).ToArray();
    if (item is CollectionFolder collection) {
        collection.PhysicalLocationsList = source.GetProperty("physicalLocations").EnumerateArray().Select(value => Map(value.GetString()!)).ToArray();
        collection.CollectionType = CollectionType.movies;
    }
    Add(item);
}
using (var db = factory.CreateDbContext()) {
    foreach (var source in input.GetProperty("users").EnumerateArray()) {
        var user = new User(source.GetProperty("name").GetString()!, "Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider", "Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider") {
            Id = Id(source.GetProperty("id").GetString()!), InternalId = db.Users.Local.Count + 1
        };
        foreach (var permission in source.GetProperty("permissions").EnumerateObject()) user.SetPermission(Enum.Parse<PermissionKind>(permission.Name), permission.Value.GetBoolean());
        if (source.TryGetProperty("preferences", out var preferences)) foreach (var preference in preferences.EnumerateObject())
            user.SetPreference(Enum.Parse<PreferenceKind>(preference.Name), preference.Value.EnumerateArray().Select(value => value.GetString()!).ToArray());
        if (source.TryGetProperty("maxRating", out var max)) user.MaxParentalRatingScore = max.GetInt32();
        db.Users.Add(user);
    }
    db.BaseItems.AddRange(entities); db.SaveChanges();
    foreach (var source in input.GetProperty("links").EnumerateArray()) db.LinkedChildren.Add(new LinkedChildEntity {
        ParentId = Id(source.GetProperty("parent").GetString()!), ChildId = Id(source.GetProperty("child").GetString()!),
        ChildType = (DbLinkType)source.GetProperty("type").GetInt32(), SortOrder = source.GetProperty("order").GetInt32()
    });
    var byId = entities.ToDictionary(value => value.Id);
    foreach (var entity in entities) {
        var seen = new HashSet<Guid> { entity.Id }; var parent = entity.ParentId;
        while (parent.HasValue && parent != Guid.Empty && seen.Add(parent.Value) && byId.TryGetValue(parent.Value, out var ancestor)) {
            db.AncestorIds.Add(new AncestorId { ItemId = entity.Id, ParentItemId = ancestor.Id, Item = entity, ParentItem = ancestor }); parent = ancestor.ParentId;
        }
    }
    var tagIds = new Dictionary<string, ItemValue>(StringComparer.Ordinal);
    foreach (var entity in entities) foreach (var tag in (entity.Tags ?? "").Split('|', StringSplitOptions.RemoveEmptyEntries)) {
        if (!tagIds.TryGetValue(tag, out var tagValue)) {
            tagValue = new ItemValue { ItemValueId = new Guid(MD5.HashData(System.Text.Encoding.UTF8.GetBytes("controlled-item-collections-tag:" + tag))),
                Type = ItemValueType.Tags, Value = tag, CleanValue = tag.ToLowerInvariant() };
            db.ItemValues.Add(tagValue); tagIds.Add(tag, tagValue);
        }
        db.ItemValuesMap.Add(new ItemValueMap { ItemId = entity.Id, ItemValueId = tagValue.ItemValueId, Item = entity, ItemValue = tagValue });
    }
    db.SaveChanges();
}
// Populate the repository's derived persistence columns from the actual typed
// parent/rating consumers, rather than guessing their values in neutral input.
// Rating localization itself can resolve collection folders. Bind the actual
// persisted roots before that consumer, since this read-only LibraryManager
// boundary does not run its filesystem/root-initialization constructor path.
Set(library, "_rootFolder", library.GetItemById(rootIds["aggregate"])!);
Set(library, "_userRootFolder", library.GetItemById(rootIds["user-root"])!);
using (var db = factory.CreateDbContext()) {
    foreach (var entity in db.BaseItems.ToArray()) {
        var item = library.GetItemById(entity.Id)!;
        item.OnMetadataChanged();
        entity.TopParentId = item.GetTopParent()?.Id;
        entity.InheritedParentalRatingValue = item.InheritedParentalRatingValue;
        entity.InheritedParentalRatingSubValue = item.InheritedParentalRatingSubValue;
    }
    db.SaveChanges();
}
Set(library, "_cache", new FastConcurrentLru<Guid, BaseItem>(1024));
foreach (var source in input.GetProperty("userData").EnumerateArray()) {
    var userId = Id(source.GetProperty("userId").GetString()!); var item = library.GetItemById(Id(source.GetProperty("itemId").GetString()!))!;
    using var db = factory.CreateDbContext(); var user = db.Users.Include(value => value.Permissions).Include(value => value.Preferences).Single(value => value.Id == userId);
    userData.SaveUserData(user, item, new UserItemData { Key = item.GetUserDataKeys().First(), PlayCount = source.GetProperty("playCount").GetInt32(),
        IsFavorite = source.GetProperty("favorite").GetBoolean(), LastPlayedDate = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc) }, UserDataSaveReason.UpdateUserRating, CancellationToken.None);
}
// Register the actual persisted roots; their Children/visibility still run the
// actual Folder/EF paths. No root navigation result or visibility is mocked.
Set(library, "_rootFolder", library.GetItemById(rootIds["aggregate"])!); Set(library, "_userRootFolder", library.GetItemById(rootIds["user-root"])!);

var userRoot = (UserRootFolder)library.GetUserRootFolder();
var aggregateRoot = (AggregateFolder)library.RootFolder;
typeof(LibraryManager).GetProperty("Comparers", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(library, new IBaseItemComparer[] { new SortNameComparer() });
var views = new UserViewManager(library, localization, null!, null!, configuration);
Folder.UserViewManager = views;
var provider = Stub.Make<IProviderManager>((method, _) => throw new InvalidOperationException("Metadata execution is forbidden."));
var monitor = Stub.Make<ILibraryMonitor>((method, _) => throw new InvalidOperationException("Monitoring mutation is forbidden."));
var collections = new CollectionManager(library, paths, localization, fileSystem, monitor, NullLoggerFactory.Instance, provider, links);
// The actual constructor initializes an empty active-recording dictionary and
// subscribes to configuration events only. This read-only fixture never raises
// those events, initializes timers, or calls recording/media methods. Its only
// consumed method is GetActiveRecordingInfo (also used by Video.SourceType).
using var recordings = new Jellyfin.LiveTv.Recordings.RecordingsManager(NullLogger<Jellyfin.LiveTv.Recordings.RecordingsManager>.Instance,
    configuration, null!, fileSystem, library, monitor, provider, null!, BaseItem.MediaSourceManager, null!, null!, null!, null!);
Video.RecordingsManager = recordings;
var dto = new DtoService(NullLogger<DtoService>.Instance, library, userData, null!, provider, recordings, appHost,
    BaseItem.MediaSourceManager, null!, null!, null!);
var dtoOptions = new DtoOptions(false) {
    Fields = input.GetProperty("dtoFields").EnumerateArray().Select(value => Enum.Parse<ItemFields>(value.GetString()!)).ToArray(),
    EnableImages = false, EnableUserData = false
};
var activeRecordings = (System.Collections.Concurrent.ConcurrentDictionary<string, ActiveRecordingInfo>)typeof(Jellyfin.LiveTv.Recordings.RecordingsManager)
    .GetField("_activeRecordings", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(recordings)!;
if (!activeRecordings.IsEmpty) throw new InvalidOperationException("The DTO dependency must not own any active recording.");
var before = Evidence.Tables(databaseFilename);
object Item(BaseItem item) => new { id = item.Id.ToString("N"), nativeType = item.GetType().FullName, name = item.Name,
    isFolder = item.IsFolder, isTypedFolder = item is Folder, parentId = item.ParentId.ToString("N"), officialRating = item.OfficialRating };
object? RawLinks() => userRoot.LinkedChildren?.Select(link => new { ItemId = link.ItemId?.ToString("N"), Type = (int)link.Type, link.Path, link.LibraryItemId }).ToArray();
void ApplyValues(BaseItem child, JsonElement value) {
    if (value.TryGetProperty("name", out var name)) child.Name = name.GetString();
    if (value.TryGetProperty("overview", out var overview)) child.Overview = overview.GetString();
    if (value.TryGetProperty("genres", out var genres)) child.Genres = genres.EnumerateArray().Select(item => item.GetString()!).ToArray();
    if (value.TryGetProperty("tags", out var tags)) child.Tags = tags.EnumerateArray().Select(item => item.GetString()!).ToArray();
    if (value.TryGetProperty("tagline", out var tagline)) child.Tagline = tagline.GetString();
    if (value.TryGetProperty("providerIds", out var ids)) child.ProviderIds = ids.EnumerateObject().ToDictionary(item => item.Name, item => item.Value.GetString()!, StringComparer.OrdinalIgnoreCase);
}
BaseItem Occurrence(JsonElement value) {
    // A distinct exact object with the same ID is a real warm Children/virtual
    // occurrence. It is never registered as a replacement repository result.
    var original = library.GetItemById(Id(value.GetProperty("id").GetString()!))!;
    BaseItem child = original is MusicArtist ? new MusicArtist() : original is Movie ? new Movie() : new Folder();
    child.Id = original.Id; child.Name = original.Name;
    child.Path = original.Path; child.ParentId = original.ParentId; child.OfficialRating = original.OfficialRating; child.Tags = original.Tags;
    ApplyValues(child, value);
    return child;
}
void Apply(JsonElement sample) {
    if (sample.TryGetProperty("warm", out var warm)) {
        var item = library.GetItemById(Id(warm.GetProperty("id").GetString()!))!;
        ApplyValues(item, warm);
        library.RegisterItem(item);
    }
    if (sample.TryGetProperty("direct", out var direct)) userRoot.Children = direct.ValueKind == JsonValueKind.String ? null! : direct.EnumerateArray().Select(Occurrence).ToArray();
    if (sample.TryGetProperty("virtual", out var virtualChildren)) {
        aggregateRoot.VirtualChildren.Clear();
        // ConcurrentBag's actual one-thread enumeration is LIFO. The neutral
        // input specifies enumeration order, so insert in reverse order.
        foreach (var child in virtualChildren.EnumerateArray().Select(Occurrence).Reverse()) aggregateRoot.VirtualChildren.Add(child);
    }
    if (sample.TryGetProperty("replaceLinks", out var replacements)) {
        userRoot.LinkedChildren = replacements.ValueKind == JsonValueKind.Null ? null! : replacements.EnumerateArray().Select(value => new LinkedChild {
            ItemId = value.GetProperty("ItemId").ValueKind == JsonValueKind.Null ? null : Id(value.GetProperty("ItemId").GetString()!),
            Type = (MediaBrowser.Controller.Entities.LinkedChildType)value.GetProperty("Type").GetInt32(),
            Path = value.GetProperty("Path").ValueKind == JsonValueKind.Null ? null : Map(value.GetProperty("Path").GetString()!),
            LibraryItemId = value.GetProperty("LibraryItemId").GetString()
        }).ToArray();
    }
}
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    Apply(sample); var linksBefore = RawLinks(); object? value = null; object? error = null;
    var key = sample.GetProperty("user").GetString(); var userId = Id(input.GetProperty("users").EnumerateArray().Single(row => row.GetProperty("key").GetString() == key).GetProperty("id").GetString()!);
    using var db = factory.CreateDbContext(); var user = db.Users.AsNoTracking().Include(row => row.Permissions).Include(row => row.Preferences).Single(row => row.Id == userId);
    try {
        value = sample.GetProperty("lane").GetString() switch {
            "root" => userRoot.GetChildren(user, true).Select(Item).ToArray(),
            "dto" => JsonSerializer.SerializeToElement(dto.GetBaseItemDtos(userRoot.GetChildren(user, true), dtoOptions, user, skipVisibilityCheck: true), JsonDefaults.Options),
            "raw" => library.GetCollectionFolders(library.GetItemById(Id(input.GetProperty("target").GetString()!))!).Select(Item).ToArray(),
            "collections" => collections.GetCollectionsContainingItem(user, Id(input.GetProperty("target").GetString()!)).Select(row => row.Id.ToString("N")).Order(StringComparer.Ordinal).ToArray(),
            "views" => views.GetUserViews(new UserViewQuery { User = user, IncludeExternalContent = false, IncludeHidden = true }).Select(Item).ToArray(),
            _ => throw new InvalidOperationException("Unknown root-linked lane.")
        };
    } catch (Exception exception) {
        error = new { type = exception.GetType().Name, message = exception.Message, stack = exception.StackTrace,
            status = exception is ArgumentException ? 400 : 500 };
    }
    results.Add(new { name = sample.GetProperty("name").GetString(), lane = sample.GetProperty("lane").GetString(), value, error, linksBefore, linksAfter = RawLinks() });
}
var after = Evidence.Tables(databaseFilename);
if (!activeRecordings.IsEmpty) throw new InvalidOperationException("Read-only root DTO consumption changed the active-recording dictionary.");
if (JsonSerializer.Serialize(before) != JsonSerializer.Serialize(after)) throw new InvalidOperationException("Root reads changed persisted native tables.");
if (Evidence.Schema(databaseFilename) != schemaBefore || Evidence.Hash(sourceFilename) != sourceHash) throw new InvalidOperationException("The supplied database/schema changed.");
var foreignKeys = Evidence.ForeignKeys(databaseFilename);
File.WriteAllText(output, JsonSerializer.Serialize(new { inputSha256 = Evidence.Hash(args[0]), sourceSha256 = sourceHash, databaseFilename, rootIds,
    actualRepositoryAndTypedMapper = true, actualLinkedChildrenService = true, actualRootGetChildren = true, actualCollectionManager = true,
    actualCollectionFolders = true, actualUserViewManager = true, actualEfSqlite = true, userLookupControlled = false,
    actualDtoService = true, actualReadOnlyRecordingsManager = true,
    dtoInitialization = new { fields = dtoOptions.Fields.Select(value => value.ToString()).ToArray(), dtoOptions.EnableImages, dtoOptions.EnableUserData,
        skipVisibilityCheck = true, activeRecordingsBeforeAndAfterEmpty = true, mediaExecutionDependenciesAbsent = true },
    schemaCreated = false, schemaHistoryPreserved = true, recordingOrMediaExecution = false,
    preparation = new { cloneSha256 = sourceHash, schemaJson = schemaBefore, foreignKeys }, before, after, results,
    ratingInitialization = new { loadedAll = true, countryCode = "US", scores = new { G = gRating, R = rRating }, resources = ratingResources },
    assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location)).Select(value => new { name = value.GetName().Name, filename = value.Location, sha256 = Evidence.Hash(value.Location) }),
    nativeLibraries = new[] { new { filename = nativeFilename, sha256 = Evidence.Hash(nativeFilename), rid = RuntimeInformation.RuntimeIdentifier, loadedByExplicitResolver = true } },
    databaseSha256 = Evidence.Hash(databaseFilename), phaseAcceptance = false, releaseAcceptance = false
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false, ForeignKeys = true }.ToString()).Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
public static class Evidence {
    public static string Hash(string filename) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename)));
    static SqliteConnection Open(string filename, bool foreignKeys = true) { var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false, ForeignKeys = foreignKeys }.ToString()); connection.Open(); return connection; }
    static object[][] Rows(SqliteConnection connection, string sql) {
        using var command = connection.CreateCommand(); command.CommandText = sql; using var reader = command.ExecuteReader(); var rows = new List<object[]>();
        while (reader.Read()) rows.Add(Enumerable.Range(0, reader.FieldCount).Select(i => reader.IsDBNull(i) ? null! : reader.GetValue(i)).ToArray()); return rows.ToArray();
    }
    public static string Schema(string filename) {
        using var connection = Open(filename); return JsonSerializer.Serialize(new[] {
            Rows(connection, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"),
            Rows(connection, "SELECT MigrationId,ProductVersion FROM __EFMigrationsHistory ORDER BY MigrationId") });
    }
    public static void Clear(string filename) {
        using var connection = Open(filename, false);
        foreach (var row in Rows(connection, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__EFMigrationsHistory' ORDER BY name")) {
            using var command = connection.CreateCommand(); command.CommandText = "DELETE FROM \"" + ((string)row[0]).Replace("\"", "\"\"") + "\""; command.ExecuteNonQuery();
        }
        using var reset = connection.CreateCommand(); reset.CommandText = "DELETE FROM sqlite_sequence"; reset.ExecuteNonQuery();
    }
    public static object ForeignKeys(string filename) {
        using var connection = Open(filename);
        var enabled = Convert.ToInt64(Rows(connection, "PRAGMA foreign_keys")[0][0]) == 1;
        var violations = Rows(connection, "PRAGMA foreign_key_check");
        if (!enabled || violations.Length != 0) throw new InvalidOperationException("The controlled seed must retain actual enabled foreign keys and valid relations.");
        return new { enabled, violations };
    }
    public static object Tables(string filename) {
        using var connection = Open(filename); var result = new Dictionary<string, object>();
        foreach (var entry in Rows(connection, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
            var table = (string)entry[0]; var escaped = table.Replace("\"", "\"\"");
            var rows = Rows(connection, "SELECT * FROM \"" + escaped + "\"").Select(row => JsonSerializer.Serialize(row)).Order(StringComparer.Ordinal).ToArray();
            result[table] = new { count = rows.Length, sha256 = Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(rows))) };
        }
        return result;
    }
}
