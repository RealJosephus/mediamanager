using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.Collections;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.IO;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var json = new JsonSerializerOptions { WriteIndented = true, Converters = { new JsonStringEnumConverter() } };
var results = new List<object>();
foreach (var sample in JsonDocument.Parse(inputBytes).RootElement.EnumerateArray()) {
    var key = sample.GetProperty("key").GetString()!;
    var program = Path.GetFullPath(Path.Combine(args[1], key, "program"));
    var data = Path.Combine(program, "data");
    var collections = Path.Combine(data, "collections");
    Directory.CreateDirectory(program);
    string Map(string? value) => value?.Replace("{collections}", collections).Replace("{data}", data).Replace("{program}", program)!;
    var calls = new List<object>();
    var failure = sample.TryGetProperty("failure", out var fail) ? fail.GetString() : null;
    void Trace(string action, object? value = null) { calls.Add(new { action, value }); if (failure == action) throw new IOException("Controlled " + action + " failure."); }
    Guid Id(int index) => index == 0 ? Guid.Empty : Guid.Parse("969d0000-0000-0000-0000-" + index.ToString("D12"));
    var paths = Stub.Make<IApplicationPaths>((method, _) => method.Name switch { "get_ProgramDataPath" => program, "get_DataPath" => data,
        "get_TempDirectory" => Path.Combine(program, "temp"), _ => Stub.Default(method.ReturnType) });
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var root = new ControlledRoot { Id = Id(1), Path = Path.Combine(program, "root"), Trace = Trace };
    Folder parent = sample.TryGetProperty("parentType", out var parentType) && parentType.GetString() == "MusicArtist" ? new MusicArtist() : new Folder();
    parent.Id = Id(2); parent.Name = "collection-root"; parent.Path = collections;
    parent.ParentId = parent is MusicArtist ? Guid.Empty : root.Id;
    if (!sample.TryGetProperty("existingFolder", out var existing) || existing.GetBoolean()) {
        if (sample.TryGetProperty("parentPath", out var parentPath)) parent.Path = Map(parentPath.GetString());
        Directory.CreateDirectory(parent.Path);
        root.LiveChildren = [parent];
    }
    if (sample.TryGetProperty("blockedDirectory", out var blockedDirectory)) {
        Directory.CreateDirectory(collections);
        File.WriteAllText(Path.Combine(collections, blockedDirectory.GetString()! + " [boxset]"), "blocked");
    }
    object Project(BaseItem item) => new { id = item.Id.ToString("N"), name = item.Name, path = item.Path, parentId = item.ParentId.ToString("N"),
        isLocked = item.IsLocked, providerIds = item.ProviderIds, officialRating = item.OfficialRating,
        links = item is Folder folder ? folder.LinkedChildren.Select(link => new { itemId = link.ItemId?.ToString("N"), type = (int)link.Type, path = link.Path, libraryItemId = link.LibraryItemId }).ToArray() : [] };
    var items = new Dictionary<Guid, BaseItem> { [root.Id] = root, [parent.Id] = parent };
    foreach (var specification in sample.GetProperty("items").EnumerateArray()) {
        var item = new Movie { Id = Id(specification.GetProperty("id").GetInt32()), Name = specification.GetProperty("name").GetString()!,
            Path = Map(specification.TryGetProperty("path", out var itemPath) ? itemPath.GetString() : "{program}/movie.mkv"),
            OfficialRating = specification.TryGetProperty("rating", out var rating) ? rating.GetString() : null,
            DateCreated = specification.TryGetProperty("created", out var created) ? DateTime.Parse(created.GetString()!).ToUniversalTime() : DateTime.MinValue,
            OwnerId = specification.TryGetProperty("ownerId", out var ownerId) ? Id(ownerId.GetInt32()) : Guid.Empty,
            PrimaryVersionId = specification.TryGetProperty("primaryVersionId", out var primary) ? Id(primary.GetInt32()) : null };
        items[item.Id] = item;
    }
    BoxSet? collection = null;
    if (sample.GetProperty("operation").GetString() != "create" && sample.GetProperty("operation").GetString() != "ensure") {
        collection = new BoxSet { Id = Id(100), Name = "Existing", Path = Path.Combine(collections, "Existing [boxset]"), ParentId = parent.Id,
            OfficialRating = sample.TryGetProperty("officialRating", out var rating) ? rating.GetString() : "R",
            IsLocked = sample.TryGetProperty("isLocked", out var locked) && locked.GetBoolean(),
            LockedFields = sample.TryGetProperty("lockedFields", out var lockedFields) ? lockedFields.EnumerateArray().Select(value => Enum.Parse<MetadataField>(value.GetString()!)).ToArray() : [] };
        collection.LinkedChildren = sample.TryGetProperty("links", out var links) && links.ValueKind == JsonValueKind.Null ? null!
            : sample.TryGetProperty("links", out links) ? links.EnumerateArray().Select(link => new LinkedChild {
                ItemId = link.TryGetProperty("id", out var id) && id.ValueKind != JsonValueKind.Null ? Id(id.GetInt32()) : null,
                Type = link.TryGetProperty("type", out var type) ? (LinkedChildType)type.GetInt32() : LinkedChildType.Manual,
                Path = link.TryGetProperty("path", out var legacyPath) ? Map(legacyPath.GetString()) : null,
                LibraryItemId = link.TryGetProperty("libraryItemId", out var libraryId) ? Id(libraryId.GetInt32()).ToString("N") : null }).ToArray() : [];
        items[collection.Id] = collection;
    }
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_ApplicationPaths" => paths, "get_Configuration" => new ServerConfiguration { MetadataCountryCode = "US" }, _ => Stub.Default(method.ReturnType) });
    var localization = Stub.Make<ILocalizationManager>((method, parameters) => {
        if (method.Name == "GetServerLocalizedString") return sample.TryGetProperty("serverName", out var serverName) ? serverName.GetString()! : "Collections";
        if (method.Name == "GetRatingScore") {
            var text = (string)parameters![0]!;
            if (sample.TryGetProperty("ratingScores", out var ratingScores) && ratingScores.TryGetProperty(text, out var controlledScore)) {
                return new ParentalRatingScore(controlledScore.GetProperty("score").GetInt32(), controlledScore.TryGetProperty("subScore", out var subScore)
                    && subScore.ValueKind != JsonValueKind.Null ? subScore.GetInt32() : null);
            }
            var score = text.ToUpperInvariant() switch { "G" => 1, "PG" => 5, "PG-13" => 8, "R" => 9, _ => -1 };
            return score < 0 ? null : new ParentalRatingScore(score, 0);
        }
        return Stub.Default(method.ReturnType);
    });
    var pathQueries = new List<object>();
    var pathManager = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    typeof(LibraryManager).GetField("_itemRepository", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(pathManager,
        Stub.Make<IItemRepository>((method, parameters) => {
            if (method.Name != "GetItemList") return Stub.Default(method.ReturnType);
            var query = (InternalItemsQuery)parameters![0]!;
            pathQueries.Add(new { query.Path, query.IncludeOwnedItems, query.IncludeAlternateVersions, query.Limit,
                order = query.OrderBy.Select(pair => new { name = pair.OrderBy.ToString(), direction = pair.SortOrder.ToString() }).ToArray() });
            return items.Values.Where(item => item.Path == query.Path)
                .Where(item => query.IncludeOwnedItems || item.OwnerId == Guid.Empty || item.ExtraType.HasValue)
                .Where(item => query.IncludeAlternateVersions || item is not Video video || video.PrimaryVersionId == null || !items.ContainsKey(video.PrimaryVersionId.Value))
                .OrderByDescending(item => item.DateCreated).Take(query.Limit ?? int.MaxValue).ToArray();
        }));
    var library = Stub.Make<ILibraryManager>((method, parameters) => {
        switch (method.Name) {
            case "get_RootFolder": return root;
            case "GetItemById": return parameters![0] is Guid id && items.TryGetValue(id, out var found) ? found : null;
            case "GetNewItemId": return Id(100);
            case "GetItemList":
                var query = (InternalItemsQuery)parameters![0]!;
                return query.ItemIds.Where(id => !sample.TryGetProperty("excludedFromBatch", out var excluded) || !excluded.EnumerateArray().Any(entry => Id(entry.GetInt32()) == id))
                    .Where(items.ContainsKey).Select(id => items[id]).ToArray();
            case "FindByPath": return pathManager.FindByPath((string)parameters![0]!, null);
            case "GetCollectionFolders": return new List<Folder>();
            case "GetLibraryOptions": return new LibraryOptions();
            case "CreateItem":
                collection = (BoxSet)parameters![0]!; Trace("create", Project(collection)); items[collection.Id] = collection; return null;
            case "UpdateItemAsync": Trace("save", Project((BaseItem)parameters![0]!)); return Task.CompletedTask;
            case "AddVirtualFolder":
                var options = (LibraryOptions)parameters![2]!;
                Trace("library-add", new { name = parameters[0], type = parameters[1]!.ToString(), options = new { options.PathInfos, options.EnableRealtimeMonitor, options.SaveLocalMetadata }, refresh = parameters[3] });
                if (!sample.TryGetProperty("resolveCreatedFolder", out var resolve) || resolve.GetBoolean()) root.LiveChildren = [parent];
                return Task.CompletedTask;
            default: return Stub.Default(method.ReturnType);
        }
    });
    var monitor = Stub.Make<ILibraryMonitor>((method, parameters) => {
        if (method.Name == "ReportFileSystemChangeBeginning") Trace("begin", parameters![0]);
        if (method.Name == "ReportFileSystemChangeComplete") Trace("complete", new { path = parameters![0], refresh = parameters[1] });
        return Stub.Default(method.ReturnType);
    });
    var provider = Stub.Make<IProviderManager>((method, parameters) => {
        if (method.Name == "QueueRefresh") {
            var options = (MetadataRefreshOptions)parameters![1]!;
            Trace("queue", new { id = ((Guid)parameters[0]!).ToString("N"), options = new { options.MetadataRefreshMode, options.ImageRefreshMode, options.IsAutomated, options.ForceSave }, priority = parameters[2]!.ToString() });
        }
        return Stub.Default(method.ReturnType);
    });
    BaseItem.LibraryManager = library; BaseItem.FileSystem = fileSystem; BaseItem.ConfigurationManager = config;
    BaseItem.LocalizationManager = localization; BaseItem.ProviderManager = provider; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    var manager = new CollectionManager(library, paths, localization, fileSystem, monitor, NullLoggerFactory.Instance, provider,
        Stub.Make<ILinkedChildrenService>((method, _) => Stub.Default(method.ReturnType)));
    manager.CollectionCreated += (_, value) => Trace("created-event", Project(value.Collection));
    manager.ItemsAddedToCollection += (_, value) => Trace("added-event", value.ItemsChanged.Select(item => item.Id.ToString("N")).ToArray());
    manager.ItemsRemovedFromCollection += (_, value) => Trace("removed-event", value.ItemsChanged.Select(item => item.Id.ToString("N")).ToArray());
    string? exception = null; bool? foundFolder = null;
    try {
        var requested = sample.TryGetProperty("ids", out var ids) ? ids.EnumerateArray().Select(entry => Id(entry.GetInt32())).ToArray() : [];
        var collectionId = sample.TryGetProperty("collectionId", out var collectionIdValue) ? Id(collectionIdValue.GetInt32()) : Id(100);
        switch (sample.GetProperty("operation").GetString()) {
            case "create": collection = await manager.CreateCollectionAsync(new CollectionCreationOptions {
                Name = sample.TryGetProperty("name", out var name) ? name.GetString()! : "Collection",
                IsLocked = sample.TryGetProperty("isLocked", out var isLocked) && isLocked.GetBoolean(),
                ProviderIds = sample.TryGetProperty("providerIds", out var providerIds) ? JsonSerializer.Deserialize<Dictionary<string, string>>(providerIds.GetRawText())! : [],
                ItemIdList = requested.Select(id => id.ToString("N")).ToArray(), ParentId = Id(999), UserIds = [Id(998)] }); break;
            case "add": await manager.AddToCollectionAsync(collectionId, requested); break;
            case "remove": await manager.RemoveFromCollectionAsync(collectionId, requested); break;
            case "ensure": foundFolder = await manager.GetCollectionsFolder(sample.TryGetProperty("createIfNeeded", out var createNeeded) && createNeeded.GetBoolean()) is not null; break;
        }
    } catch (Exception error) { exception = error.GetType().Name; }
    results.Add(new { key, failed = exception != null, exception, foundFolder, calls, pathQueries,
        collection = collection != null && collection.LinkedChildren != null ? Project(collection) : null,
        timestamps = collection == null ? null : new { created = collection.DateCreated.ToString("O"), modified = collection.DateModified.ToString("O") },
        directories = Directory.EnumerateDirectories(program, "*", SearchOption.AllDirectories).Select(filename => Path.GetRelativePath(program, filename)).Order(StringComparer.Ordinal).ToArray() });
}
var assemblies = new[] { typeof(CollectionManager).Assembly, typeof(BoxSet).Assembly, typeof(ManagedFileSystem).Assembly, typeof(object).Assembly }.Distinct()
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[2], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    actualCollectionManager = true, actualBoxSet = true, realDirectories = true, libraryProviderPersistenceControlled = true, results, assemblies }, json));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class ControlledRoot : AggregateFolder {
    public BaseItem[] LiveChildren = [];
    public Action<string, object?> Trace = null!;
    public override IEnumerable<BaseItem> Children { get => LiveChildren; set { if (value is null) Trace("root-invalidate", null); else LiveChildren = value.ToArray(); } }
}
