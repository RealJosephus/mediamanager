using System.Collections.Concurrent;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.LiveTv.TunerHosts;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Streaming;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.MediaInfo;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var inputBytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(inputBytes).RootElement;
var root = Path.GetFullPath(args[2]); Directory.CreateDirectory(root);
var json = new JsonSerializerOptions { WriteIndented = true };
string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
byte[] Bytes(JsonElement value) => Enumerable.Range(0, value.GetProperty("length").GetInt32()).Select(index => (byte)((index * 37 + value.GetProperty("seed").GetInt32()) & 255)).ToArray();
var bytes = Bytes(input.GetProperty("payload"));
var publicId = typeof(Jellyfin.LiveTv.LiveTvMediaSourceProvider).FullName!.GetMD5().ToString("N") + "_"
    + typeof(Jellyfin.LiveTv.DefaultLiveTvService).FullName!.GetMD5().ToString("N") + "_retained-source";
const string unique = "a9c000000000000000000000000000ab";
var status = typeof(ExceptionMiddleware).GetMethod("GetStatusCode", BindingFlags.NonPublic | BindingFlags.Static)!;
object Error(Exception error) => new { type = error.GetType().Name, status = (int)status.Invoke(null, [error])!, error.Message };
MediaSourceManager Manager() => new(null!, null!, null!, null!, null!, null!, NullLogger<MediaSourceManager>.Instance, null!, null!, null!, null!, null!, null!);
ConcurrentDictionary<string, ILiveStream> Entries(MediaSourceManager manager) => (ConcurrentDictionary<string, ILiveStream>)typeof(MediaSourceManager).GetField("_openStreams", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(manager)!;
var lookups = new List<object>();
using (var manager = Manager()) {
    var source = new ControlledLive(bytes, unique); Entries(manager)[publicId] = source;
    foreach (var id in new string?[] { publicId, publicId.ToUpperInvariant(), "missing", "", null }) {
        object? error = null; bool found = false, sameSource = false, directProvider = false, infoMatched = false, getLiveStreamMatched = false;
        try { var pair = await manager.GetLiveStreamWithDirectStreamProvider(id!, CancellationToken.None);
            found = pair.Item1 is not null; sameSource = ReferenceEquals(pair.Item1, source.MediaSource);
            directProvider = ReferenceEquals(pair.Item2, source);
            infoMatched = ReferenceEquals(manager.GetLiveStreamInfo(id!), found ? source : null);
            getLiveStreamMatched = ReferenceEquals(await manager.GetLiveStream(id!, CancellationToken.None), pair.Item1); }
        catch (Exception cause) { error = Error(cause); }
        lookups.Add(new { id, found, sameSource, directProvider, infoMatched, getLiveStreamMatched, error });
    }
    if (source.Readers.Count != 0) throw new InvalidOperationException("Retained lookup opened a byte reader.");
    var plain = new PlainLive(bytes, "plain"); Entries(manager)["plain"] = plain;
    var pairPlain = await manager.GetLiveStreamWithDirectStreamProvider("plain", CancellationToken.None);
    lookups.Add(new { id = "plain", found = ReferenceEquals(pairPlain.Item1, plain.MediaSource), sameSource = true, directProvider = pairPlain.Item2 is not null, error = (object?)null });
}
var services = new ServiceCollection(); services.AddLogging(); services.AddMvcCore();
using var provider = services.BuildServiceProvider();
var results = new List<object>();
foreach (var sample in input.GetProperty("controllerCases").EnumerateArray()) {
    using var cancellation = new CancellationTokenSource(); using var output = new MemoryStream();
    var cancelAfter = sample.TryGetProperty("cancelAfter", out var limit) ? limit.GetInt32() : (int?)null;
    var source = new ControlledLive(bytes, unique, cancellation, cancelAfter);
    using var manager = Manager(); Entries(manager)[publicId] = source;
    var controller = new LiveTvController(null!, null!, null!, null!, null!, null!, null!, null!, manager, null!, null!);
    var context = new DefaultHttpContext(); var lifetime = new Lifetime(cancellation.Token); context.Features.Set<IHttpRequestLifetimeFeature>(lifetime);
    context.RequestServices = provider; context.Request.Method = sample.GetProperty("method").GetString()!; context.Response.Body = output;
    if (sample.TryGetProperty("range", out var range)) context.Request.Headers.Range = range.GetString();
    var requested = sample.TryGetProperty("missing", out var missing) && missing.GetBoolean() ? "missing"
        : sample.TryGetProperty("upperUnique", out var upper) && upper.GetBoolean() ? unique.ToUpperInvariant() : unique;
    var action = controller.GetLiveStreamFile(requested, sample.GetProperty("container").GetString()!);
    var progressive = action is FileStreamResult file ? file.FileStream : null;
    object? lengthError = null;
    if (progressive is not null) { try { _ = progressive.Length; } catch (Exception cause) { lengthError = Error(cause); } }
    object? executionFailure = null;
    try { await action.ExecuteResultAsync(new ActionContext(context, new RouteData(), new ActionDescriptor())); }
    catch (OperationCanceledException cause) when (cancellation.IsCancellationRequested) { executionFailure = Error(cause); }
    var payload = output.ToArray();
    results.Add(new { name = sample.GetProperty("name").GetString(), status = context.Response.StatusCode,
        contentType = context.Response.ContentType, contentLength = context.Response.ContentLength,
        acceptRanges = context.Response.Headers.AcceptRanges.FirstOrDefault(), contentRange = context.Response.Headers.ContentRange.FirstOrDefault(),
        bytes = payload.Length, sha256 = Hash(payload), actualProgressive = progressive is ProgressiveFileStream,
        canSeek = progressive?.CanSeek, lengthError, requestAborted = cancellation.IsCancellationRequested,
        contextAborted = lifetime.Aborted, executionFailure, readers = source.Readers.Select(reader => new { reader.ReadCalls, reader.BytesRead, reader.DisposeCalls }).ToArray(),
        consumerCountAfterResult = source.ConsumerCount, getStreamCalls = source.GetStreamCalls, openCalls = source.OpenCalls });
    if (source.Readers.Any(reader => reader.DisposeCalls != 1)) throw new InvalidOperationException("The actual result executor retained a memory reader.");
    await manager.CloseLiveStream(publicId);
    if (source.CloseCalls != 1) throw new InvalidOperationException("The controlled stream owner was not closed exactly once.");
}
object timeout;
using (var memory = new ObservedMemory(bytes, null, null)) {
    using var progressive = new ProgressiveFileStream(memory, timeoutMs: 0); var buffer = new byte[bytes.Length + 1];
    var first = await progressive.ReadAsync(buffer.AsMemory()); var eof = await progressive.ReadAsync(buffer.AsMemory());
    timeout = new { first, eof, sha256 = Hash(buffer.Take(first).ToArray()), memory.ReadCalls };
}
var fileCases = new List<object>();
var appPaths = Stub.Make<IApplicationPaths>((method, _) => method.Name == "get_CachePath" ? root : Stub.Default(method.ReturnType));
var configuration = Stub.Make<IConfigurationManager>((method, _) => method.Name == "GetConfiguration" ? new EncodingOptions { TranscodingTempPath = root }
    : method.Name == "get_CommonApplicationPaths" ? appPaths : Stub.Default(method.ReturnType));
foreach (var sample in input.GetProperty("fileCases").EnumerateArray()) {
    using var source = new PreparedLive(configuration); var fixtureBytes = Bytes(sample); var before = Hash(fixtureBytes);
    var missing = sample.TryGetProperty("missing", out var missingInput) && missingInput.GetBoolean();
    if (!missing) File.WriteAllBytes(source.Filename, fixtureBytes);
    try {
        await source.Open(CancellationToken.None); // Actual base Open only assigns DateOpened.
        source.SetAge(sample.GetProperty("ageSeconds").GetInt32());
        object? error = null; byte[] selected = []; long? position = null;
        try { await using var retained = source.GetStream(); position = retained.Position;
            using var copy = new MemoryStream(); await retained.CopyToAsync(copy); selected = copy.ToArray(); }
        catch (Exception cause) { error = Error(cause); }
        fileCases.Add(new { name = sample.GetProperty("name").GetString(), position, bytes = selected.Length, sha256 = Hash(selected), error,
            actualBaseLiveStreamGetStream = true, preparedSourceSha256 = before, inputUnchanged = missing || Hash(File.ReadAllBytes(source.Filename)) == before });
    } finally { await source.Close(); if (!missing) File.Delete(source.Filename); }
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualRetainedMediaSourceManager = true, actualLiveTvController = true,
    actualFileStreamResultExecutor = true, actualProgressiveFileStream = true, controlledMemoryLiveStream = true,
    sharedHttpStreamOpened = false, tunerOrRecordingStarted = false, nativeEfOpened = false,
    inputSha256 = Hash(inputBytes), publicId, bytes = bytes.Length, payloadSha256 = Hash(bytes), lookups, results, timeout, fileCases,
    assemblies = new[] { typeof(MediaSourceManager).Assembly, typeof(LiveTvController).Assembly, typeof(ProgressiveFileStream).Assembly, typeof(LiveStream).Assembly,
        typeof(FileStreamResult).Assembly }.Distinct().Select(assembly => new { filename = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }) }, json));

public class PlainLive(byte[] bytes, string unique) : ILiveStream {
    public int ConsumerCount { get; set; } = 1;
    public string OriginalStreamId { get; set; } = "retained-source";
    public string TunerHostId => "controlled-retained";
    public bool EnableStreamSharing => true;
    public MediaSourceInfo MediaSource { get; set; } = new() { Id = "retained-source", Protocol = MediaProtocol.Http };
    public string UniqueId => unique;
    public virtual Stream GetStream() => new MemoryStream(bytes, writable: false);
    public virtual Task Open(CancellationToken token) => throw new InvalidOperationException("No controlled stream may open an input.");
    public virtual Task Close() => Task.CompletedTask;
    public void Dispose() { }
}
public sealed class ControlledLive(byte[] bytes, string unique, CancellationTokenSource? cancellation = null, int? cancelAfter = null)
    : PlainLive(bytes, unique), IDirectStreamProvider {
    public List<ObservedMemory> Readers { get; } = [];
    public int GetStreamCalls { get; private set; }
    public int CloseCalls { get; private set; }
    public int OpenCalls { get; private set; }
    public override Stream GetStream() { GetStreamCalls++; var reader = new ObservedMemory(bytes, cancellation, cancelAfter); Readers.Add(reader); return reader; }
    public override Task Open(CancellationToken token) { OpenCalls++; return base.Open(token); }
    public override Task Close() { CloseCalls++; foreach (var reader in Readers) reader.Dispose(); return Task.CompletedTask; }
}
public sealed class ObservedMemory(byte[] bytes, CancellationTokenSource? cancellation, int? cancelAfter) : MemoryStream(bytes, writable: false) {
    private bool _disposed;
    public int ReadCalls { get; private set; }
    public int BytesRead { get; private set; }
    public int DisposeCalls { get; private set; }
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) {
        token.ThrowIfCancellationRequested(); ReadCalls++;
        if (cancelAfter.HasValue && Position >= cancelAfter.Value) { cancellation!.Cancel(); token.ThrowIfCancellationRequested(); }
        var count = cancelAfter.HasValue ? Math.Min(buffer.Length, cancelAfter.Value - (int)Position) : buffer.Length;
        var read = Read(buffer.Span[..count]); BytesRead += read;
        // The controller's default live timeout remains 30000ms. End-of-input
        // represents an explicit consumer cancellation, not a changed timeout.
        if (read == 0) cancellation?.Cancel();
        return ValueTask.FromResult(read);
    }
    protected override void Dispose(bool disposing) { if (_disposed) return; _disposed = true; DisposeCalls++; base.Dispose(disposing); }
}
public sealed class Lifetime(CancellationToken token) : IHttpRequestLifetimeFeature {
    public CancellationToken RequestAborted { get; set; } = token;
    public bool Aborted { get; private set; }
    public void Abort() => Aborted = true;
}
public sealed class PreparedLive(IConfigurationManager configuration) : LiveStream(new MediaSourceInfo(), null!, null!, NullLogger.Instance, configuration, null!) {
    public string Filename => TempFilePath;
    public void SetAge(int seconds) { if (seconds > 0) DateOpened = DateTime.UtcNow.AddSeconds(-seconds); }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
