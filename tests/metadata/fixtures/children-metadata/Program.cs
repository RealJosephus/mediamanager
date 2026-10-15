// Executes the pinned metadata services' child-aggregation methods.
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Localization;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.BoxSets;
using MediaBrowser.Providers.Folders;
using MediaBrowser.Providers.Music;
using MediaBrowser.Providers.TV;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var config = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
BaseItem.ConfigurationManager = config;
BaseItem.Logger = NullLogger<BaseItem>.Instance;
var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
BaseItem.LibraryManager = library;
Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
BaseItem.FileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
var localization = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
await localization.LoadAll();
BaseItem.LocalizationManager = localization;
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var scenario in input.EnumerateArray()) {
    var target = CreateItem(scenario.GetProperty("item"));
    ((LibraryProxy)(object)library).Options.MetadataCountryCode = scenario.TryGetProperty("country", out var country) ? country.GetString() : "US";
    var children = scenario.GetProperty("children").EnumerateArray().Select(CreateItem).ToArray();
    object service = target switch {
        Season => new SeasonMetadataService(config, NullLogger<SeasonMetadataService>.Instance, null!, null!, library, null!, null!),
        Series => new SeriesMetadataService(config, NullLogger<SeriesMetadataService>.Instance, null!, null!, library, localization, null!, null!),
        MusicAlbum => new AlbumMetadataService(config, NullLogger<AlbumMetadataService>.Instance, null!, null!, library, null!, null!),
        MusicArtist => new ArtistMetadataService(config, NullLogger<ArtistMetadataService>.Instance, null!, null!, library, null!, null!),
        BoxSet => new BoxSetMetadataService(config, NullLogger<BoxSetMetadataService>.Instance, null!, null!, library, null!, null!),
        _ => new FolderMetadataService(config, NullLogger<FolderMetadataService>.Instance, null!, null!, library, null!, null!)
    };
    var full = scenario.GetProperty("full").GetBoolean();
    var current = (ItemUpdateType)scenario.GetProperty("currentUpdateType").GetInt32();
    var enabled = (bool)service.GetType().GetMethod("EnableUpdateMetadataFromChildren", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(service, [target, full, current])!;
    var update = current;
    string? exception = null;
    try {
        if (enabled) update = (ItemUpdateType)service.GetType().GetMethod("UpdateMetadataFromChildren", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(service, [target, children, full, current])!;
        if (scenario.TryGetProperty("expectException", out _)) throw new InvalidOperationException("Expected native exception was not raised.");
    } catch (TargetInvocationException error) when (scenario.TryGetProperty("expectException", out var expected) && error.InnerException?.GetType().Name == expected.GetString()) {
        exception = error.InnerException.GetType().Name;
    }
    var album = target as MusicAlbum;
    results.Add(new { name = scenario.GetProperty("name").GetString(), enabled, updateType = (int)update, exception, result = new {
        target.Name, PremiereDate = target.PremiereDate?.ToString("O"), target.ProductionYear, target.Genres, target.Studios,
        target.OfficialRating, target.RunTimeTicks, target.IsVirtualItem, DateLastMediaAdded = ((Folder)target).DateLastMediaAdded?.ToString("O"),
        Artists = album?.Artists, AlbumArtists = album?.AlbumArtists, target.ProviderIds, target.RemoteTrailers
    } });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    culture = CultureInfo.CurrentCulture.Name,
    boundary = "Actual EnableUpdateMetadataFromChildren and UpdateMetadataFromChildren, including Album/Season overrides and real LocalizationManager resources. Ordered child arrays and library options are explicit controlled inputs. Child selection, BeforeSave, file operations, repository persistence, providers and AfterMetadataRefresh are excluded."
}, json));

BaseItem CreateItem(JsonElement definition) {
    var type = definition.GetProperty("type").GetString() switch {
        "Folder" => typeof(Folder), "Series" => typeof(Series), "Season" => typeof(Season), "Episode" => typeof(Episode),
        "MusicAlbum" => typeof(MusicAlbum), "MusicArtist" => typeof(MusicArtist), "Audio" => typeof(Audio), "MusicVideo" => typeof(MusicVideo),
        "BoxSet" => typeof(BoxSet), "Movie" => typeof(Movie), _ => throw new NotSupportedException()
    };
    var item = (BaseItem)Activator.CreateInstance(type)!;
    // Native entities mark repository fields JsonIgnore. Bind the explicit
    // control input through setters rather than silently dropping those fields.
    foreach (var entry in definition.EnumerateObject()) {
        if (entry.Name == "type") continue;
        var property = type.GetProperty(entry.Name)!;
        if (property is null || !property.CanWrite) throw new NotSupportedException(entry.Name);
        property.SetValue(item, JsonSerializer.Deserialize(entry.Value.GetRawText(), property.PropertyType, json));
    }
    return item;
}
public class ConfigurationProxy : DispatchProxy {
    public ServerConfiguration Data = new();
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_Configuration" => Data, "add_ConfigurationUpdated" => null, "remove_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
public class LibraryProxy : DispatchProxy {
    public LibraryOptions Options = new();
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetLibraryOptions" => Options, "GetCollectionFolders" => new List<Folder>(), "GetItemById" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}
public class FileSystemProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "IsPathFile"
        ? !((string)args![0]!).Contains("://", StringComparison.Ordinal) || ((string)args[0]!).StartsWith("file://", StringComparison.OrdinalIgnoreCase)
        : throw new NotSupportedException(method.Name);
}
