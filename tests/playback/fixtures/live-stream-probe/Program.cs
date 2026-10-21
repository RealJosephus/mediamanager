using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using Jellyfin.Extensions.Json;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.MediaInfo;
using Microsoft.Extensions.Logging;

var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US"); CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo("en-US");
var json = JsonDefaults.Options; var privateRoot = Path.Combine(Path.GetDirectoryName(args[1])!, "private-inputs"); Directory.CreateDirectory(privateRoot);
var typed = new List<object>(); var results = new List<object>();
var add = typeof(MediaSourceManager).GetMethod("AddMediaInfo", BindingFlags.NonPublic | BindingFlags.Static)!;
Exception Unwrap(Exception caught) => caught is TargetInvocationException { InnerException: not null } target ? Unwrap(target.InnerException!) : caught;
string? Disk(string filename) => File.Exists(filename) ? Convert.ToBase64String(File.ReadAllBytes(filename)) : null;
try
{
    foreach (var sample in input.GetProperty("typed").EnumerateArray())
    {
        MediaInfo? value = null; string? error = null;
        try { value = JsonSerializer.Deserialize<MediaInfo>(sample.GetProperty("body").GetString()!, json); }
        catch (Exception caught) { error = Unwrap(caught).GetType().Name; }
        typed.Add(new { name = sample.GetProperty("name").GetString(), value, error });
    }
    foreach (var sample in input.GetProperty("cases").EnumerateArray())
    {
        var name = sample.GetProperty("name").GetString()!;
        var root = Path.Combine(privateRoot, name); Directory.CreateDirectory(root);
        var cacheKey = sample.GetProperty("cacheKey").GetString();
        var filename = Path.Combine(root, "mediainfo", (cacheKey ?? "").GetMD5().ToString("N") + ".json");
        if (sample.TryGetProperty("cacheBase64", out var initial)) { Directory.CreateDirectory(Path.GetDirectoryName(filename)!); File.WriteAllBytes(filename, Convert.FromBase64String(initial.GetString()!)); }
        var paths = Stub.Make<IApplicationPaths>((method, _) => method.Name == "get_CachePath" ? root : Stub.Default(method.ReturnType));
        var observations = new List<object>();
        foreach (var action in sample.GetProperty("actions").EnumerateArray())
        {
            var source = JsonSerializer.Deserialize<MediaSourceInfo>(action.GetProperty("source").GetString()!, json)!;
            var calls = new List<object>(); var logs = new List<object>(); var clock = Stopwatch.StartNew();
            using var cancellation = new CancellationTokenSource();
            if (action.TryGetProperty("cancelAfterMs", out var cancelAfter)) cancellation.CancelAfter(cancelAfter.GetInt32());
            var encoder = Stub.Make<IMediaEncoder>((method, values) => method.Name == "GetMediaInfo"
                ? Encode((MediaInfoRequest)values![0]!, (CancellationToken)values[1]!) : Stub.Default(method.ReturnType));
            async Task<MediaInfo> Encode(MediaInfoRequest request, CancellationToken token)
            {
                calls.Add(new { request.MediaType, request.ExtractChapters, request.MediaSource.AnalyzeDurationMs,
                    request.MediaSource.Path, request.MediaSource.Protocol, request.MediaSource.RequiredHttpHeaders,
                    elapsedMs = clock.Elapsed.TotalMilliseconds, canCancel = token.CanBeCanceled });
                if (action.TryGetProperty("holdUntilCancel", out var hold) && hold.GetBoolean()) { cancellation.CancelAfter(40); await Task.Delay(Timeout.Infinite, token); }
                if (action.TryGetProperty("probeFailure", out var fail)) throw fail.GetString() == "IOException" ? new IOException("Controlled media probe failure.") : new InvalidOperationException("Controlled media probe failure.");
                return JsonSerializer.Deserialize<MediaInfo>(action.GetProperty("information").GetString()!, json)!;
            }
            string? error = null; object? clone = null; var before = Disk(filename); var owner = new ControlledStream(source);
            var mode = action.GetProperty("mode").GetString();
            try
            {
                if (mode == "manager")
                {
                    using var manager = new MediaSourceManager(null!, null!, paths, null!, null!, null!, new CaptureLogger<MediaSourceManager>(logs), null!, null!, encoder, null!, null!, null!);
                    manager.AddParts([new ProbeProvider(owner)]);
                    var opened = await manager.OpenLiveStreamInternal(new LiveStreamRequest { OpenToken = cacheKey! }, cancellation.Token);
                    clone = opened.Item1.MediaSource;
                    await manager.CloseLiveStream(source.LiveStreamId);
                }
                else if (mode == "fallback-only") add.Invoke(null, [owner.MediaSource]);
                else
                {
                    try { await new LiveStreamHelper(encoder, new CaptureLogger<LiveStreamHelper>(logs), paths)
                        .AddMediaInfoWithProbe(owner.MediaSource, false, cacheKey, action.GetProperty("addProbeDelay").GetBoolean(), cancellation.Token); }
                    catch (Exception caught)
                    {
                        if (mode != "helper-fallback") throw;
                        logs.Add(new { level = "Error", exception = Unwrap(caught).GetType().Name, message = "component-fallback" });
                        add.Invoke(null, [owner.MediaSource]);
                    }
                }
            }
            catch (Exception caught) { error = Unwrap(caught).GetType().Name; }
            observations.Add(new { error, source, clone, calls, logs, cacheBefore = before, cacheAfter = Disk(filename), elapsedMs = clock.Elapsed.TotalMilliseconds,
                owner = new { owner.OpenCalls, owner.ReadCalls, owner.CloseCalls, owner.ConsumerCount } });
        }
        results.Add(new { name, observations });
    }
}
finally { Directory.Delete(privateRoot, true); }
var assemblies = new[] { typeof(LiveStreamHelper).Assembly, typeof(MediaSourceManager).Assembly, typeof(MediaInfo).Assembly, typeof(JsonDefaults).Assembly }.Distinct()
    .Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualLiveStreamHelper = true, actualMediaSourceManagerOpen = true, actualMediaSourceManagerAdd = true,
    actualTypedMediaInfo = true, controlledEncoder = true, nativeFfprobeExecuted = false, nativeStreamOpenExecuted = false,
    recordingOrTranscodingStarted = false, privateInputsRemoved = !Directory.Exists(privateRoot), providerPrefix = typeof(ProbeProvider).FullName!.GetMD5().ToString("N") + "_",
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), assemblies, typed, results }, json));

public sealed class ProbeProvider(ControlledStream stream) : IMediaSourceProvider
{
    public Task<IEnumerable<MediaSourceInfo>> GetMediaSources(BaseItem item, CancellationToken token) => throw new InvalidOperationException("No source enumeration in this component fixture.");
    public Task<ILiveStream> OpenMediaSource(string key, List<ILiveStream> current, CancellationToken token) => Task.FromResult<ILiveStream>(stream);
}
public sealed class ControlledStream(MediaSourceInfo source) : ILiveStream
{
    public MediaSourceInfo MediaSource { get; set; } = source;
    public int ConsumerCount { get; set; } = 1;
    public string OriginalStreamId { get; set; } = "component";
    public string TunerHostId => "component";
    public bool EnableStreamSharing => false;
    public string UniqueId => "controlled-stream";
    public int OpenCalls, ReadCalls, CloseCalls;
    public Task Open(CancellationToken token) { OpenCalls++; throw new InvalidOperationException("Native stream execution is forbidden."); }
    public Stream GetStream() { ReadCalls++; throw new InvalidOperationException("Native stream reading is forbidden."); }
    public Task Close() { CloseCalls++; return Task.CompletedTask; }
    public void Dispose() { }
}
public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    { var result = Create<T, Stub>(); ((Stub)(object)result).Handler = handler; return result; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public sealed class CaptureLogger<T>(List<object> entries) : ILogger<T>
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => level >= LogLevel.Error;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter)
    { if (IsEnabled(level)) entries.Add(new { level = level.ToString(), exception = error?.GetType().Name, message = formatter(state, error) }); }
}
