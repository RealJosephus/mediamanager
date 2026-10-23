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
using Jellyfin.Api.ModelBinders;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Extensions.Json;
using Jellyfin.Drawing;
using Jellyfin.Server.Extensions;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Common;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
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
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;
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
typeof(LibraryManager).GetProperty("Comparers", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(library, new IBaseItemComparer[] {
    new SortNameComparer(), new NameComparer(), new DateCreatedComparer(), new ProductionYearComparer(),
    new CommunityRatingComparer(), new CriticRatingComparer(), new IndexNumberComparer(),
    new ParentIndexNumberComparer(), new PremiereDateComparer(), new RuntimeComparer(), new IsFolderComparer(), new AiredEpisodeOrderComparer()
});
var views = new UserViewManager(library, localization, null!, null!, configuration);
Folder.UserViewManager = views;
var provider = Stub.Make<IProviderManager>((method, _) => throw new InvalidOperationException("Metadata execution is forbidden."));
var monitor = Stub.Make<ILibraryMonitor>((method, _) => throw new InvalidOperationException("Monitoring mutation is forbidden."));
var collections = new CollectionManager(library, paths, localization, fileSystem, monitor, NullLoggerFactory.Instance, provider, links);
var collectionCalls = new List<string>();
Folder.CollectionManager = Stub.Make<ICollectionManager>((method, values) => {
    collectionCalls.Add(method.Name);
    try { return method.Invoke(collections, values); }
    catch (TargetInvocationException error) when (error.InnerException is not null) {
        System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw();
        throw;
    }
});
// The actual constructor initializes an empty active-recording dictionary and
// subscribes to configuration events only. This read-only fixture never raises
// those events, initializes timers, or calls recording/media methods. Its only
// consumed method is GetActiveRecordingInfo (also used by Video.SourceType).
using var recordings = new Jellyfin.LiveTv.Recordings.RecordingsManager(NullLogger<Jellyfin.LiveTv.Recordings.RecordingsManager>.Instance,
    configuration, null!, fileSystem, library, monitor, provider, null!, BaseItem.MediaSourceManager, null!, null!, null!, null!);
Video.RecordingsManager = recordings;
var imageCalls = new List<string>();
using var imageProcessor = new ImageProcessor(NullLogger<ImageProcessor>.Instance, paths, fileSystem,
    Stub.Make<IImageEncoder>((_, _) => throw new InvalidOperationException("Image encoding is outside this read-only DTO component.")), configuration);
var imageReader = Stub.Make<IImageProcessor>((method, values) => {
    imageCalls.Add(method.Name);
    try { return method.Invoke(imageProcessor, values); }
    catch (TargetInvocationException error) when (error.InnerException is not null) {
        System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw(); throw;
    }
});
var dto = new DtoService(NullLogger<DtoService>.Instance, library, userData, imageReader, provider, recordings, appHost,
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
object? RawLinks(Folder folder) => folder.LinkedChildren?.Select(link => new { ItemId = link.ItemId?.ToString("N"), Type = (int)link.Type, link.Path, link.LibraryItemId }).ToArray();
var observedCollections = new Dictionary<string, Folder>(StringComparer.Ordinal);
object CollectionLinks() => observedCollections.ToDictionary(pair => pair.Key, pair => RawLinks(pair.Value), StringComparer.Ordinal);
void ApplyValues(BaseItem child, JsonElement value) {
    if (value.TryGetProperty("name", out var name)) child.Name = name.GetString();
    if (value.TryGetProperty("overview", out var overview)) child.Overview = overview.GetString();
    if (value.TryGetProperty("genres", out var genres)) child.Genres = genres.EnumerateArray().Select(item => item.GetString()!).ToArray();
    if (value.TryGetProperty("tags", out var tags)) child.Tags = tags.EnumerateArray().Select(item => item.GetString()!).ToArray();
    if (value.TryGetProperty("tagline", out var tagline)) child.Tagline = tagline.GetString();
    if (value.TryGetProperty("providerIds", out var ids)) child.ProviderIds = ids.EnumerateObject().ToDictionary(item => item.Name, item => item.Value.GetString()!, StringComparer.OrdinalIgnoreCase);
    foreach (var (key, propertyName) in new[] {
        ("rating", "OfficialRating"), ("customRating", "CustomRating"), ("sort", "ForcedSortName"),
        ("studios", "Studios"), ("year", "ProductionYear"), ("index", "IndexNumber"), ("parentIndex", "ParentIndexNumber"),
        ("locked", "IsLocked"), ("virtualItem", "IsVirtualItem"), ("created", "DateCreated"), ("premiere", "PremiereDate"),
        ("runtime", "RunTimeTicks")
    }) if (value.TryGetProperty(key, out var supplied)) {
        var property = typeof(BaseItem).GetProperty(propertyName)!;
        property.SetValue(child, supplied.Deserialize(property.PropertyType, JsonDefaults.Options));
    }
    if (value.TryGetProperty("communityRating", out var community)) child.CommunityRating = community.ValueKind == JsonValueKind.Null ? null
        : community.ValueKind == JsonValueKind.String ? float.Parse(community.GetString()!, CultureInfo.InvariantCulture) : community.GetSingle();
    if (value.TryGetProperty("criticRating", out var critic)) child.CriticRating = critic.ValueKind == JsonValueKind.Null ? null : critic.GetSingle();
    if (value.TryGetProperty("path", out var suppliedPath)) child.Path = suppliedPath.ValueKind == JsonValueKind.Null ? null : Map(suppliedPath.GetString()!);
    if (value.TryGetProperty("parentId", out var parentId)) child.ParentId = Id(parentId.GetString()!);
    if (value.TryGetProperty("images", out var images)) child.ImageInfos = images.ValueKind == JsonValueKind.Null ? null!
        : images.EnumerateArray().Select(image => new ItemImageInfo {
            Path = Map(image.GetProperty("path").GetString()!), Type = Enum.Parse<ImageType>(image.GetProperty("type").GetString()!),
            DateModified = image.GetProperty("modified").Deserialize<DateTime>(JsonDefaults.Options),
            Width = image.GetProperty("width").GetInt32(), Height = image.GetProperty("height").GetInt32(),
            BlurHash = image.GetProperty("blurHash").GetString()
        }).ToArray();
    if (value.TryGetProperty("links", out var links)) {
        if (child is not Folder folder) throw new InvalidOperationException("Only a Folder occurrence accepts links.");
        folder.LinkedChildren = links.ValueKind == JsonValueKind.Null ? null! : links.EnumerateArray().Select(link => new LinkedChild {
            ItemId = link.GetProperty("ItemId").ValueKind == JsonValueKind.Null ? null : Id(link.GetProperty("ItemId").GetString()!),
            Type = (MediaBrowser.Controller.Entities.LinkedChildType)link.GetProperty("Type").GetInt32(),
            Path = link.GetProperty("Path").ValueKind == JsonValueKind.Null ? null : Map(link.GetProperty("Path").GetString()!),
            LibraryItemId = link.GetProperty("LibraryItemId").GetString()
        }).ToArray();
    }
    if (value.TryGetProperty("children", out var children)) {
        if (child is not Folder childFolder) throw new InvalidOperationException("Only a Folder occurrence accepts Children.");
        childFolder.Children = children.ValueKind == JsonValueKind.String ? null! : children.EnumerateArray().Select(Occurrence).ToArray();
    }
    if (value.TryGetProperty("track", out var track)) observedCollections[track.GetString()!] = (Folder)child;
    if (child is Episode episode) {
        if (value.TryGetProperty("airsAfterSeason", out var after)) episode.AirsAfterSeasonNumber = after.Deserialize<int?>();
        if (value.TryGetProperty("airsBeforeSeason", out var before)) episode.AirsBeforeSeasonNumber = before.Deserialize<int?>();
        if (value.TryGetProperty("airsBeforeEpisode", out var number)) episode.AirsBeforeEpisodeNumber = number.Deserialize<int?>();
    }
}
BaseItem Occurrence(JsonElement value) {
    if (value.TryGetProperty("cached", out var cached) && cached.GetBoolean()) {
        var live = library.GetItemById(Id(value.GetProperty("id").GetString()!))!;
        ApplyValues(live, value); library.RegisterItem(live);
        return live;
    }
    // A distinct exact object with the same ID is a real warm Children/virtual
    // occurrence. It is never registered as a replacement repository result.
    BaseItem child;
    if (value.TryGetProperty("kind", out var kind)) child = kind.GetString() switch {
        "Movie" => new Movie(), "Folder" => new Folder(), "Episode" => new Episode(), "BoxSet" => new BoxSet(), _ => throw new InvalidOperationException("Unknown fresh occurrence type.")
    };
    else {
        var original = library.GetItemById(Id(value.GetProperty("id").GetString()!))!;
        child = (BaseItem)Activator.CreateInstance(original.GetType())!;
        child.Name = original.Name; child.Path = original.Path; child.ParentId = original.ParentId;
        child.OfficialRating = original.OfficialRating; child.Tags = original.Tags;
    }
    child.Id = Id(value.GetProperty("id").GetString()!);
    ApplyValues(child, value);
    return child;
}
void Apply(JsonElement sample, Folder folder) {
    if (sample.TryGetProperty("folderPath", out var folderPath)) folder.Path = Map(folderPath.GetString()!);
    if (sample.TryGetProperty("warm", out var warm)) {
        var item = library.GetItemById(Id(warm.GetProperty("id").GetString()!))!;
        ApplyValues(item, warm);
        library.RegisterItem(item);
    }
    if (sample.TryGetProperty("direct", out var direct)) folder.Children = direct.ValueKind == JsonValueKind.String ? null! : direct.EnumerateArray().Select(Occurrence).ToArray();
    if (sample.TryGetProperty("aggregateChildren", out var aggregateChildren)) aggregateRoot.Children = aggregateChildren.ValueKind == JsonValueKind.String ? null!
        : aggregateChildren.EnumerateArray().Select(Occurrence).ToArray();
    if (sample.TryGetProperty("collectionsChildren", out var collectionChildren)) {
        var collectionsFolder = collections.GetCollectionsFolder(false).GetAwaiter().GetResult()
            ?? throw new InvalidOperationException("The actual collection folder must exist.");
        collectionsFolder.Children = collectionChildren.ValueKind == JsonValueKind.String ? null!
            : collectionChildren.EnumerateArray().Select(Occurrence).ToArray();
    }
    if (sample.TryGetProperty("virtual", out var virtualChildren)) {
        aggregateRoot.VirtualChildren.Clear();
        // ConcurrentBag's actual one-thread enumeration is LIFO. The neutral
        // input specifies enumeration order, so insert in reverse order.
        foreach (var child in virtualChildren.EnumerateArray().Select(Occurrence).Reverse()) aggregateRoot.VirtualChildren.Add(child);
    }
    if (sample.TryGetProperty("replaceLinks", out var replacements)) {
        folder.LinkedChildren = replacements.ValueKind == JsonValueKind.Null ? null! : replacements.EnumerateArray().Select(value => new LinkedChild {
            ItemId = value.GetProperty("ItemId").ValueKind == JsonValueKind.Null ? null : Id(value.GetProperty("ItemId").GetString()!),
            Type = (MediaBrowser.Controller.Entities.LinkedChildType)value.GetProperty("Type").GetInt32(),
            Path = value.GetProperty("Path").ValueKind == JsonValueKind.Null ? null : Map(value.GetProperty("Path").GetString()!),
            LibraryItemId = value.GetProperty("LibraryItemId").GetString()
        }).ToArray();
    }
}
var itemArguments = typeof(ItemsController).GetMethods(BindingFlags.Instance | BindingFlags.Public)
    .Where(method => method.Name == nameof(ItemsController.GetItems)).SelectMany(method => method.GetParameters())
    .Select(parameter => parameter.Name!).ToHashSet(StringComparer.OrdinalIgnoreCase);
if (!itemArguments.Contains("genres") || !itemArguments.Contains("tags") || itemArguments.Contains("minIndexNumber"))
    throw new InvalidOperationException("The designated Items argument inventory changed.");
var pipeBindings = new List<object>();
string[] BindPipe(string name, JsonElement value, string caseName) {
    var raw = value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().Select(item => item.GetString()!).ToArray() : [value.GetString()!];
    var queryProvider = new QueryStringValueProvider(BindingSource.Query,
        new QueryCollection(new Dictionary<string, StringValues> { [name] = new StringValues(raw) }), CultureInfo.InvariantCulture);
    var context = DefaultModelBindingContext.CreateBindingContext(new ActionContext { HttpContext = new DefaultHttpContext() },
        queryProvider, new EmptyModelMetadataProvider().GetMetadataForType(typeof(string[])), null, name);
    new PipeDelimitedCollectionModelBinder(NullLogger<PipeDelimitedCollectionModelBinder>.Instance).BindModelAsync(context).GetAwaiter().GetResult();
    if (!context.Result.IsModelSet) throw new InvalidOperationException("The real pipe binder did not produce a model.");
    var bound = (string[])context.Result.Model!;
    pipeBindings.Add(new { caseName, name, raw, bound });
    return bound;
}
object FolderItems(Folder folder, User user, JsonElement sample) {
    var options = new DtoOptions(false) { Fields = dtoOptions.Fields, EnableImages = false, EnableUserData = false };
    var query = new InternalItemsQuery(user) { DtoOptions = options };
    if (sample.TryGetProperty("query", out var supplied)) {
        if (supplied.TryGetProperty("EnableImages", out var enableImages)) options.EnableImages = enableImages.GetBoolean();
        if (supplied.TryGetProperty("ImageTypeLimit", out var imageLimit)) options.ImageTypeLimit = imageLimit.GetInt32();
        if (supplied.TryGetProperty("EnableImageTypes", out var imageTypes)) options.ImageTypes = imageTypes.EnumerateArray()
            .Select(value => Enum.Parse<ImageType>(value.GetString()!)).ToArray();
        if (supplied.TryGetProperty("SortBy", out var sort)) {
            var orders = supplied.TryGetProperty("SortOrder", out var order) ? order.EnumerateArray().Select(value => Enum.Parse<SortOrder>(value.GetString()!)).ToArray() : [];
            query.OrderBy = sort.EnumerateArray().Select((value, index) => (Enum.Parse<ItemSortBy>(value.GetString()!),
                orders.Length == 0 ? SortOrder.Ascending : orders[Math.Min(index, orders.Length - 1)])).ToArray();
        }
        foreach (var property in supplied.EnumerateObject()) {
            if (property.Name is "SortBy" or "SortOrder" or "EnableImages" or "ImageTypeLimit" or "EnableImageTypes") continue;
            // The candidate's formal queryItems consumer applies the public
            // Items binder. Unknown HTTP keys do not become Internal fields.
            if (!itemArguments.Contains(property.Name)) continue;
            var name = property.Name switch { "Ids" => "ItemIds", _ => property.Name };
            var target = typeof(InternalItemsQuery).GetProperty(name)
                ?? throw new InvalidOperationException("The native fixture cannot silently ignore query field " + property.Name);
            target.SetValue(query, property.Name is "Genres" or "Tags" or "OfficialRatings"
                ? BindPipe(property.Name, property.Value, sample.GetProperty("name").GetString()!) : property.Value.Deserialize(target.PropertyType, JsonDefaults.Options));
        }
    }
    var result = folder.GetItems(query);
    return new { Items = JsonSerializer.SerializeToElement(dto.GetBaseItemDtos(result.Items, options, user, skipVisibilityCheck: true), JsonDefaults.Options),
        result.TotalRecordCount, StartIndex = query.StartIndex ?? 0 };
}
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    if (sample.TryGetProperty("configuration", out var configured)) {
        foreach (var property in configured.EnumerateObject()) {
            if (property.Name is not (nameof(ServerConfiguration.EnableGroupingMoviesIntoCollections) or nameof(ServerConfiguration.EnableGroupingShowsIntoCollections)))
                throw new InvalidOperationException("Unknown controlled grouping setting.");
            typeof(ServerConfiguration).GetProperty(property.Name)!.SetValue(settings, property.Value.GetBoolean());
        }
    }
    var folder = sample.TryGetProperty("folder", out var folderId) ? (Folder)library.GetItemById(Id(folderId.GetString()!))! : userRoot;
    Apply(sample, folder); var linksBefore = RawLinks(folder); object? value = null; object? error = null;
    var observeCollections = sample.TryGetProperty("observeCollections", out var observe) && observe.GetBoolean();
    var collectionsBefore = observeCollections ? CollectionLinks() : null;
    var key = sample.GetProperty("user").GetString();
    using var db = factory.CreateDbContext(); User user = null!;
    if (key is not null) {
        var userId = Id(input.GetProperty("users").EnumerateArray().Single(row => row.GetProperty("key").GetString() == key).GetProperty("id").GetString()!);
        user = db.Users.AsNoTracking().Include(row => row.Permissions).Include(row => row.Preferences).Single(row => row.Id == userId);
    } else if (sample.GetProperty("lane").GetString() != "folder") throw new InvalidOperationException("Only the Folder lane accepts an explicit null user.");
    try {
        value = sample.GetProperty("lane").GetString() switch {
            "folder" => FolderItems(folder, user, sample),
            "root" => userRoot.GetChildren(user, true).Select(Item).ToArray(),
            "dto" => JsonSerializer.SerializeToElement(dto.GetBaseItemDtos(userRoot.GetChildren(user, true), dtoOptions, user, skipVisibilityCheck: true), JsonDefaults.Options),
            "raw" => library.GetCollectionFolders(library.GetItemById(Id(input.GetProperty("target").GetString()!))!).Select(Item).ToArray(),
            "collections" => Folder.CollectionManager.GetCollectionsContainingItem(user, Id(input.GetProperty("target").GetString()!)).Select(row => row.Id.ToString("N")).Order(StringComparer.Ordinal).ToArray(),
            "views" => views.GetUserViews(new UserViewQuery { User = user, IncludeExternalContent = false, IncludeHidden = true }).Select(Item).ToArray(),
            _ => throw new InvalidOperationException("Unknown root-linked lane.")
        };
    } catch (Exception exception) {
        error = new { type = exception.GetType().Name, message = exception.Message, stack = exception.StackTrace,
            status = exception is ArgumentException ? 400 : 500 };
    }
    if (observeCollections) results.Add(new { name = sample.GetProperty("name").GetString(), lane = sample.GetProperty("lane").GetString(), value, error,
        linksBefore, linksAfter = RawLinks(folder), collectionsBefore, collectionsAfter = CollectionLinks() });
    else results.Add(new { name = sample.GetProperty("name").GetString(), lane = sample.GetProperty("lane").GetString(), value, error, linksBefore, linksAfter = RawLinks(folder) });
}
var after = Evidence.Tables(databaseFilename);
if (!activeRecordings.IsEmpty) throw new InvalidOperationException("Read-only root DTO consumption changed the active-recording dictionary.");
if (JsonSerializer.Serialize(before) != JsonSerializer.Serialize(after)) throw new InvalidOperationException("Root reads changed persisted native tables.");
if (Evidence.Schema(databaseFilename) != schemaBefore || Evidence.Hash(sourceFilename) != sourceHash) throw new InvalidOperationException("The supplied database/schema changed.");
var foreignKeys = Evidence.ForeignKeys(databaseFilename);
File.WriteAllText(output, JsonSerializer.Serialize(new { inputSha256 = Evidence.Hash(args[0]), sourceSha256 = sourceHash, databaseFilename, rootIds,
    actualRepositoryAndTypedMapper = true, actualLinkedChildrenService = true,
    actualRootGetChildren = input.GetProperty("cases").EnumerateArray().Any(sample => sample.GetProperty("lane").GetString() is "root" or "dto"),
    actualCollectionManager = collectionCalls.Count > 0,
    collectionManagerInitialization = new { implementation = collections.GetType().FullName, calls = collectionCalls.ToArray() },
    imageProcessorInitialization = new { implementation = imageProcessor.GetType().FullName, calls = imageCalls.ToArray() },
    actualCollectionFolders = input.GetProperty("cases").EnumerateArray().Any(sample => sample.GetProperty("lane").GetString() == "raw"),
    actualUserViewManager = input.GetProperty("cases").EnumerateArray().Any(sample => sample.GetProperty("lane").GetString() == "views"),
    actualEfSqlite = true, userLookupControlled = false, actualDtoService = true, actualReadOnlyRecordingsManager = true,
    actualFolderGetItems = input.GetProperty("cases").EnumerateArray().Any(sample => sample.GetProperty("lane").GetString() == "folder"),
    folderQueryInitialization = new { actualItemsArgumentInventory = true, actualPipeDelimitedBinder = pipeBindings.Count > 0,
        controller = typeof(ItemsController).FullName, binder = typeof(PipeDelimitedCollectionModelBinder).FullName,
        arguments = itemArguments.Order(StringComparer.Ordinal).ToArray(), bindings = pipeBindings, httpHostExecuted = false },
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
