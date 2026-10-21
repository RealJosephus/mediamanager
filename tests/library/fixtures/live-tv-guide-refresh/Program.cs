using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.Library;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv;
using Jellyfin.LiveTv.Guide;
using Jellyfin.LiveTv.Listings;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.LiveTv;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
var outputOptions = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
var settings = new ServerConfiguration { EnableCaseSensitiveItemIds = true, MetadataCountryCode = "US" };
var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name == "get_ProgramDataPath" ? "/guide-refresh-controlled-state" : Stub.Default(method.ReturnType));
LiveTvOptions liveOptions = new(); Action? configurationRead = null;
var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
    "get_Configuration" => settings, "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths,
    "GetConfiguration" => ReadConfiguration(), _ => Stub.Default(method.ReturnType)
});
object ReadConfiguration() { configurationRead?.Invoke(); return liveOptions; }
BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
BaseItem.LocalizationManager = Stub.Make<ILocalizationManager>((method, _) => method.Name == "GetRatingScore" ? null : Stub.Default(method.ReturnType));
var identityLibrary = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
typeof(LibraryManager).GetField("_configurationManager", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(identityLibrary, config);
var dto = new LiveTvDtoService(null!, null!, NullLogger<LiveTvDtoService>.Instance, null!, identityLibrary);
var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ExpandVirtualPath" or "ReverseVirtualPath" ? values![0] : Stub.Default(method.ReturnType));
var parent = new Folder { Id = Guid.Parse(input.GetProperty("parentId").GetString()!), Name = "Controlled guide parent" };
var fileSystem = Stub.Make<IFileSystem>((method, values) => method.Name switch {
    "GetFileInfo" or "GetFileSystemInfo" => new FileSystemMetadata { FullName = (string)values![0]!, Exists = true, LastWriteTimeUtc = DateTime.MinValue },
    "GetLastWriteTimeUtc" => DateTime.MinValue, _ => Stub.Default(method.ReturnType)
});
BaseItem.FileSystem = fileSystem;
string Id(Guid value) => value.ToString("N");
object Project(BaseItem item) {
    var channel = item as LiveTvChannel; var program = item as LiveTvProgram;
    return new {
        Id = Id(item.Id), Type = item.GetType().Name, item.Name, ParentId = item.ParentId == parent.Id ? "$PARENT" : Id(item.ParentId),
        ChannelId = Id(item.ChannelId), item.ExternalId, ServiceName = channel?.ServiceName, Number = channel?.Number,
        ChannelType = channel?.ChannelType.ToString(), item.Tags, item.Genres, item.Width, item.Height,
        IsMovie = channel?.IsMovie ?? program?.IsMovie ?? false, IsSeries = channel?.IsSeries ?? program?.IsSeries ?? false,
        IsNews = channel?.IsNews ?? program?.IsNews ?? false, IsSports = channel?.IsSports ?? program?.IsSports ?? false,
        IsKids = channel?.IsKids ?? program?.IsKids ?? false, item.IsVirtualItem, item.ProviderIds,
        ShowId = program?.ShowId, SeriesName = program?.SeriesName, EpisodeTitle = channel?.EpisodeTitle ?? program?.EpisodeTitle,
        StartDate = program?.StartDate.Ticks.ToString(CultureInfo.InvariantCulture), EndDate = item.EndDate?.Ticks.ToString(CultureInfo.InvariantCulture),
        RunTimeTicks = item.RunTimeTicks?.ToString(CultureInfo.InvariantCulture),
        Images = item.ImageInfos.Select(image => new { image.Path, Type = image.Type.ToString() }).ToArray()
    };
}
BaseItem Hydrate(BaseItemEntity row) => BaseItemMapper.DeserializeBaseItem(row, NullLogger.Instance, appHost)!;
BaseItemEntity Map(BaseItem item) => BaseItemMapper.Map(item, appHost);
ProgramInfo Info(JsonElement value) {
    var item = new ProgramInfo { StartDate = new DateTime(2500, 1, 1, 0, 0, 0, DateTimeKind.Utc), EndDate = new DateTime(2500, 1, 1, 1, 0, 0, DateTimeKind.Utc), Etag = "ordinary" };
    foreach (var property in value.EnumerateObject()) {
        var field = typeof(ProgramInfo).GetProperty(property.Name)!;
        field.SetValue(item, property.Value.Deserialize(field.PropertyType, JsonDefaults.Options));
    }
    item.Name ??= item.Id; return item;
}
ChannelInfo Channel(JsonElement value) {
    var item = value.Deserialize<ChannelInfo>(JsonDefaults.Options)!; item.Name ??= item.Id; item.Number ??= item.Id; return item;
}
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var rows = new List<BaseItemEntity>(); var cache = new Dictionary<Guid, BaseItem>();
    var seedChannels = new Dictionary<string, LiveTvChannel>();
    if (sample.TryGetProperty("seedChannels", out var channelSeeds)) foreach (var seed in channelSeeds.EnumerateArray()) {
        var service = seed.GetProperty("service").GetString()!; var external = seed.GetProperty("id").GetString()!;
        var item = new LiveTvChannel { Id = dto.GetInternalChannelId(service, external), ParentId = parent.Id, Name = external,
            ExternalId = external, Number = external, ServiceName = service, Tags = seed.TryGetProperty("Tags", out var tags) ? tags.Deserialize<string[]>()! : [] };
        item.SetProviderId("ExternalServiceId", service); seedChannels[service + ":" + external] = item; rows.Add(Map(item)); cache[item.Id] = item;
    }
    if (sample.TryGetProperty("seedPrograms", out var programSeeds)) foreach (var seed in programSeeds.EnumerateArray()) {
        var external = seed.GetProperty("id").GetString()!;
        var channel = seedChannels[seed.GetProperty("service").GetString() + ":" + seed.GetProperty("channel").GetString()];
        var item = new LiveTvProgram { Id = dto.GetInternalProgramId(external), ParentId = channel.Id, ChannelId = channel.Id,
            ExternalId = external, Name = seed.TryGetProperty("Name", out var name) ? name.GetString() : external,
            StartDate = new DateTime(2500, 1, 1, 0, 0, 0, DateTimeKind.Utc), EndDate = new DateTime(2500, 1, 1, 1, 0, 0, DateTimeKind.Utc) };
        item.SetProviderId("ProgramEtag", "before"); rows.Add(Map(item));
        if (seed.TryGetProperty("duplicateGuid", out var duplicate) && duplicate.GetBoolean()) { item.Name = "second stored spelling"; rows.Add(Map(item)); }
    }
    var runs = new List<object>();
    foreach (var count in sample.GetProperty("progressCounts").EnumerateArray()) {
        var trace = new List<object>(); var windows = new List<object>(); var progress = new CaptureProgress(count.GetInt32());
        using var cancellation = new CancellationTokenSource();
        var before = DateTime.UtcNow;
        liveOptions = new LiveTvOptions { GuideDays = sample.TryGetProperty("guideDays", out var days) ? days.GetInt32() : null };
        configurationRead = () => trace.Add(new { kind = "configuration" });
        void Save(BaseItem item) { rows.RemoveAll(row => row.Id == item.Id); rows.Add(Map(item)); if (item is LiveTvChannel) cache[item.Id] = item; }
        BaseItem? Lookup(Guid id) => id == parent.Id ? parent : cache.TryGetValue(id, out var item) ? item : rows.FirstOrDefault(row => row.Id == id) is { } row ? Hydrate(row) : null;
        var library = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
            "GetItemById" => Lookup((Guid)values![0]!),
            "GetItemList" => Existing((InternalItemsQuery)values![0]!),
            "CreateItem" => Create((BaseItem)values![0]!),
            "CreateItems" => CreatePrograms((IReadOnlyList<BaseItem>)values![0]!, (CancellationToken)values[2]!),
            "UpdateItemAsync" => Update((BaseItem)values![0]!, (CancellationToken)values[3]!),
            "UpdateItemsAsync" => UpdatePrograms((IReadOnlyList<BaseItem>)values![0]!, (CancellationToken)values[3]!),
            "DeleteItem" => Delete((BaseItem)values![0]!, (DeleteOptions)values[1]!, (bool)values[2]!),
            "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions { MetadataCountryCode = "US" },
            "UpdateImagesAsync" => Task.CompletedTask, _ => Stub.Default(method.ReturnType)
        });
        IReadOnlyList<BaseItem> Existing(InternalItemsQuery query) => rows.Where(row => row.Type == typeof(LiveTvProgram).FullName && query.ChannelIds.Contains(row.ChannelId ?? Guid.Empty))
            .OrderBy(row => row.SortName, StringComparer.Ordinal).Select(Hydrate).ToArray();
        object? Create(BaseItem item) {
            trace.Add(new { kind = "create-channel", item = Project(item) });
            if (sample.TryGetProperty("failChannel", out var fail) && fail.GetString() == item.ExternalId) throw new InvalidOperationException("Controlled channel create failure.");
            Save(item); return null;
        }
        object? CreatePrograms(IReadOnlyList<BaseItem> items, CancellationToken token) {
            token.ThrowIfCancellationRequested(); trace.Add(new { kind = "create-programs", items = items.Select(Project).ToArray() }); foreach (var item in items) Save(item); return null;
        }
        Task Update(BaseItem item, CancellationToken token) {
            token.ThrowIfCancellationRequested(); trace.Add(new { kind = "update-channel", item = Project(item) }); Save(item); return Task.CompletedTask;
        }
        Task UpdatePrograms(IReadOnlyList<BaseItem> items, CancellationToken token) {
            token.ThrowIfCancellationRequested(); trace.Add(new { kind = "update-programs", items = items.Select(Project).ToArray() }); foreach (var item in items) Save(item); return Task.CompletedTask;
        }
        object? Delete(BaseItem item, DeleteOptions options, bool notify) {
            trace.Add(new { kind = "delete", Id = Id(item.Id), options.DeleteFileLocation, options.DeleteFromExternalProvider, notify });
            var removed = new HashSet<Guid> { item.Id }; bool added;
            do { added = false; foreach (var row in rows) if (row.ParentId.HasValue && removed.Contains(row.ParentId.Value)) added |= removed.Add(row.Id); } while (added);
            rows.RemoveAll(row => removed.Contains(row.Id)); foreach (var id in removed) cache.Remove(id); return null;
        }
        BaseItem.LibraryManager = library;
        BaseItem.ProviderManager = Stub.Make<IProviderManager>((method, values) => {
            if (method.Name != "RefreshSingleItem") return Stub.Default(method.ReturnType);
            var item = (BaseItem)values![0]!; var options = (MetadataRefreshOptions)values[1]!;
            ((CancellationToken)values[2]!).ThrowIfCancellationRequested(); trace.Add(new { kind = "metadata", Id = Id(item.Id), options.ForceSave });
            return Task.FromResult(ItemUpdateType.None);
        });
        var services = sample.GetProperty("services").EnumerateArray().Select(definition => {
            var name = definition.GetProperty("name").GetString()!;
            return Stub.Make<ILiveTvService>((method, values) => method.Name switch {
                "get_Name" => name, "GetChannelsAsync" => Channels(),
                "GetProgramsAsync" => Programs((string)values![0]!, (DateTime)values[1]!, (DateTime)values[2]!, (CancellationToken)values[3]!),
                _ => throw new InvalidOperationException("No recording/tuner/stream executor is permitted: " + method.Name)
            });
            Task<IEnumerable<ChannelInfo>> Channels() {
                cancellation.Token.ThrowIfCancellationRequested(); trace.Add(new { kind = "channels", service = name });
                if (definition.TryGetProperty("failChannels", out var fail) && fail.GetBoolean()) throw new InvalidOperationException("Controlled channel provider failure.");
                return Task.FromResult<IEnumerable<ChannelInfo>>(definition.GetProperty("channels").EnumerateArray().Select(Channel).ToArray());
            }
            Task<IEnumerable<ProgramInfo>> Programs(string external, DateTime start, DateTime end, CancellationToken token) {
                token.ThrowIfCancellationRequested(); trace.Add(new { kind = "programs", service = name, channel = external });
                var expectedChannels = definition.GetProperty("channels").EnumerateArray().Select(Channel)
                    .Where(channel => !sample.TryGetProperty("failChannel", out var fail) || fail.GetString() != channel.Id).Select(channel => dto.GetInternalChannelId(name, channel.Id)).ToArray();
                if (expectedChannels.Any(id => !rows.Any(row => row.Id == id))) throw new InvalidOperationException("Programs were requested before all channels were saved.");
                windows.Add(new { service = name, channel = external, start = start.ToString("O"), end = end.ToString("O"), allChannelsSaved = true });
                var programs = new List<ProgramInfo>();
                if (definition.TryGetProperty("programs", out var mapping) && mapping.TryGetProperty(external, out var specification)) {
                    if (specification.TryGetProperty("prefixCount", out var prefix)) for (var index = 0; index < prefix.GetInt32(); index++) {
                        var id = external + "-prefix-" + index; programs.Add(new ProgramInfo { Id = id, Name = id, Etag = "ordinary",
                            StartDate = new DateTime(2500, 1, 1, 0, 0, 0, DateTimeKind.Utc), EndDate = new DateTime(2500, 1, 1, 1, 0, 0, DateTimeKind.Utc) });
                    }
                    if (specification.TryGetProperty("items", out var items)) programs.AddRange(items.EnumerateArray().Select(Info));
                }
                return Task.FromResult<IEnumerable<ProgramInfo>>(programs);
            }
        }).ToArray();
        if (services.Any(service => service is DefaultLiveTvService)) throw new InvalidOperationException("Recording execution is forbidden.");
        var liveTv = Stub.Make<ILiveTvManager>((method, _) => method.Name switch {
            "get_Services" => services, "GetInternalLiveTvFolder" => parent, _ => Stub.Default(method.ReturnType)
        });
        var repository = Stub.Make<IItemRepository>((method, values) => {
            if (method.Name != "GetItemIdsList") return Stub.Default(method.ReturnType);
            var type = ((InternalItemsQuery)values![0]!).IncludeItemTypes.Single().ToString(); trace.Add(new { kind = "clean", type });
            return rows.Where(row => row.Type!.EndsWith("." + type, StringComparison.Ordinal)).OrderBy(row => row.SortName, StringComparer.Ordinal).Select(row => row.Id).ToList();
        });
        var folders = Stub.Make<IRecordingsManager>((method, _) => method.Name == "CreateRecordingFolders" ? Folders() : throw new InvalidOperationException("Recording executor is forbidden."));
        Task Folders() { trace.Add(new { kind = "folders" }); return Task.CompletedTask; }
        var scanner = Stub.Make<ITunerHostManager>((method, values) => method.Name == "ScanForTunerDeviceChanges" ? Scan((CancellationToken)values![0]!) : Stub.Default(method.ReturnType));
        Task Scan(CancellationToken token) { token.ThrowIfCancellationRequested(); trace.Add(new { kind = "scan" }); return Task.CompletedTask; }
        var sd = Stub.Make<ISchedulesDirectService>((method, _) => {
            if (method.Name == "IsImageDailyLimitActive") { trace.Add(new { kind = "precache" }); return false; }
            throw new InvalidOperationException("Image network execution is forbidden.");
        });
        var logger = new CaptureLogger<GuideManager>(error => trace.Add(new { kind = "error", type = error.GetType().Name }));
        var manager = new GuideManager(logger, config, fileSystem, repository, library, liveTv, scanner, folders, sd, dto);
        if (sample.TryGetProperty("preCancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
        string? error = null;
        try { await manager.RefreshGuide(progress, cancellation.Token); } catch (Exception caught) { error = caught.GetType().Name; }
        await progress.Complete(); var after = DateTime.UtcNow;
        runs.Add(new { trace, progress = progress.Values, error, items = rows.Select(Hydrate).OrderBy(item => Id(item.Id), StringComparer.Ordinal).ThenBy(item => item.Name, StringComparer.Ordinal).Select(Project).ToArray(),
            windows, clock = new { before = before.ToString("O"), after = after.ToString("O") } });
    }
    results.Add(new { name = sample.GetProperty("name").GetString(), runs });
}
var assemblies = new[] { typeof(GuideManager).Assembly, typeof(LiveTvDtoService).Assembly, typeof(LibraryManager).Assembly, typeof(BaseItemMapper).Assembly, typeof(BaseItem).Assembly }.Distinct()
    .Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualGuideManagerRefreshGuide = true, actualPrivateMaterializers = true, actualLiveTvDtoIdentity = true,
    actualBaseItemMapperFrames = true, nativePersistenceControlled = true, nativeEfOpened = false, nativeMetadataProviderControlled = true,
    nativeRepositorySelectionControlled = true, nonDefaultServicesOnly = true, recordingExecutorsStarted = false, inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), assemblies, results }, outputOptions));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public sealed class CaptureLogger<T>(Action<Exception> observe) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) { if (level >= LogLevel.Error && error is not null) observe(error); }
}
public sealed class CaptureProgress(int expected) : IProgress<double> {
    private readonly object _gate = new(); private readonly List<double> _values = [];
    private readonly TaskCompletionSource _received = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public double[] Values { get { lock (_gate) return _values.ToArray(); } }
    public void Report(double value) { lock (_gate) { _values.Add(value); if (_values.Count >= expected) _received.TrySetResult(); } }
    public async Task Complete() {
        if (expected != 0) await _received.Task.WaitAsync(TimeSpan.FromSeconds(10));
        lock (_gate) if (_values.Count != expected) throw new InvalidOperationException($"Expected {expected} real progress callbacks, observed {_values.Count}.");
    }
}
