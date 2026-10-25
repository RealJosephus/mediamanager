using System.Reflection;
using System.Collections.Concurrent;
using AsyncKeyedLock;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv;
using Jellyfin.LiveTv.Listings;
using Jellyfin.LiveTv.TunerHosts;
using Emby.Server.Implementations.Library;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.LiveTv;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging.Abstractions;

var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
object Channel(ChannelInfo channel) => new { channel.Id, channel.Name, channel.Number, channel.TunerHostId, channel.TunerChannelId, channel.ImageUrl };
object Source(MediaSourceInfo source) => new { source.Id, source.Path, Protocol = source.Protocol.ToString(), source.SupportsTranscoding,
    source.UseMostCompatibleTranscodingProfile, source.RequiredHttpHeaders };
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var calls = new List<object>();
    void Trace(string action, object? value) => calls.Add(new { action, value = JsonSerializer.SerializeToElement(value, options) });
    var configuration = input.GetProperty("configuration").Deserialize<LiveTvOptions>(JsonDefaults.Options)!;
    var config = Stub.Make<IConfigurationManager>((method, _) => method.Name == "GetConfiguration" ? configuration : Stub.Default(method.ReturnType));
    var tasks = Stub.Make<ITaskManager>((method, _) => Stub.Default(method.ReturnType));
    var tuners = sample.GetProperty("tuners").EnumerateArray().Select(source => new Tuner(source, Trace)).ToArray();
    var tunerManager = new TunerHostManager(NullLogger<TunerHostManager>.Instance, config, tasks, tuners);
    var listings = new Listings(sample, input.GetProperty("epgChannels"), Trace);
    var listingsManager = new ListingsManager(NullLogger<ListingsManager>.Instance, config, tasks, tunerManager, [listings]);
    // Only the selected pure reader fields are initialized. The constructor
    // subscribes to TimerManager.TimerFired, outside the retained reader slice.
    var service = (DefaultLiveTvService)RuntimeHelpers.GetUninitializedObject(typeof(DefaultLiveTvService));
    void Set(string name, object value) => typeof(DefaultLiveTvService).GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(service, value);
    Set("_logger", NullLogger<DefaultLiveTvService>.Instance); Set("_tunerHostManager", tunerManager); Set("_listingsManager", listingsManager);
    object? value = null; string? error = null;
    try {
        var operation = sample.GetProperty("operation").GetString();
        string? Id() => sample.TryGetProperty("channelId", out var id) ? id.GetString() : null;
        if (operation == "channels") value = (await service.GetChannelsAsync(CancellationToken.None)).Select(Channel).ToArray();
        else if (operation == "programs") value = (await service.GetProgramsAsync(Id()!, new DateTime(2500, 1, 1), new DateTime(2500, 1, 2), CancellationToken.None))
            .Select(program => new { program.Id, program.ChannelId, program.Name }).ToArray();
        else if (operation == "sources") value = (await service.GetChannelStreamMediaSources(Id()!, CancellationToken.None)).Select(Source).ToArray();
        else throw new InvalidOperationException("Unknown reader operation.");
    } catch (Exception caught) { error = caught.GetType().Name; }
    results.Add(new { name = sample.GetProperty("name").GetString(), value, error, calls = calls.ToArray(),
        initializedSources = tuners.Select(tuner => new { type = tuner.Type, sources = tuner.InitializedSources }).ToArray() });
}
var streamResults = new List<object>();
if (input.TryGetProperty("streamCases", out var streamCases)) foreach (var sample in streamCases.EnumerateArray()) {
    var calls = new List<object>();
    void Trace(string action, object? value) => calls.Add(new { action, value = JsonSerializer.SerializeToElement(value, options) });
    var tuners = sample.GetProperty("tuners").EnumerateArray().Select(source => new Tuner(source, Trace)).ToArray();
    var tunerManager = new TunerHostManager(NullLogger<TunerHostManager>.Instance, null!, null!, tuners);
    var service = (DefaultLiveTvService)RuntimeHelpers.GetUninitializedObject(typeof(DefaultLiveTvService));
    typeof(DefaultLiveTvService).GetField("_logger", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(service, NullLogger<DefaultLiveTvService>.Instance);
    typeof(DefaultLiveTvService).GetField("_tunerHostManager", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(service, tunerManager);
    var current = sample.GetProperty("seeds").EnumerateArray().Select((seed, index) => (ILiveStream)new ControlledStream("seed-" + index,
        input.GetProperty("streamSource").Deserialize<MediaSourceInfo>(JsonDefaults.Options)!, seed.GetProperty("enabled").GetBoolean()) {
            OriginalStreamId = seed.GetProperty("originalStreamId").GetString()! }).ToList();
    var handles = current.ToList(); ILiveStream? result = null; string? error = null;
    try {
        result = await service.GetChannelStreamWithDirectStreamProvider(sample.GetProperty("channelId").GetString()!,
            sample.GetProperty("originalStreamId").GetString()!, current, CancellationToken.None);
        handles.Add(result); if (!current.Contains(result)) current.Add(result);
    } catch (Exception caught) { error = caught.GetType().Name; }
    var afterOpen = StreamState.Project(current);
    var selected = result is null ? (int?)null : current.IndexOf(result);
    var manager = (MediaSourceManager)RuntimeHelpers.GetUninitializedObject(typeof(MediaSourceManager));
    var dictionary = new ConcurrentDictionary<string, ILiveStream>(current.ToDictionary(stream => stream.UniqueId), StringComparer.OrdinalIgnoreCase);
    using var locker = new AsyncNonKeyedLocker(1);
    foreach (var pair in new (string Name, object Value)[] { ("_logger", NullLogger<MediaSourceManager>.Instance), ("_openStreams", dictionary), ("_liveStreamLocker", locker) })
        typeof(MediaSourceManager).GetField(pair.Name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, pair.Value);
    var afterClose = new List<object>();
    foreach (var handle in handles) {
        await manager.CloseLiveStream(handle.UniqueId);
        afterClose.Add(StreamState.Project(current.Where(stream => dictionary.ContainsKey(stream.UniqueId))));
    }
    streamResults.Add(new { name = sample.GetProperty("name").GetString(), error, selected,
        source = result is null ? null : Source(result.MediaSource), afterOpen, afterClose, calls,
        closed = current.Select(stream => ((ControlledStream)stream).CloseCount).ToArray() });
}
var assemblies = new[] { typeof(DefaultLiveTvService).Assembly, typeof(TunerHostManager).Assembly, typeof(ListingsManager).Assembly, typeof(ChannelInfo).Assembly,
    typeof(MediaSourceInfo).Assembly, typeof(MediaSourceManager).Assembly, typeof(AsyncNonKeyedLocker).Assembly }.Distinct().Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
    actualDefaultServiceReaders = results.Count > 0, actualTunerHostManager = results.Count + streamResults.Count > 0,
    actualListingsManager = results.Count > 0, controlledProviders = true,
    constructorTimerSubscriptionBypassed = true, rawStreamSharingValidated = false, executorsStarted = false,
    actualDefaultStreamSelection = streamResults.Count > 0, actualMediaSourceManagerClose = streamResults.Count > 0, streamResults, results, assemblies }, options));

public class Tuner(JsonElement source, Action<string, object?> trace) : ITunerHost {
    public string Type => source.GetProperty("type").GetString()!;
    public string Name => Type;
    public bool IsSupported => !source.TryGetProperty("isSupported", out var value) || value.GetBoolean();
    public MediaSourceInfo[] InitializedSources => source.TryGetProperty("sources", out var value) ? value.Deserialize<MediaSourceInfo[]>(JsonDefaults.Options)! : [];
    public Task<List<ChannelInfo>> GetChannels(bool enableCache, CancellationToken cancellationToken) {
        trace("tuner.channels", new { type = Type, enableCache });
        Fail(source, "channelsFailure");
        return Task.FromResult(source.GetProperty("channels").Deserialize<List<ChannelInfo>>(JsonDefaults.Options)!);
    }
    public Task<List<MediaSourceInfo>> GetChannelStreamMediaSources(string channelId, CancellationToken cancellationToken) {
        trace("tuner.sources", new { type = Type, channelId }); Fail(source, "sourcesFailure");
        return Task.FromResult(InitializedSources.ToList());
    }
    public Task<List<TunerHostInfo>> DiscoverDevices(int duration, CancellationToken cancellationToken) => Task.FromResult(new List<TunerHostInfo>());
    public Task<ILiveStream> GetChannelStream(string channelId, string streamId, IList<ILiveStream> currentLiveStreams, CancellationToken cancellationToken) {
        trace("tuner.stream", new { type = Type, channelId, originalStreamId = streamId, current = StreamState.Project(currentLiveStreams) });
        Fail(source, "streamFailure");
        return Task.FromResult<ILiveStream>(new ControlledStream("opened-" + Type,
            source.GetProperty("streamSource").Deserialize<MediaSourceInfo>(JsonDefaults.Options)!, true));
    }
    public static void Fail(JsonElement source, string property) {
        if (!source.TryGetProperty(property, out var value)) return;
        throw value.GetString() switch {
            "IOException" => new IOException("Controlled I/O failure."), "OperationCanceledException" => new OperationCanceledException("Controlled cancellation failure."),
            "FileNotFoundException" => new FileNotFoundException(),
            "NotImplementedException" => new NotImplementedException(), "NotSupportedException" => new NotSupportedException(), _ => new InvalidOperationException()
        };
    }
}
public static class StreamState {
    public static object[] Project(IEnumerable<ILiveStream> streams) => streams.Select(stream => (object)new {
        stream.OriginalStreamId, stream.ConsumerCount, stream.EnableStreamSharing, MediaSourceId = stream.MediaSource.Id }).ToArray();
}
public class ControlledStream(string uniqueId, MediaSourceInfo source, bool enabled) : ILiveStream {
    public int ConsumerCount { get; set; } = 1;
    public string OriginalStreamId { get; set; } = null!;
    public string TunerHostId => "controlled";
    public bool EnableStreamSharing => enabled && CloseCount == 0;
    public MediaSourceInfo MediaSource { get; set; } = source;
    public string UniqueId => uniqueId;
    public int CloseCount { get; private set; }
    public Task Open(CancellationToken token) => throw new InvalidOperationException("This oracle must not execute a stream open.");
    public Stream GetStream() => throw new InvalidOperationException("This oracle must not read a native byte stream.");
    public Task Close() { CloseCount++; return Task.CompletedTask; }
    public void Dispose() { }
}
public class Listings(JsonElement source, JsonElement channels, Action<string, object?> trace) : IListingsProvider {
    public string Type => "controlled"; public string Name => "Controlled listings";
    public Task Validate(ListingsProviderInfo info, bool login, bool listings) => Task.CompletedTask;
    public Task<List<NameIdPair>> GetLineups(ListingsProviderInfo info, string country, string location) => Task.FromResult(new List<NameIdPair>());
    public Task<List<ChannelInfo>> GetChannels(ListingsProviderInfo info, CancellationToken cancellationToken) {
        trace("listings.channels", new { id = info.Id }); Tuner.Fail(source, "listingsFailure");
        return Task.FromResult(channels.Deserialize<List<ChannelInfo>>(JsonDefaults.Options)!);
    }
    public Task<IEnumerable<ProgramInfo>> GetProgramsAsync(ListingsProviderInfo info, string channelId, DateTime start, DateTime end, CancellationToken cancellationToken) {
        trace("listings.programs", new { id = info.Id, channelId }); Tuner.Fail(source, "programsFailure");
        return Task.FromResult<IEnumerable<ProgramInfo>>([new ProgramInfo { Id = "program", Name = "Controlled program" }]);
    }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
