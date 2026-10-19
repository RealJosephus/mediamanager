// Executes the pinned services' actual metadata child selection and TV sorting.
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Sorting;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Sorting;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.BoxSets;
using MediaBrowser.Providers.Folders;
using MediaBrowser.Providers.Music;
using MediaBrowser.Providers.TV;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var scenario in input.EnumerateArray()) {
    var config = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    ((ConfigurationProxy)(object)config).Data.DisplaySpecialsWithinSeasons = !scenario.TryGetProperty("displaySpecials", out var specials) || specials.GetBoolean();
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.FileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var proxy = (LibraryProxy)(object)library; BaseItem.LibraryManager = library;
    var real = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    typeof(LibraryManager).GetProperty("Comparers", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(real, new IBaseItemComparer[] { new SortNameComparer(), new AiredEpisodeOrderComparer() });
    proxy.Real = real;
    foreach (var definition in scenario.GetProperty("items").EnumerateArray()) {
        BaseItem item = definition.GetProperty("type").GetString() switch {
            "Folder" => new Folder(), "Series" => new Series(), "Season" => new Season(), "Episode" => new Episode(),
            "MusicAlbum" => new MusicAlbum(), "MusicArtist" => new MusicArtist(), "Audio" => new Audio(), "MusicVideo" => new MusicVideo(),
            "BoxSet" => new BoxSet(), "Movie" => new Movie(), "AudioBook" => new AudioBook(), _ => throw new NotSupportedException()
        };
        foreach (var entry in definition.EnumerateObject()) {
            if (new[] { "type", "key", "parent", "links", "ancestors" }.Contains(entry.Name)) continue;
            var property = item.GetType().GetProperty(entry.Name)!;
            if (property is null || !property.CanWrite) throw new NotSupportedException(entry.Name);
            property.SetValue(item, JsonSerializer.Deserialize(entry.Value.GetRawText(), property.PropertyType, json));
        }
        if (item is Folder folder) folder.Children = [];
        proxy.Items.Add(definition.GetProperty("key").GetString()!, item);
    }
    foreach (var definition in scenario.GetProperty("items").EnumerateArray()) {
        var item = proxy.Items[definition.GetProperty("key").GetString()!];
        if (definition.TryGetProperty("parent", out var parent)) {
            var folder = (Folder)proxy.Items[parent.GetString()!]; item.SetParent(folder); folder.Children = folder.Children.Append(item).ToArray();
        }
        if (item is Folder container && definition.TryGetProperty("links", out var links)) container.LinkedChildren = links.EnumerateArray()
            .Select(value => new LinkedChild { ItemId = proxy.Items[value.GetString()!].Id }).ToArray();
    }
    proxy.QueryItems = scenario.TryGetProperty("queryItems", out var queryItems) ? queryItems.EnumerateArray().Select(value => proxy.Items[value.GetString()!]).ToArray() : [];
    var target = proxy.Items[scenario.GetProperty("target").GetString()!];
    object service = target switch {
        Season => new SeasonMetadataService(config, NullLogger<SeasonMetadataService>.Instance, null!, null!, library, null!, null!),
        Series => new SeriesMetadataService(config, NullLogger<SeriesMetadataService>.Instance, null!, null!, library, null!, null!, null!),
        MusicAlbum => new AlbumMetadataService(config, NullLogger<AlbumMetadataService>.Instance, null!, null!, library, null!, null!),
        MusicArtist => new ArtistMetadataService(config, NullLogger<ArtistMetadataService>.Instance, null!, null!, library, null!, null!),
        BoxSet => new BoxSetMetadataService(config, NullLogger<BoxSetMetadataService>.Instance, null!, null!, library, null!, null!),
        _ => new FolderMetadataService(config, NullLogger<FolderMetadataService>.Instance, null!, null!, library, null!, null!)
    };
    var children = (IReadOnlyList<BaseItem>)service.GetType().GetMethod("GetChildrenForMetadataUpdates", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(service, [target])!;
    results.Add(new { name = scenario.GetProperty("name").GetString(), children = children.Select(item => proxy.Items.First(pair => pair.Value.Id == item.Id).Key), queries = proxy.Queries });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual metadata GetChildrenForMetadataUpdates, Folder recursive/linked traversal, Season.GetEpisodes, Series filtering, typed Episode.Season and LibraryManager.Sort with native comparers. Physical cached child lists, ItemId lookup and repository query result arrays are explicit controls. Captured queries are native, but EF translation, ownership/repository filters, ancestors and artist relation lookups are not executed by this oracle."
}, json));

public class ConfigurationProxy : DispatchProxy {
    public ServerConfiguration Data = new();
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "get_Configuration" ? Data : throw new NotSupportedException(method.Name);
}
public class LibraryProxy : DispatchProxy {
    public Dictionary<string, BaseItem> Items = []; public BaseItem[] QueryItems = []; public List<object> Queries = []; public LibraryManager Real = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "GetItemById") return Items.Values.FirstOrDefault(item => item.Id == (Guid)args![0]!);
        if (method.Name == "GetItemList") {
            var query = (InternalItemsQuery)args![0]!;
            if (query.ItemIds.Length > 0) return Items.Values.Where(item => query.ItemIds.Contains(item.Id)).ToArray();
            Queries.Add(new { query.SeriesPresentationUniqueKey, query.AncestorWithPresentationUniqueKey, query.IsFolder,
                query.Recursive, query.IncludeItemTypes, query.ArtistIds, query.IsMissing });
            return QueryItems;
        }
        if (method.Name == "Sort") return Real.Sort((IEnumerable<BaseItem>)args![0]!, null, (IEnumerable<ItemSortBy>)args[2]!, (SortOrder)args[3]!);
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        throw new NotSupportedException(method.Name);
    }
}
public class FileSystemProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "IsPathFile"
        ? !((string)args![0]!).Contains("://", StringComparison.Ordinal) || ((string)args[0]!).StartsWith("file://", StringComparison.OrdinalIgnoreCase)
        : throw new NotSupportedException(method.Name);
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}
