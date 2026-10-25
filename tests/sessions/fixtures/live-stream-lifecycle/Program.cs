using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Session;
using Jellyfin.Api.Middleware;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Devices;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Events.Session;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var bytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(bytes).RootElement;
var json = new JsonSerializerOptions { WriteIndented = true };
var streamId = typeof(Jellyfin.LiveTv.LiveTvMediaSourceProvider).FullName!.GetMD5().ToString("N") + "_"
    + typeof(Jellyfin.LiveTv.DefaultLiveTvService).FullName!.GetMD5().ToString("N") + "_session-original";
var itemId = Guid.Parse("a9b00000000000000000000000000001");
var item = new LiveTvChannel { Id = itemId, Name = "Supplied live DTO", ServiceName = "Emby" };
var results = new List<object>();
object? Field(object value, string name) => value.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(value);
object? Info(BaseItemDto? dto) => dto is null ? null : new { dto.Name,
    tracks = dto.MediaStreams?.Select(stream => new { type = stream.Type.ToString(), stream.Index, stream.Codec }).ToArray() };
object Player(SessionInfo session) => new { NowPlaying = session.NowPlayingItem is not null, item = Info(session.NowPlayingItem),
    session.PlayState.LiveStreamId, PositionTicks = session.PlayState.PositionTicks?.ToString(CultureInfo.InvariantCulture),
    session.PlayState.IsPaused, session.PlayState.MediaSourceId };
var statusMethod = typeof(ExceptionMiddleware).GetMethod("GetStatusCode", BindingFlags.NonPublic | BindingFlags.Static)!;
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var trace = new List<object>(); var timerEvidence = new List<object>(); var sessions = new Dictionary<string, SessionInfo>();
    var disposedControllers = new List<string>(); var closeCalls = new List<string>(); var snapshots = new List<object>();
    var logger = new CaptureLogger(); var configuration = new ServerConfiguration { InactiveSessionThreshold = 1 };
    var sourceRevision = 0; var mediaLookups = 0; var dtoLookups = 0;
    var deviceSubscriptions = 0; var deviceUnsubscriptions = 0;
    var cancellation = new CancellationTokenSource();
    var lifetime = Stub.Make<IHostApplicationLifetime>((method, _) => method.Name is "get_ApplicationStopping" or "get_ApplicationStarted" or "get_ApplicationStopped"
        ? cancellation.Token : Stub.Default(method.ReturnType));
    var eventManager = Stub.Make<IEventManager>((method, values) => {
        if (values?[0] is PlaybackProgressEventArgs progress) trace.Add(new { kind = progress.GetType().Name,
            session = progress.Session.DeviceId, play = progress.PlaySessionId,
            position = progress.PlaybackPositionTicks?.ToString(CultureInfo.InvariantCulture), item = Info(progress.MediaInfo) });
        else if (values?[0] is SessionEndedEventArgs ended) trace.Add(new { kind = "SessionEnded", session = ended.Argument.DeviceId });
        return Stub.Default(method.ReturnType);
    });
    var throwClose = sample.TryGetProperty("throwCloseOnce", out var failClose) && failClose.GetBoolean();
    TaskCompletionSource? closeEntered = null, closeRelease = null;
    async Task Close(string identity) {
        closeCalls.Add(identity); trace.Add(new { kind = "close", id = identity });
        if (closeEntered is not null) { closeEntered.TrySetResult(); await closeRelease!.Task; }
        if (throwClose) { throwClose = false; throw new InvalidOperationException("Controlled close failure."); }
    }
    var media = Stub.Make<IMediaSourceManager>((method, values) => {
        if (method.Name == "CloseLiveStream") return Close((string)values![0]!);
        if (method.Name == "GetMediaSource") { mediaLookups++; return Task.FromResult(new MediaSourceInfo { MediaStreams = [
            new() { Type = MediaStreamType.Video, Index = -1, Codec = "revision-" + sourceRevision },
            new() { Type = MediaStreamType.Audio, Index = -1, Codec = "revision-" + sourceRevision }] }); }
        return Stub.Default(method.ReturnType);
    });
    var library = Stub.Make<ILibraryManager>((method, _) => method.Name == "GetItemById" ? item : Stub.Default(method.ReturnType));
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration" ? configuration : Stub.Default(method.ReturnType));
    var host = Stub.Make<IServerApplicationHost>((method, _) => method.Name == "get_SystemId" ? "session-native" : Stub.Default(method.ReturnType));
    var devices = Stub.Make<IDeviceManager>((method, _) => {
        if (method.Name == "add_DeviceOptionsUpdated") deviceSubscriptions++;
        if (method.Name == "remove_DeviceOptionsUpdated") deviceUnsubscriptions++;
        return Stub.Default(method.ReturnType);
    });
    var manager = new SessionManager(logger, eventManager, Stub.Make<IUserDataManager>((method, _) => Stub.Default(method.ReturnType)), config,
        library, Stub.Make<IUserManager>((method, _) => Stub.Default(method.ReturnType)), Stub.Make<IMusicManager>((method, _) => Stub.Default(method.ReturnType)),
        Stub.Make<IDtoService>((method, _) => method.Name == "GetBaseItemDto" ? new BaseItemDto { Id = itemId, Name = "Generated DTO " + ++dtoLookups } : Stub.Default(method.ReturnType)),
        Stub.Make<IImageProcessor>((method, _) => Stub.Default(method.ReturnType)),
        host, devices, media, lifetime);
    var controllers = new Dictionary<string, Control>();
    try {
        foreach (var alias in sample.GetProperty("sessions").EnumerateArray().Select(value => value.GetString()!)) {
            var session = await manager.LogSessionActivity("Lifecycle", "1", alias, alias, "127.0.0.1", null!);
            sessions.Add(alias, session); controllers.Add(alias, new Control(alias, trace, disposedControllers)); session.SessionControllers = [controllers[alias]];
        }
        trace.Clear();
        foreach (var action in sample.GetProperty("actions").EnumerateArray()) {
            var kind = action.GetProperty("kind").GetString()!;
            var alias = action.TryGetProperty("session", out var selected) ? selected.GetString()! : "";
            var sessionId = sessions.TryGetValue(alias, out var current) ? current.Id : "missing";
            var selectedLive = action.TryGetProperty("unknownStream", out var unknown) && unknown.GetBoolean() ? streamId + "-unknown" : streamId;
            var live = action.TryGetProperty("upperStream", out var upper) && upper.GetBoolean() ? selectedLive.ToUpperInvariant() : selectedLive;
            var play = action.TryGetProperty("play", out var played) ? played.GetString() : null;
            var position = action.TryGetProperty("position", out var ticks) ? long.Parse(ticks.GetString()!, CultureInfo.InvariantCulture) : 123L;
            var dto = new BaseItemDto { Id = itemId, Name = "Supplied live DTO" };
            var noItem = action.TryGetProperty("noItem", out var omitItem) && omitItem.GetBoolean();
            PlaybackStartInfo Start() => new() { SessionId = sessionId, ItemId = noItem ? itemId : Guid.Empty, Item = noItem ? null : dto, LiveStreamId = live, PlaySessionId = play, PositionTicks = position, IsPaused = true, PlayMethod = PlayMethod.DirectPlay };
            PlaybackProgressInfo Progress() => new() { SessionId = sessionId, ItemId = noItem ? itemId : Guid.Empty, Item = noItem ? null : dto, LiveStreamId = live, PlaySessionId = play, PositionTicks = position, IsPaused = true, PlayMethod = PlayMethod.DirectPlay };
            PlaybackStopInfo Stop() => new() { SessionId = sessionId, ItemId = noItem ? itemId : Guid.Empty, Item = noItem ? null : dto, LiveStreamId = live, PlaySessionId = play, PositionTicks = position };
            object? failure = null, held = null;
            try {
                switch (kind) {
                    case "start": await manager.OnPlaybackStart(Start()); break;
                    case "progress": await manager.OnPlaybackProgress(Progress()); break;
                    case "source-revision": sourceRevision++; break;
                    case "stop": await manager.OnPlaybackStopped(Stop()); break;
                    case "close":
                        var identity = action.GetProperty("identity").GetString()!;
                        if (identity == "$session") identity = sessionId;
                        if (action.TryGetProperty("upperIdentity", out var upperIdentity) && upperIdentity.GetBoolean()) identity = identity.ToUpperInvariant();
                        await manager.CloseLiveStreamIfNeededAsync(live, identity); break;
                    case "end": await manager.ReportSessionEnded(sessionId); break;
                    case "disconnect": controllers[alias].Active = false; await manager.CloseIfNeededAsync(current!); break;
                    case "idle": current!.LastPlaybackCheckIn = DateTime.UtcNow.AddMinutes(-6);
                        await AsyncVoidScope.Invoke(manager, "CheckForIdlePlayback"); break;
                    case "inactive": current!.LastPausedDate = DateTime.UtcNow.AddMinutes(-2);
                        await AsyncVoidScope.Invoke(manager, "CheckForInactiveSteams"); break;
                    case "held-negative":
                        closeEntered = new(TaskCreationOptions.RunContinuationsAsynchronously); closeRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
                        var pending = manager.OnPlaybackStopped(Stop());
                        try { await closeEntered.Task.WaitAsync(TimeSpan.FromSeconds(20));
                            held = new { pending = !pending.IsCompleted, nowPlaying = current!.NowPlayingItem is not null, closeCalls = closeCalls.Count };
                        } finally { closeRelease.TrySetResult(); }
                        await pending; break;
                    default: throw new InvalidOperationException("Unknown lifecycle action.");
                }
            } catch (Exception error) {
                failure = new { type = error.GetType().Name, status = (int)statusMethod.Invoke(null, [error])!, error.Message };
                trace.Add(new { kind = "error", type = error.GetType().Name, message = error.Message });
            } finally {
                closeRelease?.TrySetResult(); closeEntered = closeRelease = null;
                foreach (var session in sessions.Values) {
                    var progressTimer = Field(session, "_progressTimer") is not null;
                    session.StopAutomaticProgress();
                    timerEvidence.Add(new { action = kind, session = session.DeviceId, progressTimerCreated = progressTimer, progressTimerReleased = Field(session, "_progressTimer") is null });
                }
            }
            snapshots.Add(new { action = kind, failure, held, closeCalls = closeCalls.ToArray(), mediaLookups, dtoLookups,
                managerTimers = new { idle = Field(manager, "_idleTimer") is not null, inactive = Field(manager, "_inactiveTimer") is not null },
                sessions = manager.Sessions.OrderBy(value => value.DeviceId, StringComparer.Ordinal).Select(value => new { alias = value.DeviceId, state = Player(value) }).ToArray(),
                mappings = JsonSerializer.SerializeToElement(Field(manager, "_activeLiveStreamSessions"), json),
                trace = trace.ToArray(), errors = logger.Errors.ToArray() });
        }
    } finally { await manager.DisposeAsync(); cancellation.Dispose(); }
    if (Field(manager, "_idleTimer") is not null || Field(manager, "_inactiveTimer") is not null
        || sessions.Values.Any(value => Field(value, "_progressTimer") is not null)) throw new InvalidOperationException("Actual session timers survived disposal.");
    if (deviceSubscriptions != 1 || deviceUnsubscriptions != 1) throw new InvalidOperationException("Actual device subscription ownership did not balance.");
    results.Add(new { name = sample.GetProperty("name").GetString(), snapshots, timerEvidence,
        disposedControllers = disposedControllers.OrderBy(value => value, StringComparer.Ordinal).ToArray(),
        deviceSubscriptions, deviceUnsubscriptions, timersReleased = true, actualSessionManagerDisposed = true });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualSessionManager = true, actualSessionInfoTimers = true,
    actualPrivateIdleAndInactiveCallbacks = true, mediaSourceCloseControlled = true, usersAndSuppliedDtoControlled = true,
    nativeEfOpened = false, tunerOrRecorderStarted = false, streamId, itemId = itemId.ToString("N"),
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), results,
    assemblies = new[] { typeof(SessionManager).Assembly, typeof(SessionInfo).Assembly, typeof(ExceptionMiddleware).Assembly, typeof(Jellyfin.LiveTv.LiveTvMediaSourceProvider).Assembly }.Distinct()
        .Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }) }, json));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type == typeof(ValueTask) ? ValueTask.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public sealed class CaptureLogger : ILogger<SessionManager> {
    public List<string> Errors { get; } = [];
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) { if (level >= LogLevel.Error) Errors.Add(error?.Message ?? formatter(state, error)); }
}
public sealed class Control(string alias, List<object> trace, List<string> disposed) : ISessionController, IAsyncDisposable {
    public bool Active { get; set; } = true;
    public bool IsSessionActive => Active;
    public bool SupportsMediaControl => true;
    public Task SendMessage<T>(SessionMessageType name, Guid messageId, T data, CancellationToken cancellationToken) {
        if (data is PlaystateRequest request) trace.Add(new { kind = "command", session = alias, type = name.ToString(),
            command = request.Command.ToString(), request.ControllingUserId, position = request.SeekPositionTicks?.ToString(CultureInfo.InvariantCulture) });
        return Task.CompletedTask;
    }
    public ValueTask DisposeAsync() { disposed.Add(alias); return ValueTask.CompletedTask; }
}
public sealed class AsyncVoidScope : SynchronizationContext {
    private readonly TaskCompletionSource _finished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public override void OperationStarted() { }
    public override void OperationCompleted() => _finished.TrySetResult();
    public override void Post(SendOrPostCallback callback, object? state) => ThreadPool.QueueUserWorkItem(_ => {
        try { callback(state); } catch (Exception error) { _finished.TrySetException(error); }
    });
    public static async Task Invoke(object target, string name) {
        var scope = new AsyncVoidScope(); var previous = Current;
        try { SetSynchronizationContext(scope); target.GetType().GetMethod(name, BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(target, [null]); }
        finally { SetSynchronizationContext(previous); }
        await scope._finished.Task.WaitAsync(TimeSpan.FromSeconds(20));
    }
}
