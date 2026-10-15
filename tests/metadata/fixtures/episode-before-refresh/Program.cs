// Records actual EpisodeResolver, LibraryManager and Episode refresh hooks.
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Emby.Naming.Common;
using Emby.Naming.TV;
using Emby.Server.Implementations.Library;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.BaseItemManager;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dlna;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Providers;
using MediaBrowser.Providers.Manager;
using MediaBrowser.Providers.TV;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Jellyfin.Server.Implementations.Item;
using EpisodeInfo = MediaBrowser.Controller.Providers.EpisodeInfo;

var json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var scenarios = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var naming = new NamingOptions();
BaseItem.ConfigurationManager = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
var wordCharacters = new List<string>();
for (var code = 0; code <= char.MaxValue; code++) {
    if (!Regex.IsMatch(((char)code).ToString(), @"^\w$")) continue;
    var start = code;
    while (code < char.MaxValue && Regex.IsMatch(((char)(code + 1)).ToString(), @"^\w$")) code++;
    wordCharacters.Add(start == code ? $"\\u{code:x4}" : $"\\u{start:x4}-\\u{code:x4}");
}
object Expression(EpisodeExpression value) => new { value.Expression, value.IsByDate, value.IsNamed, value.IsOptimistic,
    value.SupportsAbsoluteEpisodeNumbers, value.DateTimeFormats };
File.WriteAllText(args[2], JsonSerializer.Serialize(new { RegexWordCharacters = string.Concat(wordCharacters), naming.VideoFileExtensions, naming.StubFileExtensions,
    naming.StubTypes, EpisodeExpressions = naming.EpisodeExpressions.Select(Expression),
    MultipleEpisodeExpressions = naming.MultipleEpisodeExpressions.Select(Expression) }, json) + "\n");
string? IanaName(TimeZoneInfo zone) => TimeZoneInfo.TryConvertWindowsIdToIanaId(zone.Id, out var iana) ? iana
    : zone.HasIanaId ? zone.Id : null;
File.WriteAllText(args[3], JsonSerializer.Serialize(new { platform = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
    timeZones = TimeZoneInfo.GetSystemTimeZones().Where(zone => zone.GetAdjustmentRules().Length == 0 && IanaName(zone) is not null)
        .Select(zone => new { id = zone.Id, ianaId = IanaName(zone), offsetMinutes = zone.BaseUtcOffset.TotalMinutes }) }, json) + "\n");
var results = new List<object>();
foreach (var scenario in scenarios.EnumerateArray()) {
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var control = (LibraryProxy)(object)library;
    control.Real = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    typeof(LibraryManager).GetField("_namingOptions", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(control.Real, naming);
    BaseItem.LibraryManager = library;
    BaseItem.MediaSourceManager = DispatchProxy.Create<IMediaSourceManager, SourcesProxy>();
    BaseItem.MediaSegmentManager = DispatchProxy.Create<IMediaSegmentManager, SegmentsProxy>();
    BaseItem.FileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
    var recordings = (RecordingsProxy)(object)Video.RecordingsManager;
    var logger = new RecordingLogger(); BaseItem.Logger = logger;
    var encoder = DispatchProxy.Create<IMediaEncoder, EncoderProxy>(); Episode.MediaEncoder = encoder;
    var media = (EncoderProxy)(object)encoder;
    if (scenario.TryGetProperty("mediaInfo", out var mediaInfo)) media.Info = JsonSerializer.Deserialize<MediaInfo>(mediaInfo.GetRawText(), json)!;
    media.Fail = scenario.TryGetProperty("probeFailure", out var probeFailure) && probeFailure.GetBoolean();
    control.Options.EnableEmbeddedEpisodeInfos = scenario.TryGetProperty("embedded", out var embedded) && embedded.GetBoolean();
    object? result = null; string? exception = null;
    try {
        var mode = scenario.GetProperty("mode").GetString();
        if (mode == "resolve") {
            var resolved = new EpisodeResolver(naming).Resolve(scenario.GetProperty("path").GetString()!,
                scenario.TryGetProperty("directory", out var directory) && directory.GetBoolean(),
                scenario.TryGetProperty("named", out var named) ? named.GetBoolean() : null,
                scenario.TryGetProperty("optimistic", out var optimistic) ? optimistic.GetBoolean() : null,
                scenario.TryGetProperty("absolute", out var absolute) ? absolute.GetBoolean() : null);
            result = resolved is null ? null : new { resolved.Container, resolved.IsStub, resolved.StubType,
                resolved.EpisodeNumber, resolved.EndingEpisodeNumber, resolved.SeasonNumber, resolved.SeriesName,
                resolved.IsByDate, resolved.Year, resolved.Month, resolved.Day };
        } else {
            var definitions = scenario.GetProperty("items");
            foreach (var definition in definitions.EnumerateArray()) {
                BaseItem item = definition.GetProperty("type").GetString() switch {
                    "Series" => new Series(), "Season" => new Season(), "Folder" => new Folder(), "Episode" => new Episode(),
                    _ => throw new NotSupportedException()
                };
                foreach (var field in definition.EnumerateObject()) if (field.Name is not "type" and not "parent" and not "key") {
                    if (field.Name == "SourceType") {
                        if (field.Value.GetString() == "Channel") item.ChannelId = Guid.Parse("8c000000-0000-0000-0000-000000000099");
                        recordings.Active = field.Value.GetString() == "LiveTV";
                        continue;
                    }
                    var property = item.GetType().GetProperty(field.Name)!;
                    property.SetValue(item, JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, json));
                }
                if (item is Folder folder) folder.Children = [];
                control.Items[item.Id] = item;
            }
            foreach (var definition in definitions.EnumerateArray()) if (definition.TryGetProperty("parent", out var parent)) {
                var item = control.Items[definition.GetProperty("Id").GetGuid()];
                var folder = (Folder)control.Items[parent.GetGuid()]; item.SetParent(folder);
                folder.Children = [.. folder.Children, item];
            }
            var target = control.Items[scenario.GetProperty("target").GetGuid()];
            if (mode == "map") {
                result = Projection.MapDates(target);
            } else {
            var episode = (Episode)target;
            _ = episode.SortName;
            if (mode == "refresh") {
                using var providers = new ProviderManager(null!, null!, BaseItem.ConfigurationManager, null!, NullLogger<ProviderManager>.Instance,
                    BaseItem.FileSystem, null!, library, DispatchProxy.Create<IBaseItemManager, BaseItemManagerProxy>(), null!, null!, null!, null!);
                var remote = new LookupProvider { Changed = !scenario.TryGetProperty("providerChanged", out var providerChanged) || providerChanged.GetBoolean(),
                    Cancel = scenario.TryGetProperty("cancel", out var cancel) && cancel.GetBoolean() };
                providers.AddParts([], [], scenario.TryGetProperty("noProvider", out var noProvider) && noProvider.GetBoolean() ? [] : [remote], [], [], []);
                var service = new EpisodeMetadataService(BaseItem.ConfigurationManager, NullLogger<EpisodeMetadataService>.Instance, providers,
                    BaseItem.FileSystem, library, null!, DispatchProxy.Create<IItemRepository, RepositoryProxy>());
                var refresh = new MetadataRefreshOptions((IDirectoryService)null!) {
                    MetadataRefreshMode = Enum.Parse<MetadataRefreshMode>(scenario.GetProperty("metadataMode").GetString()!), ImageRefreshMode = MetadataRefreshMode.None,
                    ForceSave = scenario.TryGetProperty("force", out var force) && force.GetBoolean(),
                    ReplaceAllMetadata = scenario.TryGetProperty("replace", out var replacement) && replacement.GetBoolean()
                };
                int? updateType = null; var initialStamp = episode.DateLastRefreshed;
                try { updateType = (int)await service.RefreshMetadata(episode, refresh, CancellationToken.None); }
                catch (OperationCanceledException) when (remote.Cancel) { exception = nameof(OperationCanceledException); }
                result = new { updateType, item = Projection.Capture(episode), calls = control.Calls, lookups = remote.Lookups,
                    reattachments = control.Reattachments, probeCalls = media.Calls, fillCalls = control.FillCalls,
                    stampChanged = episode.DateLastRefreshed != initialStamp };
            } else {
            var changed = mode == "fill"
                ? control.Real.FillMissingEpisodeNumbersFromPath(episode, scenario.TryGetProperty("replace", out var force) && force.GetBoolean())
                : episode.BeforeMetadataRefresh(scenario.TryGetProperty("replace", out var replace) && replace.GetBoolean());
            var cache = typeof(BaseItem).GetField("_sortName", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(episode);
            result = new { changed, item = new { episode.Name, episode.SeriesName, episode.IndexNumber, episode.IndexNumberEnd,
                episode.ParentIndexNumber, episode.PremiereDate, episode.ProductionYear, episode.SortName }, cache,
                mappedDates = Projection.MapDates(episode), probeCalls = media.Calls, requests = media.Requests, fillCalls = control.FillCalls, errors = logger.Errors };
            }
            }
        }
    } catch (Exception error) { exception = error.GetType().Name; }
    results.Add(new { name = scenario.GetProperty("name").GetString(), result, exception });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    timezone = new { id = TimeZoneInfo.Local.Id, ianaId = IanaName(TimeZoneInfo.Local), offsetMinutes = TimeZoneInfo.Local.BaseUtcOffset.TotalMinutes,
        adjustmentRules = TimeZoneInfo.Local.GetAdjustmentRules().Length },
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual EpisodeResolver and native NamingOptions, actual LibraryManager.FillMissingEpisodeNumbersFromPath, Episode.BeforeMetadataRefresh, EpisodeMetadataService with actual ProviderManager and BaseItemMapper date projection. Physical and typed reference items, library options, missing file metadata, media sources, IMediaEncoder results/failures, empty remote results and repository/reattachment callbacks are controlled. No native SQL, real filesystem or real ffprobe occurs." }, json) + "\n");

public static class Projection {
    public static object MapDates(BaseItem item) {
        var mapped = BaseItemMapper.Map(item, DispatchProxy.Create<IServerApplicationHost, ApplicationHostProxy>());
        return new { mapped.PremiereDate, mapped.EndDate, mapped.DateCreated, mapped.DateModified, mapped.DateLastRefreshed, mapped.DateLastSaved, mapped.DateLastMediaAdded };
    }
    public static object Capture(Episode episode) => new { episode.Name, episode.SeriesName, episode.IndexNumber, episode.IndexNumberEnd,
        episode.ParentIndexNumber, episode.PremiereDate, episode.ProductionYear, episode.SortName };
}
public class ApplicationHostProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "ReverseVirtualPath" ? args![0] : throw new NotSupportedException(method.Name);
}
public class ConfigurationProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_Configuration" => new ServerConfiguration { MetadataCountryCode = "US" },
        "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null, _ => throw new NotSupportedException(method.Name)
    };
}

public class LibraryProxy : DispatchProxy {
    public LibraryManager Real = null!; public Dictionary<Guid, BaseItem> Items = []; public LibraryOptions Options = new(); public int FillCalls;
    public List<object> Calls = []; public int Reattachments;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetItemById" => Items.GetValueOrDefault((Guid)args![0]!),
        "GetLibraryOptions" => Options,
        "GetCollectionFolders" => new List<Folder>(),
        "GetLocalAlternateVersionIds" => Array.Empty<Guid>(),
        "GetLinkedAlternateVersions" => Enumerable.Empty<Video>(),
        "FillMissingEpisodeNumbersFromPath" => Fill((Episode)args![0]!, (bool)args[1]!),
        "UpdateItemAsync" => Update((Episode)args![0]!, (ItemUpdateType)args[2]!),
        "ReattachUserDataAsync" => Reattach(),
        _ => throw new NotSupportedException(method.Name)
    };
    private bool Fill(Episode episode, bool force) { FillCalls++; return Real.FillMissingEpisodeNumbersFromPath(episode, force); }
    private Task Update(Episode episode, ItemUpdateType reason) { Calls.Add(new { item = Projection.Capture(episode), updateReason = (int)reason }); return Task.CompletedTask; }
    private Task Reattach() { Reattachments++; return Task.CompletedTask; }
}
public class LookupProvider : IRemoteMetadataProvider<Episode, EpisodeInfo>, IHasItemChangeMonitor {
    public string Name => "Controlled empty episode lookup"; public bool Changed, Cancel; public List<object> Lookups = [];
    public bool HasChanged(BaseItem item, IDirectoryService directoryService) => Changed;
    public Task<MetadataResult<Episode>> GetMetadata(EpisodeInfo info, CancellationToken cancellationToken) {
        Lookups.Add(new { info.IndexNumber, info.IndexNumberEnd, info.ParentIndexNumber, info.PremiereDate, info.Year });
        if (Cancel) throw new OperationCanceledException("Injected cancellation after episode hooks");
        return Task.FromResult(new MetadataResult<Episode> { HasMetadata = false });
    }
    public Task<IEnumerable<RemoteSearchResult>> GetSearchResults(EpisodeInfo info, CancellationToken cancellationToken) => throw new NotSupportedException();
    public Task<HttpResponseMessage> GetImageResponse(string url, CancellationToken cancellationToken) => throw new NotSupportedException();
}
public class BaseItemManagerProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "IsMetadataFetcherEnabled" ? true : throw new NotSupportedException(method.Name);
}
public class RepositoryProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "ItemExistsAsync" ? Task.FromResult(true) : throw new NotSupportedException(method.Name);
}
public class FileSystemProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetFileSystemInfo" or "GetFileInfo" => new FileSystemMetadata { Exists = false, IsDirectory = false },
        "IsPathFile" => true, _ => throw new NotSupportedException(method.Name)
    };
}
public class SourcesProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetMediaStreams" => new List<MediaStream>(), "GetMediaAttachments" => new List<MediaAttachment>(),
        "GetPathProtocol" => args![0] is string path && !string.IsNullOrEmpty(path) ? path.StartsWith("http") ? MediaProtocol.Http : MediaProtocol.File : (MediaProtocol?)null,
        "SupportsDirectStream" => true, _ => throw new NotSupportedException(method.Name)
    };
}
public class SegmentsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "IsTypeSupported" ? false : throw new NotSupportedException(method.Name);
}
public class EncoderProxy : DispatchProxy {
    public MediaInfo Info = new(); public bool Fail; public int Calls; public List<object> Requests = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name != "GetMediaInfo") throw new NotSupportedException(method.Name);
        Calls++; var request = (MediaInfoRequest)args![0]!;
        Requests.Add(new { request.MediaType, request.ExtractChapters, request.MediaSource.Path,
            canBeCanceled = ((CancellationToken)args[1]!).CanBeCanceled });
        return Fail ? Task.FromException<MediaInfo>(new IOException("Injected embedded information failure")) : Task.FromResult(Info);
    }
}
public class RecordingsProxy : DispatchProxy {
    public bool Active;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? Active ? new ActiveRecordingInfo() : null : throw new NotSupportedException(method.Name);
}
public class RecordingLogger : ILogger<BaseItem> {
    public List<string> Errors = [];
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
        if (level >= LogLevel.Error) Errors.Add(error?.GetType().Name ?? formatter(state, error));
    }
}
