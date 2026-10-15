// Actual frozen BaseItem.RefreshMetadata and Video owned dispatch; effects are controlled.
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Providers;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var sample in input.EnumerateArray())
{
    var items = new Dictionary<string, BaseItem>();
    foreach (var definition in sample.GetProperty("items").EnumerateArray())
    {
        BaseItem item = definition.GetProperty("type").GetString() switch
        {
            "Folder" => new Folder(), "Movie" => new Movie(), "Trailer" => new Trailer(),
            "Audio" => new Audio(), _ => new Video()
        };
        foreach (var field in definition.EnumerateObject())
        {
            if (new[] { "key", "type", "parent", "owner", "primary" }.Contains(field.Name)) continue;
            var property = item.GetType().GetProperty(field.Name)!;
            property.SetValue(item, JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, json));
        }
        items.Add(definition.GetProperty("key").GetString()!, item);
    }
    foreach (var definition in sample.GetProperty("items").EnumerateArray())
    {
        var item = items[definition.GetProperty("key").GetString()!];
        if (definition.TryGetProperty("parent", out var parent)) item.SetParent((Folder)items[parent.GetString()!]);
        if (definition.TryGetProperty("owner", out var ownerKey)) item.OwnerId = items[ownerKey.GetString()!].Id;
        if (definition.TryGetProperty("primary", out var primary)) ((Video)item).SetPrimaryVersionId(items[primary.GetString()!].Id);
    }
    var owner = (Movie)items["owner"];
    var links = sample.GetProperty("links").EnumerateArray().Select(key => items[key.GetString()!].Id).ToList();
    var found = sample.GetProperty("foundExtras").EnumerateArray().Select(key => items[key.GetString()!]).ToArray();
    var present = sample.GetProperty("presentFiles").EnumerateArray().Select(value => value.GetString()!).ToHashSet();
    var calls = new List<object>();
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, values) => method.Name == "GetPathProtocol"
        ? values![0] is string path && !string.IsNullOrEmpty(path) ? MediaProtocol.File : (MediaProtocol?)null
        : throw new NotSupportedException(method.Name));
    BaseItem.FileSystem = Stub.Make<IFileSystem>((method, values) => method.Name == "FileExists"
        ? present.Contains((string)values![0]!) : throw new NotSupportedException(method.Name));
    var directory = Stub.Make<IDirectoryService>((method, _) => method.Name == "GetFileSystemEntries"
        ? Array.Empty<FileSystemMetadata>() : throw new NotSupportedException(method.Name));
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) =>
    {
        switch (method.Name)
        {
            case "GetItemById": return items.Values.FirstOrDefault(item => item.Id == (Guid)values![0]!);
            case "GetNewItemId":
                return items.Values.First(item => item.Path == (string)values![0]! && item.GetType() == (Type)values[1]!).Id;
            case "GetLocalAlternateVersionIds": return ((Video)values![0]!).Id == owner.Id ? links.ToArray() : Array.Empty<Guid>();
            case "GetItemList":
                var query = (InternalItemsQuery)values![0]!;
                return items.Values.Where(item => (query.OwnerIds.Length == 0 || query.OwnerIds.Contains(item.OwnerId))
                    && (query.ItemIds.Length == 0 || query.ItemIds.Contains(item.Id))).ToArray();
            case "FindExtras":
                if (sample.TryGetProperty("rename", out var rename)) items[rename.GetProperty("key").GetString()!].Name = rename.GetProperty("name").GetString();
                return found;
            case "UpdateItemAsync":
                ((CancellationToken)values![3]!).ThrowIfCancellationRequested();
                calls.Add(new { action = "update", key = Key((BaseItem)values[0]!), item = Project((BaseItem)values[0]!), reason = (int)(ItemUpdateType)values[2]! });
                return Task.CompletedTask;
            case "UpsertLinkedChild":
                var childId = (Guid)values![1]!;
                calls.Add(new { action = "link", parent = Key(items.Values.First(item => item.Id == (Guid)values[0]!)),
                    child = Key(items.Values.First(item => item.Id == childId)), childType = Convert.ToInt32(values[2]) });
                if (!links.Contains(childId)) links.Add(childId);
                return null;
            case "DeleteItem":
                var deleted = (BaseItem)values![0]!;
                calls.Add(new { action = "delete", key = Key(deleted), deleteFileLocation = ((DeleteOptions)values[1]!).DeleteFileLocation });
                items.Remove(Key(deleted)); links.Remove(deleted.Id);
                return null;
            case "UpdateImagesAsync": calls.Add(new { action = "images", key = Key((BaseItem)values![0]!) }); return Task.CompletedTask;
            default: throw new NotSupportedException(method.Name);
        }
    });
    BaseItem.ProviderManager = Stub.Make<IProviderManager>((method, values) =>
    {
        if (method.Name != "RefreshSingleItem") throw new NotSupportedException(method.Name);
        var item = (BaseItem)values![0]!;
        var options = (MetadataRefreshOptions)values[1]!;
        var token = (CancellationToken)values[2]!;
        var key = Key(item);
        calls.Add(new { action = "refresh", key, item = Project(item), options = new { options.ForceSave, options.MetadataRefreshMode,
            options.ImageRefreshMode, options.ReplaceAllMetadata, hasSearchResult = options.SearchResult is not null }, cancellationRequested = token.IsCancellationRequested });
        if (sample.TryGetProperty("failRefresh", out var fail) && fail.GetString() == key) throw new IOException("Injected child provider failure");
        token.ThrowIfCancellationRequested();
        return Task.FromResult(ItemUpdateType.None);
    });
    var configured = sample.GetProperty("options");
    var options = new MetadataRefreshOptions(directory)
    {
        MetadataRefreshMode = Enum.Parse<MetadataRefreshMode>(configured.GetProperty("MetadataRefreshMode").GetString()!),
        ImageRefreshMode = MetadataRefreshMode.None,
        ForceSave = configured.TryGetProperty("ForceSave", out var force) && force.GetBoolean(),
        ReplaceAllMetadata = configured.TryGetProperty("ReplaceAllMetadata", out var replace) && replace.GetBoolean(),
        SearchResult = new RemoteSearchResult { Name = "Owner search", SearchProviderName = "Frozen" }
    };
    using var cancellation = new CancellationTokenSource();
    if (sample.TryGetProperty("cancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
    string? exception = null;
    try { await owner.RefreshMetadata(options, cancellation.Token); }
    catch (Exception error) { exception = error.GetType().Name; }
    results.Add(new { name = sample.GetProperty("name").GetString(), exception, calls,
        items = items.Select(pair => new { key = pair.Key, item = Project(pair.Value) }), links = links.Select(id => Key(items.Values.First(item => item.Id == id))) });

    string Key(BaseItem item) => items.First(pair => pair.Value.Id == item.Id).Key;
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new
{
    actualFrozenOwnedItemLifecycle = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    assemblies = new[] { typeof(BaseItem).Assembly }.Select(assembly => new { name = assembly.GetName().Name,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }),
    results,
    scope = "Actual frozen BaseItem.RefreshMetadata and Video.RefreshedOwnedItems dispatch, native date/title inheritance, mixed-version imports, PrimaryVersionId repair, link/count rules, missing path cleanup and owned-error boundary. Existing typed cached entities, FindExtras results/rename, path identity/existence, provider refresh, repository/image/link/delete effects are controls. No native resolution, SQL, external provider/probe/image execution or full library acceptance."
}, json) + "\n");

static object Project(BaseItem item) => new
{
    item.Name, item.Path, item.OwnerId, item.ParentId, item.IsInMixedFolder, item.ExtraType, item.Genres,
    item.Studios, item.Overview, item.ProductionYear, item.PremiereDate,
    PrimaryVersionId = (item as Video)?.PrimaryVersionId,
    AdditionalParts = (item as Video)?.AdditionalParts,
    LocalAlternateVersions = (item as Video)?.LocalAlternateVersions
};
public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    {
        var proxy = Create<T, Stub>();
        ((Stub)(object)proxy).Handler = handler;
        return proxy;
    }
}
