using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv.TunerHosts;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.LiveTv;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var json = JsonDefaults.Options;
var root = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1]))!, "private-m3u-inputs");
Directory.CreateDirectory(root);
var parsed = new List<object>(); var sources = new List<object>(); var validation = new List<object>();
var cache = new List<object>();
var cacheFiles = new List<object>();
var cacheIdentities = new List<object>();
object? multipleHosts = null;
var handler = new ControlledHandler();
using var client = new HttpClient(handler);
var factory = Stub.Make<IHttpClientFactory>((method, _) => method.Name == "CreateClient" ? client : Stub.Default(method.ReturnType));
var fileSystem = Stub.Make<IFileSystem>((method, _) => method.Name == "IsPathFile" ? true : Stub.Default(method.ReturnType));
var media = (MediaSourceManager)RuntimeHelpers.GetUninitializedObject(typeof(MediaSourceManager));
typeof(MediaSourceManager).GetField("_fileSystem", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(media, fileSystem);
M3UTunerHost Host(LiveTvOptions options, string cachePath, bool local = false)
{
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name == "get_CachePath" ? cachePath : Stub.Default(method.ReturnType));
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch
    {
        "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths,
        "GetConfiguration" => options,
        _ => Stub.Default(method.ReturnType)
    });
    return new M3UTunerHost(config, media, NullLogger<M3UTunerHost>.Instance, fileSystem, factory,
        Stub.Make<IServerApplicationHost>((method, _) => Stub.Default(method.ReturnType)),
        Stub.Make<INetworkManager>((method, _) => method.Name == "IsInLocalNetwork" ? local : Stub.Default(method.ReturnType)),
        Stub.Make<IStreamHelper>((method, _) => Stub.Default(method.ReturnType)));
}
try
{
    foreach (var sample in input.GetProperty("parsers").EnumerateArray())
    {
        var info = sample.GetProperty("info").Deserialize<TunerHostInfo>(json)!;
        handler.Bytes = Convert.FromBase64String(sample.GetProperty("bytesBase64").GetString()!); handler.Fail = false; handler.Status = HttpStatusCode.OK;
        var requests = handler.Requests.Count; var disposed = handler.Disposed;
        var channels = await new M3uParser(NullLogger.Instance, factory).Parse(info,
            "m3u_" + info.Url.GetMD5().ToString("N"), CancellationToken.None);
        parsed.Add(new { name = sample.GetProperty("name").GetString(), channels,
            requests = handler.Requests.Skip(requests).ToArray(), streamsDisposed = handler.Disposed - disposed });
    }
    foreach (var sample in input.GetProperty("sources").EnumerateArray())
    {
        var info = sample.GetProperty("info").Deserialize<TunerHostInfo>(json)!;
        var host = Host(new LiveTvOptions(), root, sample.GetProperty("local").GetBoolean());
        var channel = new MediaBrowser.Controller.LiveTv.ChannelInfo { Path = sample.GetProperty("path").GetString()! };
        var result = typeof(M3UTunerHost).GetMethod("CreateMediaSourceInfo", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(host, new object[] { info, channel });
        sources.Add(new { name = sample.GetProperty("name").GetString(), mediaSource = result });
    }
    foreach (var status in new[] { HttpStatusCode.OK, HttpStatusCode.NoContent, HttpStatusCode.NotFound })
    {
        handler.Bytes = "This is deliberately not a playlist."u8.ToArray(); handler.Status = status; handler.Fail = false;
        var disposed = handler.Disposed; string? error = null;
        try { await Host(new LiveTvOptions(), root).Validate(new TunerHostInfo { Url = "http://fixture.invalid/validate" }); }
        catch (Exception cause) { error = cause.GetType().Name; }
        validation.Add(new { status = (int)status, error, streamsDisposed = handler.Disposed - disposed });
    }
    handler.Status = HttpStatusCode.OK; handler.Fail = false;
    var tuner = input.GetProperty("cacheInfo").Deserialize<TunerHostInfo>(json)!;
    var options = new LiveTvOptions { TunerHosts = new[] { tuner } };
    var hostCache = Path.Combine(root, "native-cache"); Directory.CreateDirectory(hostCache);
    var current = Host(options, hostCache);
    void Snapshot(string name) {
        var contents = File.ReadAllBytes(Path.Combine(hostCache, tuner.Id + "_channels"));
        cacheFiles.Add(new { name, bytesBase64 = Convert.ToBase64String(contents), length = contents.Length,
            sha256 = Convert.ToHexStringLower(SHA256.HashData(contents)) });
    }
    handler.Bytes = Convert.FromBase64String(input.GetProperty("cacheBytesBase64").GetString()!);
    async Task Observe(string name, M3UTunerHost host, bool enabled)
    {
        var requests = handler.Requests.Count;
        List<ChannelInfo>? channels = null; string? error = null;
        try { channels = await host.GetChannels(enabled, CancellationToken.None); } catch (Exception caught) { error = caught.GetType().Name; }
        cache.Add(new { name, channels, error, requests = handler.Requests.Count - requests });
    }
    await Observe("first-force", current, false);
    Snapshot("first-force");
    handler.Fail = true;
    await Observe("memory-after-source-failure", current, true);
    await Observe("force-failure", current, false);
    await Observe("cold-native-disk-fallback", Host(options, hostCache), true);
    handler.Fail = false; handler.Bytes = "#EXTM3U\n"u8.ToArray();
    await Observe("force-empty", current, false);
    Snapshot("force-empty");
    await Observe("nonempty-memory-survives-empty", current, true);
    handler.Fail = true;
    await Observe("cold-empty-native-disk", Host(options, hostCache), true);
    var nodeRoot = Path.Combine(root, "node-cache-reader"); Directory.CreateDirectory(nodeRoot);
    File.Copy(input.GetProperty("nodeCacheFile").GetString()!, Path.Combine(nodeRoot, tuner.Id + "_channels"));
    await Observe("actual-native-reads-node-cache", Host(options, nodeRoot), true);
    handler.Fail = false; handler.Bytes = Convert.FromBase64String(input.GetProperty("cacheBytesBase64").GetString()!);
    var multiOptions = new LiveTvOptions { TunerHosts = input.GetProperty("multiInfos").Deserialize<TunerHostInfo[]>(json)! };
    var beforeMultiple = handler.Requests.Count;
    multipleHosts = new { channels = await Host(multiOptions, Path.Combine(root, "multiple-cache")).GetChannels(false, CancellationToken.None),
        requests = handler.Requests.Count - beforeMultiple };
    foreach (var sample in input.GetProperty("cacheIdentities").EnumerateArray())
    {
        var name = sample.GetProperty("name").GetString()!;
        var info = sample.GetProperty("info").Deserialize<TunerHostInfo>(json)!;
        var cachePath = Path.Combine(root, "cache-identity-" + name); Directory.CreateDirectory(cachePath);
        var filename = Path.Combine(cachePath, info.Id + "_channels");
        var observations = new List<object>();
        async Task Capture(string phase, bool enabled)
        {
            var before = handler.Requests.Count; List<ChannelInfo>? channels = null; string? error = null;
            // Each phase has a fresh real BaseTunerHost, so the second read
            // cannot succeed using the first host's channel dictionary.
            try { channels = await Host(new LiveTvOptions { TunerHosts = new[] { info } }, cachePath).GetChannels(enabled, CancellationToken.None); }
            catch (Exception caught) { error = caught.GetType().Name; }
            var contents = File.Exists(filename) ? File.ReadAllBytes(filename) : null;
            observations.Add(new { name = phase, channels, failed = error is not null, error,
                requests = handler.Requests.Skip(before).ToArray(), cache = contents is null ? null : new {
                    filename = Path.GetFileName(filename), bytesBase64 = Convert.ToBase64String(contents), length = contents.Length,
                    sha256 = Convert.ToHexStringLower(SHA256.HashData(contents)) } });
        }
        handler.Fail = false; handler.Status = HttpStatusCode.OK;
        handler.Bytes = Convert.FromBase64String(input.GetProperty("cacheBytesBase64").GetString()!);
        await Capture("force", false);
        handler.Fail = true; await Capture("cold-source-failure", true);
        cacheIdentities.Add(new { name, info, observations });
    }
}
finally { Directory.Delete(root, true); }
var assemblies = new[] { typeof(M3uParser).Assembly, typeof(M3UTunerHost).Assembly, typeof(MediaSourceManager).Assembly,
    typeof(ChannelInfo).Assembly, typeof(JsonDefaults).Assembly }.Distinct().Select(assembly => new { name = assembly.GetName().Name,
        path = assembly.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    actualM3uParser = true, actualBaseTunerHost = true, actualM3uTunerHost = true, actualPathProtocol = true,
    networkClassificationControlled = true, transportControlled = true, recordingOrTranscodingStarted = false,
    privateInputsRemoved = !Directory.Exists(root), parsed, sources, validation, cache, cacheFiles, multipleHosts, cacheIdentities, assemblies }, json));

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    { var result = Create<T, Stub>(); ((Stub)(object)result).Handler = handler; return result; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class ControlledHandler : HttpMessageHandler
{
    public byte[] Bytes = Array.Empty<byte>(); public bool Fail; public HttpStatusCode Status = HttpStatusCode.OK; public int Disposed;
    public List<object> Requests = new();
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        token.ThrowIfCancellationRequested(); Requests.Add(new { uri = request.RequestUri!.ToString(), userAgent = request.Headers.UserAgent.ToString() });
        if (Fail) throw new HttpRequestException("Controlled playlist source failure.");
        return Task.FromResult(new HttpResponseMessage(Status) { Content = new StreamContent(new TrackedStream(Bytes, () => Disposed++)) });
    }
}
public class TrackedStream : MemoryStream
{
    private readonly Action _closed; private bool _disposed;
    public TrackedStream(byte[] bytes, Action closed) : base(bytes) { _closed = closed; }
    protected override void Dispose(bool disposing) { if (!_disposed) { _disposed = true; _closed(); } base.Dispose(disposing); }
}
