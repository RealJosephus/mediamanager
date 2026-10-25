using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using MediaBrowser.Controller.BaseItemManager;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Providers;
using MediaBrowser.Providers.Manager;
using MediaBrowser.Providers.Movies;
using MediaBrowser.Providers.TV;
using Microsoft.Extensions.Logging.Abstractions;

var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, WriteIndented = true };
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
BaseItem.ConfigurationManager = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
BaseItem.Logger = NullLogger<BaseItem>.Instance;
Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, LookupRecordingsProxy>();
var results = new List<object>();
foreach (var scenario in input.EnumerateArray())
{
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    BaseItem.LibraryManager = library;
    var fs = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    BaseItem.FileSystem = fs;
    var provider = new LookupProvider();
    using var providers = new ProviderManager(null!, null!, BaseItem.ConfigurationManager, null!, NullLogger<ProviderManager>.Instance,
        fs, null!, library, DispatchProxy.Create<IBaseItemManager, BaseItemManagerProxy>(), null!, null!, null!, null!);
    providers.AddParts([], [], [provider], [], [], []);
    var repository = DispatchProxy.Create<IItemRepository, RepositoryProxy>();
    BaseItem item;
    IMetadataService service;
    switch (scenario.GetProperty("type").GetString())
    {
        case "Movie":
            item = new Movie();
            service = new MovieMetadataService(BaseItem.ConfigurationManager, NullLogger<MovieMetadataService>.Instance, providers, fs, library, null!, repository);
            break;
        case "Season":
            item = new Season { IndexNumber = 2, Children = [] };
            service = new SeasonMetadataService(BaseItem.ConfigurationManager, NullLogger<SeasonMetadataService>.Instance, providers, fs, library, null!, repository);
            break;
        default:
            item = new Episode { IndexNumber = 3, ParentIndexNumber = 2 };
            service = new EpisodeMetadataService(BaseItem.ConfigurationManager, NullLogger<EpisodeMetadataService>.Instance, providers, fs, library, null!, repository);
            break;
    }
    item.Id = Guid.Parse("e1000000-0000-0000-0000-000000000001");
    item.Name = "Stored title";
    item.ProductionYear = 2001;
    item.IsInMixedFolder = true;
    item.DateLastRefreshed = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc);
    item.ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "11", ["Custom"] = "old" };
    var refresh = new MetadataRefreshOptions((IDirectoryService)null!)
    {
        MetadataRefreshMode = MetadataRefreshMode.FullRefresh,
        ImageRefreshMode = MetadataRefreshMode.None,
        IsAutomated = scenario.TryGetProperty("automated", out var automated) && automated.GetBoolean(),
        ForceSave = true
    };
    if (scenario.TryGetProperty("search", out var search)) refresh.SearchResult = JsonSerializer.Deserialize<RemoteSearchResult>(search.GetRawText(), options);
    await service.RefreshMetadata(item, refresh, CancellationToken.None);
    results.Add(new { name = scenario.GetProperty("name").GetString(), lookups = provider.Lookups, item.Overview });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual MovieMetadataService, SeasonMetadataService and EpisodeMetadataService provider lookup inputs. Actual ApplySearchResult, provider ID validation and IsAutomated assignment run through the native refresh lifecycle. Pathless items, library/options/children, file metadata, repository and provider callbacks are controlled. SQL, images, sidecars, public Identify routes and remote service behavior are excluded.",
    results
}, options));

public class LookupProvider : IRemoteMetadataProvider<Movie, MovieInfo>, IRemoteMetadataProvider<Season, SeasonInfo>, IRemoteMetadataProvider<Episode, EpisodeInfo>
{
    public string Name => "Controlled lookup";
    public List<object> Lookups = [];
    Task<MetadataResult<T>> Capture<T>(ItemLookupInfo info) where T : BaseItem, new()
    {
        var seriesIds = info switch { SeasonInfo season => season.SeriesProviderIds, EpisodeInfo episode => episode.SeriesProviderIds, _ => null };
        Lookups.Add(new { info.Name, info.Year, info.ProviderIds, SeriesProviderIds = seriesIds, info.IsAutomated });
        var selected = seriesIds ?? info.ProviderIds;
        var providerId = selected.FirstOrDefault(pair => string.Equals(pair.Key, "Tmdb", StringComparison.OrdinalIgnoreCase)).Value;
        var overview = $"{info.Name ?? "<null>"}|{info.Year?.ToString() ?? "<null>"}|{info.IsAutomated.ToString().ToLowerInvariant()}|{providerId ?? "<none>"}";
        return Task.FromResult(new MetadataResult<T> { HasMetadata = true, Item = new T { Overview = overview } });
    }
    public Task<MetadataResult<Movie>> GetMetadata(MovieInfo info, CancellationToken token) => Capture<Movie>(info);
    public Task<MetadataResult<Season>> GetMetadata(SeasonInfo info, CancellationToken token) => Capture<Season>(info);
    public Task<MetadataResult<Episode>> GetMetadata(EpisodeInfo info, CancellationToken token) => Capture<Episode>(info);
    public Task<IEnumerable<RemoteSearchResult>> GetSearchResults(MovieInfo info, CancellationToken token) => throw new NotSupportedException();
    public Task<IEnumerable<RemoteSearchResult>> GetSearchResults(SeasonInfo info, CancellationToken token) => throw new NotSupportedException();
    public Task<IEnumerable<RemoteSearchResult>> GetSearchResults(EpisodeInfo info, CancellationToken token) => throw new NotSupportedException();
    public Task<HttpResponseMessage> GetImageResponse(string url, CancellationToken token) => throw new NotSupportedException();
}
public class ConfigurationProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_Configuration" => new ServerConfiguration { MetadataCountryCode = "US" },
        "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
public class LibraryProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetLibraryOptions" => new LibraryOptions(),
        "GetCollectionFolders" => new List<Folder>(),
        "GetLocalAlternateVersionIds" => Array.Empty<Guid>(),
        "GetItemById" => null,
        "GetItemList" => new List<BaseItem>(),
        "FillMissingEpisodeNumbersFromPath" => false,
        "UpdateItemAsync" => Task.CompletedTask,
        _ => throw new NotSupportedException(method.Name)
    };
}
public class FileSystemProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetFileSystemInfo" ? new FileSystemMetadata() : throw new NotSupportedException(method.Name);
}
public class BaseItemManagerProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "IsMetadataFetcherEnabled" ? true : throw new NotSupportedException(method.Name);
}
public class RepositoryProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "ItemExistsAsync" ? Task.FromResult(true) : throw new NotSupportedException(method.Name);
}
public class LookupRecordingsProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}
