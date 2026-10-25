using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Helpers;
using Jellyfin.Data.Enums;
using Jellyfin.Extensions.Json;
using Jellyfin.Server;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Streaming;
using MediaBrowser.MediaEncoding.Configuration;
using MediaBrowser.MediaEncoding.Encoder;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dlna;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

// A real apphost with a deliberately closed execution boundary. Capability
// enumeration, filters, hardware and non-copy codecs never reach FFmpeg.
if (args.Length > 0 && args[0].StartsWith('-')) {
    using var document = JsonDocument.Parse(File.ReadAllBytes(Environment.GetEnvironmentVariable("MEDIAMANAGER_FLAC_COPY_CONTROL")!));
    var control = document.RootElement;
    var probe = Path.GetFileNameWithoutExtension(Environment.ProcessPath!) == "ffprobe";
    var version = args.Length == 1 && args[0] == "-version";
    var index = Array.IndexOf(args, "-i");
    var original = index >= 0 && index + 1 < args.Length && Uri.TryCreate(args[index + 1], UriKind.Absolute, out var uri)
        && uri.Scheme == "http" && uri.Host == "127.0.0.1";
    var codecFlags = args.Select((value, i) => (value, i)).Where(pair => pair.value is "-c" or "-codec" or "-acodec" or "-vcodec" or "-scodec"
        || pair.value.StartsWith("-c:", StringComparison.Ordinal) || pair.value.StartsWith("-codec:", StringComparison.Ordinal)).ToArray();
    var copy = codecFlags.Length > 0 && codecFlags.All(pair => pair.i + 1 < args.Length && args[pair.i + 1] == "copy");
    var forbidden = args.Any(value => value is "lavfi" or "-init_hw_device" or "-vf" or "-af" or "-ac" or "-show_frames"
        || value.StartsWith("-hwaccel", StringComparison.Ordinal) || value.StartsWith("-filter", StringComparison.Ordinal)
        || value.StartsWith("nullsrc", StringComparison.Ordinal));
    var output = args[^1];
    var outputAllowed = probe || version || output == "pipe:1" || Within(control.GetProperty("outputRoot").GetString()!, output);
    var admitted = version || original && !forbidden && outputAllowed && (probe || copy);
    var trace = Path.Combine(control.GetProperty("traceDirectory").GetString()!, Guid.NewGuid().ToString("N") + ".json");
    Directory.CreateDirectory(Path.GetDirectoryName(trace)!);
    if (!admitted) {
        File.WriteAllText(trace, JsonSerializer.Serialize(new { wrapperPid = Environment.ProcessId, childPid = (int?)null, arguments = args,
            forwarded = false, boundary = "Only version, original probing and explicit packet copy are admitted." }));
        Environment.ExitCode = 2; return;
    }
    var executable = control.GetProperty(probe ? "ffprobe" : "ffmpeg").GetString()!;
    var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var argument in args) start.ArgumentList.Add(argument);
    using var process = Process.Start(start) ?? throw new IOException("The admitted original-media process did not start.");
    process.StandardInput.Close();
    var traceRow = new Dictionary<string, object?> { ["wrapperPid"] = Environment.ProcessId, ["childPid"] = process.Id,
        ["executable"] = executable, ["arguments"] = args, ["forwarded"] = true };
    File.WriteAllText(trace, JsonSerializer.Serialize(traceRow));
    using var termination = OperatingSystem.IsWindows() ? null : PosixSignalRegistration.Create(PosixSignal.SIGTERM, context => {
        context.Cancel = true; try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
    });
    var stdout = Forward(process.StandardOutput.BaseStream, Console.OpenStandardOutput(), trace + ".stdout.bin", process);
    var stderr = Forward(process.StandardError.BaseStream, Console.OpenStandardError(), trace + ".stderr.bin", process);
    await process.WaitForExitAsync();
    var pipeErrors = new List<Exception>();
    foreach (var task in new[] { stdout, stderr }) try { await task; } catch (Exception error) { pipeErrors.Add(error); }
    traceRow["exitCode"] = process.ExitCode; traceRow["stdout"] = Descriptor(trace + ".stdout.bin"); traceRow["stderr"] = Descriptor(trace + ".stderr.bin");
    traceRow["pipeErrors"] = pipeErrors.Select(Failure).ToArray(); File.WriteAllText(trace, JsonSerializer.Serialize(traceRow));
    if (pipeErrors.Count > 0) throw new AggregateException("Original-media process output failed.", pipeErrors);
    Environment.ExitCode = process.ExitCode; return;
}

CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
var inputBytes = File.ReadAllBytes(args[0]); using var inputDocument = JsonDocument.Parse(inputBytes); var input = inputDocument.RootElement;
var outputFile = args[1]; var root = Path.Combine(Path.GetDirectoryName(outputFile)!, "state"); Directory.CreateDirectory(root);
var originalPath = input.GetProperty("assetPath").GetString()!; var originalBytes = File.ReadAllBytes(originalPath);
if (Hash(originalBytes) != input.GetProperty("asset").GetProperty("sha256").GetString()) throw new InvalidOperationException("The original FLAC bytes differ from the input seal.");
var json = new JsonSerializerOptions(JsonDefaults.Options) { WriteIndented = true };
var report = new Dictionary<string, object?> { ["schemaVersion"] = 1, ["inputSha256"] = Hash(inputBytes),
    ["sourceBefore"] = Descriptor(originalPath), ["cases"] = new List<object>(), ["failures"] = new List<object>(),
    ["scope"] = "Actual original MediaEncoder probing, complete audio StreamBuilder admission and real progressive/HLS command-builder packet copy. Input HTTP and no-encoding support are controlled. Production Native controllers are not hosted." };
var failures = (List<object>)report["failures"]!; var results = (List<object>)report["cases"]!;
var suffix = OperatingSystem.IsWindows() ? ".exe" : string.Empty;
var apphost = Path.Combine(AppContext.BaseDirectory, "Oracle" + suffix); var wrapper = Path.Combine(AppContext.BaseDirectory, "ffmpeg" + suffix);
foreach (var filename in new[] { wrapper, Path.Combine(AppContext.BaseDirectory, "ffprobe" + suffix) }) {
    File.Copy(apphost, filename, true); if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(filename, File.GetUnixFileMode(apphost));
}
var controlFile = Path.Combine(root, "control.json"); var traces = Path.Combine(root, "traces"); Directory.CreateDirectory(traces);
File.WriteAllText(controlFile, JsonSerializer.Serialize(new { ffmpeg = args[2], ffprobe = args[3], traceDirectory = traces, outputRoot = root }));
var previousControl = Environment.GetEnvironmentVariable("MEDIAMANAGER_FLAC_COPY_CONTROL"); Environment.SetEnvironmentVariable("MEDIAMANAGER_FLAC_COPY_CONTROL", controlFile);
var requests = new ConcurrentQueue<object>();
var builder = WebApplication.CreateBuilder(); builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
var app = builder.Build();
app.MapMethods("/original.flac", ["GET", "HEAD"], async (HttpContext context) => {
    long first = 0, last = originalBytes.Length - 1;
    if (context.Request.Headers.Range.ToString() is var range && range.StartsWith("bytes=", StringComparison.Ordinal)) {
        var pieces = range[6..].Split('-'); first = long.Parse(pieces[0]);
        if (pieces[1].Length > 0) last = Math.Min(last, long.Parse(pieces[1]));
        if (first > last) { context.Response.StatusCode = 416; return; }
        context.Response.StatusCode = 206; context.Response.Headers.ContentRange = $"bytes {first}-{last}/{originalBytes.Length}";
    }
    requests.Enqueue(new { context.Request.Method, range = context.Request.Headers.Range.ToString(), first, last });
    context.Response.ContentType = "audio/flac"; context.Response.Headers.AcceptRanges = "bytes"; context.Response.ContentLength = last - first + 1;
    if (context.Request.Method != "HEAD") await context.Response.Body.WriteAsync(originalBytes.AsMemory((int)first, (int)(last - first + 1)), context.RequestAborted);
});
MediaEncoder? encoder = null;
try {
    await app.StartAsync(); var origin = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
    var paths = new ServerApplicationPaths(root, Path.Combine(root, "log"), Path.Combine(root, "config"), Path.Combine(root, "cache"), Path.Combine(root, "web"));
    Directory.CreateDirectory(paths.ConfigurationDirectoryPath);
    var serializer = new MyXmlSerializer(); serializer.SerializeToFile(new ServerConfiguration(), Path.Combine(paths.ConfigurationDirectoryPath, "system.xml"));
    serializer.SerializeToFile(new EncodingOptions { EncoderAppPath = wrapper, EncodingThreadCount = 2 }, Path.Combine(paths.ConfigurationDirectoryPath, "encoding.xml"));
    var manager = new ServerConfigurationManager(paths, NullLoggerFactory.Instance, serializer); manager.RegisterConfiguration<EncodingConfigurationFactory>();
    var configuration = new ConfigurationBuilder().AddInMemoryCollection(new StartupOptions { FFmpegPath = wrapper }.ConvertToConfig()).Build();
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var localization = new LocalizationManager(manager, NullLogger<LocalizationManager>.Instance);
    encoder = new MediaEncoder(NullLogger<MediaEncoder>.Instance, manager, fileSystem,
        Stub.Make<IBlurayExaminer>((method, _) => throw new InvalidOperationException("Unexpected disc operation: " + method.Name)), localization, configuration, manager);
    report["startupAccepted"] = encoder.SetFFmpegPath(); report["version"] = encoder.EncoderVersion?.ToString();
    var source = await encoder.GetMediaInfo(new MediaInfoRequest { MediaType = DlnaProfileType.Audio, ExtractChapters = false,
        MediaSource = new MediaSourceInfo { Id = Guid.Parse(input.GetProperty("itemId").GetString()!).ToString("N"), Path = origin + "/original.flac", Protocol = MediaProtocol.Http } }, CancellationToken.None);
    source.Id = Guid.Parse(input.GetProperty("itemId").GetString()!).ToString("N"); source.Path = origin + "/original.flac"; source.Protocol = MediaProtocol.Http;
    source.SupportsDirectPlay = true; source.SupportsDirectStream = true; source.SupportsTranscoding = false;
    report["mediaInfo"] = source; report["originalProbe"] = await Probe(args[3], originalPath, Path.Combine(root, "original.ffprobe.json"));
    var audio = source.MediaStreams.Single(stream => stream.Type == MediaStreamType.Audio);
    if (audio.Codec != "flac" || audio.Channels != 1 || source.MediaStreams.Any(stream => stream.Type == MediaStreamType.Video)) throw new InvalidOperationException("The source must remain the original mono FLAC input.");
    var sourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name switch {
        "GetPathProtocol" => MediaProtocol.Http, "GetPlaybackMediaSources" => Task.FromResult<IReadOnlyList<MediaSourceInfo>>([source]),
        _ => throw new InvalidOperationException("Unexpected source operation: " + method.Name)
    });
    var helper = new EncodingHelper(paths, encoder, null!, configuration, manager, new PathManager(NullLogger<PathManager>.Instance, manager, paths));
    var controller = new DynamicHlsController(null!, null!, sourceManager, manager, encoder, fileSystem, null!, NullLogger<DynamicHlsController>.Instance, null!, helper, null!);
    var manifests = new DynamicHlsHelper(null!, null!, sourceManager, manager, encoder, null!, null!, NullLogger<DynamicHlsHelper>.Instance, null!, helper, null!);
    foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
        var name = sample.GetProperty("name").GetString()!; var protocol = sample.GetProperty("protocol").GetString()!;
        var container = sample.GetProperty("container").GetString()!; source.SupportsDirectStream = sample.GetProperty("directStream").GetBoolean();
        source.TranscodingSubProtocol = protocol == "hls" ? MediaStreamProtocol.hls : MediaStreamProtocol.http; source.TranscodingContainer = container;
        var directContainers = sample.TryGetProperty("directPlayContainers", out var containers) ? containers.EnumerateArray().Select(value => value.GetString()!).ToArray() : new[] { container };
        var profile = new DeviceProfile { Name = "Original FLAC copy device", MaxStreamingBitrate = sample.GetProperty("maxBitrate").GetInt32(),
            DirectPlayProfiles = directContainers.Select(value => new DirectPlayProfile { Type = DlnaProfileType.Audio, Container = value, AudioCodec = sample.GetProperty("codec").GetString() }).ToArray(),
            TranscodingProfiles = [] };
        var selected = new StreamBuilder(new NoEncodingSupport(), NullLogger.Instance).GetOptimalAudioStream(new MediaOptions {
            ItemId = Guid.Parse(input.GetProperty("itemId").GetString()!), MediaSources = [source], Profile = profile,
            AllowAudioStreamCopy = true, DeviceId = "flac-copy-device" });
        var accepted = selected?.PlayMethod == MediaBrowser.Model.Session.PlayMethod.DirectStream && selected.Container == "mp4";
        var row = new Dictionary<string, object?> { ["name"] = name, ["accepted"] = accepted,
            ["selection"] = selected is null ? null : new { method = selected.PlayMethod.ToString(), selected.Container, protocol = selected.SubProtocol.ToString(),
                selected.TranscodeReasons, audioCodecs = selected.TargetAudioCodec, url = accepted ? selected.ToUrl(null, "fixture-token", null) : null }, ["profile"] = profile };
        results.Add(row);
        if (!sample.TryGetProperty("execute", out var execute) || !execute.GetBoolean() || !accepted) continue;
        var target = Path.Combine(root, name); Directory.CreateDirectory(target);
        using var state = new StreamState(sourceManager, protocol == "hls" ? TranscodingJobType.Hls : TranscodingJobType.Progressive, null!) {
            Request = new StreamingRequestDto { Id = Guid.Parse(input.GetProperty("itemId").GetString()!), Container = "mp4", AudioCodec = "copy",
                SegmentContainer = "mp4", SegmentLength = input.GetProperty("segmentLength").GetInt32(), CpuCoreLimit = 1, AllowAudioStreamCopy = true, EnableAutoStreamCopy = true },
            MediaSource = source, MediaPath = source.Path, InputProtocol = MediaProtocol.Http, OutputAudioCodec = "copy", OutputContainer = "mp4",
            AudioStream = audio, IsInputVideo = false, RunTimeTicks = source.RunTimeTicks };
        var destination = Path.Combine(target, protocol == "hls" ? "main.m3u8" : "copy.mp4");
        var arguments = protocol == "hls"
            ? (string)typeof(DynamicHlsController).GetMethod("GetCommandLineArguments", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(controller, [destination, state, false, 0])!
            : helper.GetProgressiveAudioFullCommandLine(state, manager.GetEncodingOptions(), destination);
        row["arguments"] = arguments; row["mime"] = state.GetMimeType(".mp4", false);
        row["manifestAudioCodec"] = (string)typeof(DynamicHlsHelper).GetMethod("GetPlaylistAudioCodecs", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(manifests, [state])!;
        row["process"] = await Copy(wrapper, arguments);
        if (protocol == "hls") {
            var playlist = File.ReadAllText(destination); row["playlist"] = playlist;
            var initialization = playlist.Split('\n').First(line => line.StartsWith("#EXT-X-MAP:", StringComparison.Ordinal)).Split('"')[1];
            var parts = new[] { initialization }.Concat(playlist.Split('\n').Select(line => line.Trim()).Where(line => line.Length > 0 && !line.StartsWith('#'))).Select(value => Path.Combine(target, value)).ToArray();
            destination = Path.Combine(target, "complete.mp4"); await using (var stream = File.Create(destination)) foreach (var part in parts) await stream.WriteAsync(File.ReadAllBytes(part));
            row["composition"] = parts.Select(Descriptor).ToArray();
        }
        row["payload"] = Descriptor(destination); row["probe"] = await Probe(args[3], destination, Path.Combine(target, "ffprobe.json"));
        row["files"] = Directory.GetFiles(target).Select(Descriptor).ToArray();
    }
    report["actualMediaEncoder"] = true; report["actualAudioStreamBuilder"] = true; report["actualCommandBuilders"] = true;
    report["ffmpeg"] = Descriptor(args[2]); report["ffprobe"] = Descriptor(args[3]); report["launcher"] = Descriptor(wrapper);
    report["assemblies"] = new[] { typeof(MediaEncoder).Assembly, typeof(StreamBuilder).Assembly, typeof(DynamicHlsController).Assembly,
        typeof(ServerConfigurationManager).Assembly, typeof(EncodingHelper).Assembly }.Distinct().Select(assembly => new {
            name = assembly.GetName().Name, filename = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray();
} catch (Exception error) { failures.Add(Failure(error)); }
finally {
    try { encoder?.Dispose(); report["encoderDisposed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    try { await app.StopAsync(); await app.DisposeAsync(); report["inputHostClosed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    Environment.SetEnvironmentVariable("MEDIAMANAGER_FLAC_COPY_CONTROL", previousControl);
    report["inputRequests"] = requests.ToArray(); report["sourceAfter"] = Descriptor(originalPath);
    report["traces"] = Directory.GetFiles(traces, "*.json").Order().Select(filename => new { filename, value = JsonDocument.Parse(File.ReadAllBytes(filename)).RootElement.Clone() }).ToArray();
    File.WriteAllText(outputFile, JsonSerializer.Serialize(report, json) + "\n");
}
if (failures.Count != 0) Environment.ExitCode = 1;

static bool Within(string root, string path) { var relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(path)); return relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar) && !Path.IsPathRooted(relative); }
static async Task Forward(Stream source, Stream destination, string filename, Process process) {
    await using var saved = File.Create(filename); var buffer = new byte[16384];
    try {
        while (await source.ReadAsync(buffer) is var count && count > 0) {
            await saved.WriteAsync(buffer.AsMemory(0, count)); await destination.WriteAsync(buffer.AsMemory(0, count));
        }
        await destination.FlushAsync();
    } catch (Exception error) {
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        catch (Exception cleanup) { throw new AggregateException("Original process output and cleanup failed.", error, cleanup); }
        throw;
    }
}
static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
static object Descriptor(string filename) { var bytes = File.ReadAllBytes(filename); return new { filename, bytes = bytes.Length, sha256 = Hash(bytes) }; }
static object Failure(Exception error) => new { error.Message, error.StackTrace, cause = error.InnerException is null ? null : Failure(error.InnerException),
    errors = error is AggregateException group ? group.InnerExceptions.Select(Failure).ToArray() : null };
static async Task<object> Copy(string executable, string arguments) {
    var start = new ProcessStartInfo(executable, "-nostdin " + arguments) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
    using var process = Process.Start(start) ?? throw new IOException("The selected copy process did not start.");
    var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
    await process.WaitForExitAsync(); var result = new { pid = process.Id, process.ExitCode, stdout = await stdout, stderr = await stderr };
    if (process.ExitCode != 0) throw new IOException("Original packet copy failed: " + JsonSerializer.Serialize(result));
    return result;
}
static async Task<object> Probe(string executable, string filename, string output) {
    var arguments = new[] { "-v", "error", "-show_format", "-show_streams", "-show_packets", "-show_data_hash", "sha256", "-of", "json", filename };
    var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var argument in arguments) start.ArgumentList.Add(argument);
    using var process = Process.Start(start) ?? throw new IOException("The original-input packet reader did not start.");
    var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync(); await process.WaitForExitAsync();
    var text = await stdout; var error = await stderr; File.WriteAllText(output, text);
    if (process.ExitCode != 0) throw new IOException("Original packet inspection failed: " + error);
    return new { executable, arguments, pid = process.Id, process.ExitCode, stderr = error, output = Descriptor(output), raw = JsonDocument.Parse(text).RootElement.Clone() };
}
public class NoEncodingSupport : ITranscoderSupport {
    public bool CanEncodeToAudioCodec(string codec) => false;
    public bool CanEncodeToSubtitleCodec(string codec) => false;
    public bool CanExtractSubtitles(string codec) => false;
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
}
