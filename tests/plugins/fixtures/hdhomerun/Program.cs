using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv.TunerHosts.HdHomerun;
using Jellyfin.Networking.Udp;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.LiveTv;
using MediaBrowser.Model.Net;
using Microsoft.Extensions.Logging;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var json = JsonDefaults.Options;
var root = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1]))!, "private-hdhomerun");
Directory.CreateDirectory(root);
using var handler = new RoutingHandler(input.GetProperty("origin").GetString()!);
using var client = new HttpClient(handler);
var factory = Stub.Make<IHttpClientFactory>((method, _) => method.Name == "CreateClient" ? client : Stub.Default(method.ReturnType));
var options = new LiveTvOptions();
var diagnostics = new List<object>(); var sockets = new ObservedSocketFactory();
HdHomerunHost Host(string cachePath)
{
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name == "get_CachePath" ? cachePath : Stub.Default(method.ReturnType));
    var configuration = Stub.Make<IServerConfigurationManager>((method, values) => method.Name switch
    {
        "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths,
        "GetConfiguration" => (string)values![0]! == "encoding" ? new EncodingOptions() : options,
        _ => Stub.Default(method.ReturnType)
    });
    return new HdHomerunHost(configuration, new CaptureLogger<HdHomerunHost>(diagnostics),
        Stub.Make<IFileSystem>((method, _) => Stub.Default(method.ReturnType)), factory,
        Stub.Make<IServerApplicationHost>((method, _) => Stub.Default(method.ReturnType)), sockets,
        Stub.Make<IStreamHelper>((method, _) => Stub.Default(method.ReturnType)));
}
Exception Unwrap(Exception caught) => caught is TargetInvocationException { InnerException: not null } invoked ? Unwrap(invoked.InnerException!) : caught;
async Task<object?> Invoke(HdHomerunHost host, string method, params object?[] values)
{
    var task = (Task)typeof(HdHomerunHost).GetMethods(BindingFlags.NonPublic | BindingFlags.Instance)
        .Single(value => value.Name == method && value.GetParameters().Length == values.Length).Invoke(host, values)!;
    await task;
    return task.GetType().GetProperty("Result")!.GetValue(task);
}
var results = new List<object>(); var models = new List<object>(); var lineups = new List<object>();
object? discovery = null;
try
{
    foreach (var sample in input.GetProperty("models").EnumerateArray())
    {
        handler.Sample = sample.GetProperty("name").GetString()!; handler.Step = 0;
        var host = Host(root); object? value = null; string? error = null;
        try { value = await Invoke(host, "GetModelInfo", input.GetProperty("defaultInfo").Deserialize<TunerHostInfo>(json)!, false, CancellationToken.None); }
        catch (Exception caught) { error = Unwrap(caught).GetType().Name; }
        models.Add(new { name = handler.Sample, value, error });
    }
    foreach (var sample in input.GetProperty("lineups").EnumerateArray())
    {
        handler.Sample = sample.GetProperty("name").GetString()!; handler.Step = 0;
        var host = Host(root); object? value = null; string? error = null;
        try { value = await Invoke(host, "GetLineup", input.GetProperty("defaultInfo").Deserialize<TunerHostInfo>(json)!, CancellationToken.None); }
        catch (Exception caught) { error = Unwrap(caught).GetType().Name; }
        lineups.Add(new { name = handler.Sample, value, error });
    }
    foreach (var sample in input.GetProperty("cases").EnumerateArray())
    {
        var name = sample.GetProperty("name").GetString()!; handler.Sample = name;
        options.TunerHosts = sample.GetProperty("infos").Deserialize<TunerHostInfo[]>(json)!;
        var cachePath = Path.Combine(root, name); Directory.CreateDirectory(cachePath);
        if (sample.TryGetProperty("cacheBase64", out var initial)) File.WriteAllBytes(Path.Combine(cachePath, options.TunerHosts[0].Id + "_channels"), Convert.FromBase64String(initial.GetString()!));
        var host = Host(cachePath); var observations = new List<object>(); var step = 0;
        foreach (var action in sample.GetProperty("actions").EnumerateArray())
        {
            handler.Step = step++;
            if (action.TryGetProperty("restart", out var restart) && restart.GetBoolean()) host = Host(cachePath);
            var before = handler.Requests.Count; object? value = null; string? error = null;
            try
            {
                switch (action.GetProperty("kind").GetString())
                {
                    case "channels": value = await host.GetChannels(action.GetProperty("enabled").GetBoolean(), CancellationToken.None); break;
                    case "validate": await host.Validate(options.TunerHosts[0]); value = options.TunerHosts[0]; break;
                    case "sources": value = await host.GetChannelStreamMediaSources(action.GetProperty("channelId").GetString()!, CancellationToken.None); break;
                    case "construct":
                    {
                        var channel = (await host.GetChannels(options.TunerHosts[0], true, CancellationToken.None))[0];
                        var streamId = action.GetProperty("streamId").GetString()!;
                        var stream = (ILiveStream)(await Invoke(host, "GetChannelStream", options.TunerHosts[0], channel, streamId, new List<ILiveStream>(), CancellationToken.None))!;
                        value = new { type = stream.GetType().Name, stream.MediaSource,
                            OriginalMediaSource = ((Jellyfin.LiveTv.TunerHosts.LiveStream)stream).OriginalMediaSource,
                            stream.OriginalStreamId, stream.TunerHostId, stream.EnableStreamSharing, stream.ConsumerCount };
                        await stream.Close();
                        stream.Dispose();
                        break;
                    }
                    default: throw new InvalidOperationException("Unknown fixture action.");
                }
            }
            catch (Exception caught) { error = Unwrap(caught).GetType().Name; }
            var filename = options.TunerHosts?.Length > 0 ? Path.Combine(cachePath, options.TunerHosts[0].Id + "_channels") : "";
            observations.Add(new { value, error, requests = handler.Requests.Skip(before).ToArray(), cacheBase64 = File.Exists(filename) ? Convert.ToBase64String(File.ReadAllBytes(filename)) : null });
        }
        results.Add(new { name, observations });
    }
    handler.Sample = "discovery"; handler.Step = 0;
    var discoveryBefore = handler.Requests.Count;
    var devices = await Host(root).DiscoverDevices(input.GetProperty("discoveryDurationMs").GetInt32(), CancellationToken.None);
    discovery = new { devices, requests = handler.Requests.Skip(discoveryBefore).ToArray(), sockets = sockets.Records,
        allSocketsDisposed = sockets.CreatedHandles.All(handle => handle.IsClosed),
        interfaces = NetworkInterface.GetAllNetworkInterfaces().Select(value => new { value.Name, status = value.OperationalStatus.ToString(),
            type = value.NetworkInterfaceType.ToString(), addresses = value.GetIPProperties().UnicastAddresses.Where(address => address.Address.AddressFamily == AddressFamily.InterNetwork)
                .Select(address => new { address = address.Address.ToString(), mask = address.IPv4Mask.ToString() }) }).ToArray() };
}
finally { Directory.Delete(root, true); }
var assemblies = new[] { typeof(HdHomerunHost).Assembly, typeof(ChannelInfo).Assembly, typeof(JsonDefaults).Assembly, typeof(SocketFactory).Assembly }
    .Distinct().Select(assembly => new { path = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    actualHdHomerunHost = true, actualBaseTunerHost = true, actualUdpSocketFactory = true, actualHttpClient = true,
    streamOpenInvoked = false, recordingOrTranscodingStarted = false, privateInputsRemoved = !Directory.Exists(root), models, lineups, results, discovery, diagnostics, assemblies }, json));

public sealed class ObservedSocketFactory : ISocketFactory
{
    public List<object> Records = new(); public List<System.Runtime.InteropServices.SafeHandle> CreatedHandles = new();
    public Socket CreateUdpBroadcastSocket(int localPort)
    {
        var socket = new SocketFactory().CreateUdpBroadcastSocket(localPort); CreatedHandles.Add(socket.SafeHandle);
        Records.Add(new { endpoint = socket.LocalEndPoint!.ToString(), socket.EnableBroadcast, socket.ReceiveBufferSize, socket.SendBufferSize });
        return socket;
    }
}
public sealed class CaptureLogger<T>(List<object> entries) : ILogger<T>
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => level >= LogLevel.Warning;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter)
    {
        if (!IsEnabled(level)) return;
        entries.Add(new { level = level.ToString(), message = formatter(state, error), exception = error?.GetType().Name,
            detail = error?.Message, socketCode = (error as SocketException)?.SocketErrorCode.ToString(), nativeCode = (error as SocketException)?.NativeErrorCode });
    }
}

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    { var result = Create<T, Stub>(); ((Stub)(object)result).Handler = handler; return result; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public sealed class RoutingHandler(string origin) : DelegatingHandler(new HttpClientHandler())
{
    public string Sample = ""; public int Step;
    public List<object> Requests = new();
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var uri = request.RequestUri!.ToString(); Requests.Add(new { uri, clientName = "Default" });
        request.Headers.Add("X-Fixture-Sample", Sample); request.Headers.Add("X-Fixture-Step", Step.ToString());
        // UDP replies carry a real sender IP without an HTTP port. Only route
        // that discovered endpoint into the isolated device server.
        if (Sample == "discovery") request.RequestUri = new Uri(origin + "/discover.json");
        return base.SendAsync(request, token);
    }
}
