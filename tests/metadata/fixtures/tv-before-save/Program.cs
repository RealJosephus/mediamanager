// Executes the pinned EpisodeMetadataService/SeasonMetadataService BeforeSaveInternal.
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.TV;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions(JsonDefaults.Options) { PropertyNameCaseInsensitive = true, WriteIndented = true };
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var scenario in input.EnumerateArray()) {
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var proxy = (LibraryProxy)(object)library;
    if (scenario.TryGetProperty("specialName", out var specialName)) proxy.Options.SeasonZeroDisplayName = specialName.GetString();
    BaseItem.LibraryManager = library;
    BaseItem.ConfigurationManager = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    var byName = new Dictionary<string, BaseItem>();
    foreach (var definition in scenario.GetProperty("items").EnumerateArray()) {
        var key = definition.GetProperty("key").GetString()!;
        BaseItem item = definition.GetProperty("type").GetString() switch {
            "Series" => new Series { Children = [] }, "Season" => new Season { Children = [] }, "Episode" => new Episode(),
            "Folder" => new Folder { Children = [] }, _ => throw new NotSupportedException()
        };
        item.Id = Guid.Parse(definition.GetProperty("Id").GetString()!);
        item.Name = definition.TryGetProperty("Name", out var name) ? name.GetString() : key;
        item.Path = definition.TryGetProperty("Path", out var path) ? path.GetString() : null;
        if (definition.TryGetProperty("PresentationUniqueKey", out var presentation)) item.PresentationUniqueKey = presentation.GetString();
        if (definition.TryGetProperty("IndexNumber", out var number)) item.IndexNumber = number.ValueKind == JsonValueKind.Null ? null : number.GetInt32();
        if (definition.TryGetProperty("IsLocked", out var locked)) item.IsLocked = locked.GetBoolean();
        if (definition.TryGetProperty("LockedFields", out var fields)) item.LockedFields = fields.EnumerateArray().Select(value => Enum.Parse<MetadataField>(value.GetString()!)).ToArray();
        if (item is IHasSeries tv) {
            tv.SeriesId = definition.TryGetProperty("SeriesId", out var seriesId) && seriesId.ValueKind != JsonValueKind.Null ? Guid.Parse(seriesId.GetString()!) : Guid.Empty;
            tv.SeriesName = definition.TryGetProperty("SeriesName", out var seriesName) ? seriesName.GetString() : null;
            tv.SeriesPresentationUniqueKey = definition.TryGetProperty("SeriesPresentationUniqueKey", out var seriesKey) ? seriesKey.GetString() : null;
        }
        if (item is Episode episode) {
            episode.SeasonId = definition.TryGetProperty("SeasonId", out var seasonId) && seasonId.ValueKind != JsonValueKind.Null ? Guid.Parse(seasonId.GetString()!) : Guid.Empty;
            episode.SeasonName = definition.TryGetProperty("SeasonName", out var seasonName) ? seasonName.GetString() : null;
            episode.ParentIndexNumber = definition.TryGetProperty("ParentIndexNumber", out var parentNumber) && parentNumber.ValueKind != JsonValueKind.Null ? parentNumber.GetInt32() : null;
            episode.IndexNumberEnd = definition.TryGetProperty("IndexNumberEnd", out var end) && end.ValueKind != JsonValueKind.Null ? end.GetInt32() : null;
        }
        byName.Add(key, item); proxy.Items.Add(item.Id, item);
    }
    foreach (var definition in scenario.GetProperty("items").EnumerateArray()) if (definition.TryGetProperty("parent", out var parent)) {
        var item = byName[definition.GetProperty("key").GetString()!];
        var folder = (Folder)byName[parent.GetString()!];
        item.SetParent(folder); folder.Children = folder.Children.Append(item).ToList();
    }
    var target = byName[scenario.GetProperty("target").GetString()!];
    var fs = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    object service = target is Episode
        ? new EpisodeMetadataService(BaseItem.ConfigurationManager, NullLogger<EpisodeMetadataService>.Instance, null!, fs, library, null!, null!)
        : new SeasonMetadataService(BaseItem.ConfigurationManager, NullLogger<SeasonMetadataService>.Instance, null!, fs, library, null!, null!);
    var method = service.GetType().GetMethod("BeforeSaveInternal", BindingFlags.Instance | BindingFlags.NonPublic)!;
    var update = (ItemUpdateType)method.Invoke(service, [target, false, ItemUpdateType.None])!;
    var hasSeries = (IHasSeries)target;
    var result = new { target.Name, target.PresentationUniqueKey, target.IndexNumber, IndexNumberEnd = (target as Episode)?.IndexNumberEnd,
        hasSeries.SeriesId, hasSeries.SeriesName, hasSeries.SeriesPresentationUniqueKey,
        SeasonId = target is Episode episodeTarget ? episodeTarget.SeasonId : (Guid?)null, SeasonName = (target as Episode)?.SeasonName };
    results.Add(new { name = scenario.GetProperty("name").GetString(), type = target.GetType().Name, updateType = (int)update, result });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    sourceBoundary = "Actual pinned Episode/Season BeforeSaveInternal with isFullRefresh=false/currentUpdateType=None. Actual entity parent and typed Series/Season lookups; library item lookup and library options are controlled callbacks. Filesystem reports missing; child aggregation, BeforeMetadataRefresh, providers, repository writes, images and AfterMetadataRefresh are excluded.",
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    assemblies = new[] { typeof(EpisodeMetadataService).Assembly, typeof(Season).Assembly }
        .Select(assembly => new { path = assembly.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }) }, json));

public class LibraryProxy : DispatchProxy {
    public Dictionary<Guid, BaseItem> Items = [];
    public LibraryOptions Options = new();
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "GetItemById") return Items.GetValueOrDefault((Guid)args![0]!);
        if (method.Name == "GetLibraryOptions") return Options;
        throw new NotSupportedException(method.Name);
    }
}
public class ConfigurationProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "get_Configuration" ? new ServerConfiguration() : throw new NotSupportedException(method.Name);
}
public class FileSystemProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetFileSystemInfo" ? new FileSystemMetadata { Exists = false } : throw new NotSupportedException(method.Name);
}
