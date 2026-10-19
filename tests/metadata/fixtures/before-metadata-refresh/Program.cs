// Records actual refresh hooks, season parsing and warmed mapper sort caches.
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Naming.Common;
using Emby.Naming.TV;
using Emby.Server.Implementations.Library;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.BaseItemManager;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Providers;
using MediaBrowser.Providers.Manager;
using MediaBrowser.Providers.Movies;
using MediaBrowser.Providers.TV;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
BaseItem.ConfigurationManager = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
BaseItem.Logger = NullLogger<BaseItem>.Instance;
Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
var results = new List<object>();
foreach (var scenario in input.EnumerateArray()) {
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var proxy = (LibraryProxy)(object)library;
    proxy.Real = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    typeof(LibraryManager).GetField("_namingOptions", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(proxy.Real, new NamingOptions());
    BaseItem.LibraryManager = library;
    var fileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    BaseItem.FileSystem = fileSystem;
    var fs = (FileSystemProxy)(object)fileSystem;
    if (scenario.TryGetProperty("file", out var file)) fs.File = JsonSerializer.Deserialize<FileSystemMetadata>(file.GetRawText(), json)!;
    string? exception = null;
    var mode = scenario.GetProperty("mode").GetString();
    object? result = null;
    try {
        if (mode == "seasonPath") {
            result = SeasonPathParser.Parse(scenario.GetProperty("path").GetString()!,
                scenario.TryGetProperty("parentPath", out var parentPath) ? parentPath.GetString() : null,
                !scenario.TryGetProperty("aliases", out var aliases) || aliases.GetBoolean(),
                !scenario.TryGetProperty("numeric", out var numeric) || numeric.GetBoolean());
        } else {
            var definition = scenario.GetProperty("item");
            var type = BaseItemMapper.GetType(definition.GetProperty("Type").GetString()!)!;
            var item = (BaseItem)Activator.CreateInstance(type)!;
            foreach (var field in definition.EnumerateObject()) if (field.Name != "Type") Projection.Bind(item, field.Name, field.Value, json);
            if (item is Folder folder) folder.Children = [];
            if (scenario.TryGetProperty("parent", out var parentDefinition)) {
                var parent = (Folder)Activator.CreateInstance(BaseItemMapper.GetType(parentDefinition.GetProperty("Type").GetString()!)!)!;
                foreach (var field in parentDefinition.EnumerateObject()) if (field.Name != "Type") Projection.Bind(parent, field.Name, field.Value, json);
                parent.Children = []; proxy.Items[parent.Id] = parent; item.SetParent(parent);
            }
            if (mode == "before") {
                if (scenario.TryGetProperty("warm", out var warm) && warm.GetBoolean()) _ = item.SortName;
                var initialCache = Projection.Cache(item);
                var changed = item.BeforeMetadataRefresh(scenario.TryGetProperty("replace", out var replace) && replace.GetBoolean());
                var clearedCache = Projection.Cache(item);
                result = new { changed, initialCache, clearedCache, item = Projection.Capture(item) };
            } else if (mode == "requires") {
                result = new { requiresRefresh = item.RequiresRefresh(), fileCalls = fs.Calls };
            } else if (mode == "cache") {
                var steps = new List<object>();
                foreach (var action in scenario.GetProperty("actions").EnumerateArray()) {
                    var operation = action.GetProperty("op").GetString();
                    object? value = null;
                    if (operation == "read") value = item.SortName;
                    else if (operation == "change") foreach (var field in action.GetProperty("fields").EnumerateObject()) Projection.Bind(item, field.Name, field.Value, json);
                    else if (operation == "before") value = item.BeforeMetadataRefresh(false);
                    else if (operation == "after") item.AfterMetadataRefresh();
                    else if (operation == "map") {
                        var row = BaseItemMapper.Map(item, null!);
                        value = new { row.Name, row.ForcedSortName, row.SortName, row.IndexNumber, row.ParentIndexNumber };
                    } else throw new NotSupportedException(operation);
                    steps.Add(new { op = operation, value, cache = Projection.Cache(item) });
                }
                result = new { steps };
            } else if (mode == "refresh" || mode == "episodeRefresh") {
                var options = new MetadataRefreshOptions((IDirectoryService)null!) {
                    MetadataRefreshMode = Enum.Parse<MetadataRefreshMode>(scenario.GetProperty("metadataMode").GetString()!),
                    ImageRefreshMode = MetadataRefreshMode.None,
                    ForceSave = scenario.TryGetProperty("force", out var force) && force.GetBoolean(),
                    ReplaceAllMetadata = scenario.TryGetProperty("replace", out var replace) && replace.GetBoolean()
                };
                var remote = new LookupProvider { Changed = !scenario.TryGetProperty("providerChanged", out var changed) || changed.GetBoolean(),
                    Cancel = scenario.TryGetProperty("cancel", out var cancel) && cancel.GetBoolean() };
                var indexProvider = new IndexProvider { Cancel = scenario.TryGetProperty("cancel", out var indexCancel) && indexCancel.GetBoolean(),
                    SameName = scenario.TryGetProperty("sameName", out var sameName) && sameName.GetBoolean(),
                    Update = (ItemUpdateType)(scenario.TryGetProperty("providerUpdate", out var providerUpdate) ? providerUpdate.GetInt32() : 1) };
                using var providers = new ProviderManager(null!, null!, BaseItem.ConfigurationManager, null!, NullLogger<ProviderManager>.Instance,
                    fileSystem, null!, library, DispatchProxy.Create<IBaseItemManager, BaseItemManagerProxy>(), null!, null!, null!, null!);
                providers.AddParts([], [], scenario.TryGetProperty("noProvider", out var noProvider) && noProvider.GetBoolean() ? [] : mode == "episodeRefresh" ? [indexProvider] : [remote], [], [], []);
                IMetadataService service = mode == "episodeRefresh"
                    ? new EpisodeMetadataService(BaseItem.ConfigurationManager, NullLogger<EpisodeMetadataService>.Instance, providers,
                        fileSystem, library, null!, DispatchProxy.Create<IItemRepository, RepositoryProxy>())
                    : new MovieMetadataService(BaseItem.ConfigurationManager, NullLogger<MovieMetadataService>.Instance, providers,
                        fileSystem, library, null!, DispatchProxy.Create<IItemRepository, RepositoryProxy>());
                var initialStamp = item.DateLastRefreshed;
                int? updateType = null;
                try { updateType = (int)await service.RefreshMetadata(item, options, CancellationToken.None); }
                catch (OperationCanceledException) when (remote.Cancel || indexProvider.Cancel) { exception = nameof(OperationCanceledException); }
                result = new { updateType, calls = proxy.Calls, lookups = remote.Lookups, providerSortReads = indexProvider.SortReads,
                    reattachments = proxy.Reattachments, stampChanged = item.DateLastRefreshed != initialStamp,
                    cacheAfterRefresh = Projection.Cache(item), item = Projection.Capture(item) };
            } else throw new NotSupportedException(mode);
        }
        if (scenario.TryGetProperty("expectException", out _) && exception is null) throw new InvalidOperationException("Expected native exception was not raised.");
    } catch (Exception error) when (scenario.TryGetProperty("expectException", out var expected) && error.GetType().Name == expected.GetString()) {
        exception = error.GetType().Name;
    }
    results.Add(new { name = scenario.GetProperty("name").GetString(), result, exception });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual BaseItem/Movie/MusicVideo/Trailer/Series/Season BeforeMetadataRefresh, BaseItem.AfterMetadataRefresh, SeasonPathParser and BaseItemMapper warmed-cache projections. Actual LibraryManager.ParseName uses native NamingOptions. Actual pathless MovieMetadataService and EpisodeMetadataService with ProviderManager record refresh gates, warmed provider reads, first-save order and cancellation. Library items/options, file metadata, enabled remote/custom providers, episode-number no-change callback and repository/reattachment callbacks are controlled. Episode filename parsing, embedded episode probing, rebasing by-name state paths, specialized service After hooks, native SQL writes, NFO and media file operations are excluded."
}, json));

public static class Projection {
    private static readonly FieldInfo SortCache = typeof(BaseItem).GetField("_sortName", BindingFlags.Instance | BindingFlags.NonPublic)!;
    public static object? Cache(BaseItem item) => SortCache.GetValue(item);
    public static void Bind(BaseItem item, string name, JsonElement value, JsonSerializerOptions json) {
        var property = item.GetType().GetProperty(name)!;
        if (property is null || !property.CanWrite) throw new NotSupportedException(name);
        property.SetValue(item, JsonSerializer.Deserialize(value.GetRawText(), property.PropertyType, json));
    }
    public static object Capture(BaseItem item) => new { item.Name, item.Path, item.ProductionYear, item.IndexNumber, item.ParentIndexNumber, item.ForcedSortName, item.SortName };
}
public class ConfigurationProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_Configuration" => new ServerConfiguration { MetadataCountryCode = "US" },
        "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
public class LibraryProxy : DispatchProxy {
    public LibraryManager Real = null!; public Dictionary<Guid, BaseItem> Items = []; public List<object> Calls = []; public int Reattachments;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "ParseName") return Real.ParseName((string)args![0]!);
        if (method.Name == "GetSeasonNumberFromPath") return SeasonPathParser.Parse((string)args![0]!, Items.GetValueOrDefault((Guid)args[1]!)?.ContainingFolderPath, true, true).SeasonNumber;
        if (method.Name == "GetItemById") return Items.GetValueOrDefault((Guid)args![0]!);
        if (method.Name == "GetLibraryOptions") return new LibraryOptions { MetadataCountryCode = null };
        if (method.Name == "GetCollectionFolders") return new List<Folder>();
        if (method.Name == "GetLocalAlternateVersionIds") return Array.Empty<Guid>();
        if (method.Name == "FillMissingEpisodeNumbersFromPath") return false;
        if (method.Name == "ReattachUserDataAsync") { Reattachments++; return Task.CompletedTask; }
        if (method.Name == "UpdateItemAsync") { Calls.Add(new { item = Projection.Capture((BaseItem)args![0]!), updateReason = (int)args[2]! }); return Task.CompletedTask; }
        throw new NotSupportedException(method.Name);
    }
}
public class LookupProvider : IRemoteMetadataProvider<Movie, MovieInfo>, IHasItemChangeMonitor {
    public string Name => "Controlled empty lookup"; public bool Changed, Cancel; public List<object> Lookups = [];
    public bool HasChanged(BaseItem item, IDirectoryService directoryService) => Changed;
    public Task<MetadataResult<Movie>> GetMetadata(MovieInfo info, CancellationToken cancellationToken) {
        Lookups.Add(new { info.Name, info.Year });
        if (Cancel) throw new OperationCanceledException("Injected cancellation after BeforeMetadataRefresh");
        return Task.FromResult(new MetadataResult<Movie> { HasMetadata = false });
    }
    public Task<IEnumerable<RemoteSearchResult>> GetSearchResults(MovieInfo info, CancellationToken cancellationToken) => throw new NotSupportedException();
    public Task<HttpResponseMessage> GetImageResponse(string url, CancellationToken cancellationToken) => throw new NotSupportedException();
}
public class IndexProvider : ICustomMetadataProvider<Episode>, IHasItemChangeMonitor {
    public string Name => "Controlled warm index"; public bool Cancel, SameName; public ItemUpdateType Update; public List<string?> SortReads = [];
    public bool HasChanged(BaseItem item, IDirectoryService directoryService) => true;
    public Task<ItemUpdateType> FetchAsync(Episode item, MetadataRefreshOptions options, CancellationToken cancellationToken) {
        SortReads.Add(item.SortName); item.IndexNumber = 9;
        if (SameName) item.Name = item.Name;
        if (Cancel) throw new OperationCanceledException("Injected cancellation after a warmed index mutation");
        return Task.FromResult(Update);
    }
}
public class FileSystemProxy : DispatchProxy {
    public FileSystemMetadata File = new(); public int Calls;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "GetFileSystemInfo") { Calls++; return File; }
        throw new NotSupportedException(method.Name);
    }
}
public class BaseItemManagerProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "IsMetadataFetcherEnabled" ? true : throw new NotSupportedException(method.Name);
}
public class RepositoryProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "ItemExistsAsync" ? Task.FromResult(true) : throw new NotSupportedException(method.Name);
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}
