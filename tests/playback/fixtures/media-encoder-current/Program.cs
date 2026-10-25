using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Security.Claims;
using System.Text.Encodings.Web;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Extensions.Json;
using Jellyfin.Server;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Streaming;
using MediaBrowser.MediaEncoding.Configuration;
using MediaBrowser.MediaEncoding.Encoder;
using MediaBrowser.MediaEncoding.Subtitles;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dlna;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

// This actual apphost is an explicitly controlled executable boundary. It never
// forwards capability probes, lavfi, hardware initialization or A/V encoding.
if (args.Length > 0 && args[0].StartsWith('-')) {
    var controlFile = Environment.GetEnvironmentVariable("MEDIAMANAGER_ENCODER_CONTROL")!;
    using var controlDocument = JsonDocument.Parse(File.ReadAllBytes(controlFile)); var control = controlDocument.RootElement;
    var traceDirectory = control.GetProperty("traceDirectory").GetString()!; Directory.CreateDirectory(traceDirectory);
    var probe = Path.GetFileNameWithoutExtension(Environment.ProcessPath!).Equals("ffprobe", StringComparison.Ordinal);
    var version = args.Length == 1 && args[0] == "-version";
    var inputIndex = Array.IndexOf(args, "-i");
    var originalInput = inputIndex >= 0 && inputIndex + 1 < args.Length && Uri.TryCreate(args[inputIndex + 1], UriKind.Absolute, out var inputUri)
        && inputUri.Scheme == "http" && inputUri.Host == "127.0.0.1";
    var codecIndices = args.Select((value, index) => (value, index)).Where(pair => pair.value is "-c" or "-c:v" or "-c:a" or "-c:s"
        || pair.value.StartsWith("-codec:", StringComparison.Ordinal)).Select(pair => pair.index).ToArray();
    var copy = codecIndices.Length > 0 && codecIndices.All(index => index + 1 < args.Length && args[index + 1] == "copy");
    var forbidden = args.Any(value => value is "lavfi" or "-init_hw_device" or "-hwaccel" || value.StartsWith("nullsrc", StringComparison.Ordinal));
    var forward = version || originalInput && !forbidden && (probe || copy);
    var recordFile = Path.Combine(traceDirectory, Guid.NewGuid().ToString("N") + ".json");
    if (!forward) {
        File.WriteAllText(recordFile, JsonSerializer.Serialize(new { wrapperPid = Environment.ProcessId, childPid = (int?)null,
            arguments = args, forwarded = false, boundary = "Removed capability/generation branch" }));
        Environment.ExitCode = 2; return;
    }
    var executable = control.GetProperty(probe ? "ffprobe" : "ffmpeg").GetString()!;
    if (version && control.TryGetProperty("versionText", out var text)) {
        File.WriteAllText(recordFile, JsonSerializer.Serialize(new { wrapperPid = Environment.ProcessId, childPid = (int?)null,
            arguments = args, forwarded = false, boundary = "Controlled executable version text", stdout = text.GetString() }));
        Console.Write(text.GetString()); Environment.ExitCode = control.TryGetProperty("exitCode", out var exit) ? exit.GetInt32() : 0; return;
    }
    var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var argument in args) start.ArgumentList.Add(argument);
    using var process = Process.Start(start) ?? throw new IOException("The original media process did not start."); process.StandardInput.Close();
    File.WriteAllText(recordFile, JsonSerializer.Serialize(new { wrapperPid = Environment.ProcessId, childPid = process.Id, executable, arguments = args, forwarded = true }));
    var stderr = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
    if (version) {
        var output = await process.StandardOutput.ReadToEndAsync(); await process.WaitForExitAsync(); await stderr;
        if (control.TryGetProperty("versionMode", out var mode) && mode.GetString() == "libraries-only")
            output = string.Join("\n", output.Split('\n').Where(line => line.TrimStart().StartsWith("lib", StringComparison.Ordinal))) + "\n";
        if (control.TryGetProperty("holdVersion", out var hold) && hold.GetBoolean()) {
            File.WriteAllText(Path.Combine(traceDirectory, "version-held.json"), JsonSerializer.Serialize(new { wrapperPid = Environment.ProcessId, childPid = process.Id }));
            await Task.Delay(Timeout.Infinite);
        }
        Console.Write(output); Environment.ExitCode = control.TryGetProperty("exitCode", out var exit) ? exit.GetInt32() : process.ExitCode;
    } else {
        var stdout = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        await process.WaitForExitAsync(); await Task.WhenAll(stdout, stderr); Environment.ExitCode = process.ExitCode;
    }
    return;
}

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US"); CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo("en-US");
var inputBytes = File.ReadAllBytes(args[0]); using var inputDocument = JsonDocument.Parse(inputBytes); var input = inputDocument.RootElement;
var outputFile = args[1]; var ffmpeg = args[2]; var ffprobe = args[3];
var outputRoot = Path.Combine(Path.GetDirectoryName(outputFile)!, "states"); Directory.CreateDirectory(outputRoot);
var json = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never, WriteIndented = true };
object Failure(Exception error) => new { type = error.GetType().FullName, error.Message, error.StackTrace, error.HResult,
    cause = error.InnerException is null ? null : Failure(error.InnerException),
    errors = error is AggregateException group ? group.InnerExceptions.Select(Failure).ToArray() : null };
JsonElement Value(object? value) => JsonSerializer.SerializeToElement(value, json);
var serializer = new MyXmlSerializer(); var suffix = OperatingSystem.IsWindows() ? ".exe" : string.Empty;
var launcher = Path.Combine(AppContext.BaseDirectory, "Oracle" + suffix);
void Executable(string filename) { File.Copy(launcher, filename, true); if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(filename, File.GetUnixFileMode(launcher)); }
Executable(Path.Combine(AppContext.BaseDirectory, "ffmpeg" + suffix)); Executable(Path.Combine(AppContext.BaseDirectory, "ffprobe" + suffix));
if (!OperatingSystem.IsWindows()) { Executable(Path.Combine(AppContext.BaseDirectory, "ffprobe.choice")); Executable(Path.Combine(AppContext.BaseDirectory, "ffprobe.other")); }
var controls = new Dictionary<string, PublicControl>(StringComparer.Ordinal);
var hostRoot = Path.Combine(outputRoot, "http"); Directory.CreateDirectory(hostRoot);
var hostPaths = new ServerApplicationPaths(hostRoot, Path.Combine(hostRoot, "log"), Path.Combine(hostRoot, "config"), Path.Combine(hostRoot, "cache"), Path.Combine(hostRoot, "web"));
Directory.CreateDirectory(hostPaths.ConfigurationDirectoryPath); serializer.SerializeToFile(new ServerConfiguration(), Path.Combine(hostPaths.ConfigurationDirectoryPath, "system.xml"));
var hostManager = new ServerConfigurationManager(hostPaths, NullLoggerFactory.Instance, serializer);
hostManager.RegisterConfiguration<EncodingConfigurationFactory>();
var httpDiagnostics = new List<object>(); var bindingActions = new List<object>();
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" }); builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton<IServerConfigurationManager>(hostManager);
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<ILogger<ExceptionMiddleware>>(services => new RequestCaptureLogger<ExceptionMiddleware>(httpDiagnostics, services.GetRequiredService<IHttpContextAccessor>()));
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(options => options.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").RequireAssertion(_ => true).Build());
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlyHlsController()));
builder.Services.Configure<MvcOptions>(value => value.Filters.Add(new CaptureBindingFilter(bindingActions)));
builder.Services.Replace(ServiceDescriptor.Transient<DynamicHlsController>(_ => new DynamicHlsController(null!, null!, null!, hostManager, null!, null!, null!,
    NullLogger<DynamicHlsController>.Instance, null!, null!, null!)));
var app = builder.Build(); app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers();
app.MapMethods("/media/{key}", ["GET", "HEAD"], async (HttpContext context, string key) => {
    var bytes = controls[key].Bytes; long first = 0, last = bytes.Length - 1;
    if (context.Request.Headers.Range.ToString() is var range && range.StartsWith("bytes=", StringComparison.Ordinal)) {
        var parts = range[6..].Split('-'); first = long.Parse(parts[0]); if (parts[1].Length > 0) last = Math.Min(last, long.Parse(parts[1]));
        if (first > last) { context.Response.StatusCode = 416; return; }
        context.Response.StatusCode = 206; context.Response.Headers.ContentRange = $"bytes {first}-{last}/{bytes.Length}";
    }
    context.Response.Headers.AcceptRanges = "bytes"; context.Response.ContentLength = last - first + 1;
    if (context.Request.Method != "HEAD") await context.Response.Body.WriteAsync(bytes.AsMemory((int)first, (int)(last - first + 1)), context.RequestAborted);
});
app.MapGet("/subtitle/{key}", async (HttpContext context, string key) => {
    await using var stream = await controls[key].Subtitle!(); context.Response.ContentType = "application/x-subrip"; await stream.CopyToAsync(context.Response.Body);
});
await app.StartAsync(); var origin = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
using var client = new HttpClient();
async Task<object> Wire(string url) { using var response = await client.GetAsync(url); var bytes = await response.Content.ReadAsByteArrayAsync();
    return new { status = (int)response.StatusCode, contentType = response.Content.Headers.ContentType?.ToString(),
        headers = response.Headers.Concat(response.Content.Headers).ToDictionary(pair => pair.Key, pair => pair.Value.ToArray()), bytes = Convert.ToBase64String(bytes), text = Encoding.UTF8.GetString(bytes) }; }
object Disk(string filename) { byte[]? bytes = null; object? value = null, error = null;
    try { if (File.Exists(filename)) { bytes = File.ReadAllBytes(filename); value = serializer.DeserializeFromFile(typeof(EncodingOptions), filename); } }
    catch (Exception failure) { error = Failure(failure); }
    return new { directory = Directory.Exists(filename), bytes = bytes is null ? null : Convert.ToBase64String(bytes), value, error }; }
var results = new List<object>(); var binding = new List<object>();
try {
    foreach (var query in input.GetProperty("binding").EnumerateArray()) binding.Add(new { query = query.GetString(), wire = await Wire(origin
        + "/Videos/f8400000000000000000000000000001/hls1/main/0.mp4?runtimeTicks=0&actualSegmentLengthTicks=60000000&" + query.GetString()) });
    foreach (var entry in input.GetProperty("cases").EnumerateArray().Select((sample, index) => (sample, index))) {
        var sample = entry.sample; var key = "native-" + entry.index; var root = Path.Combine(outputRoot, key); Directory.CreateDirectory(root);
        var directory = Path.Combine(root, "config"); Directory.CreateDirectory(directory);
        var paths = new ServerApplicationPaths(root, Path.Combine(root, "log"), directory, Path.Combine(root, "cache"), Path.Combine(root, "web"));
        serializer.SerializeToFile(new ServerConfiguration { IsStartupWizardCompleted = true }, Path.Combine(directory, "system.xml"));
        var a = Path.Combine(AppContext.BaseDirectory, key + " pick.choice" + suffix); var b = Path.Combine(AppContext.BaseDirectory, key + " pick.other" + suffix); Executable(a); Executable(b);
        string? Expand(string? path) => path switch { "@a" => a, "@b" => b, "@missing" => Path.Combine(root, "missing-executable" + suffix), _ => path };
        var initial = new EncodingOptions { EncoderAppPath = sample.TryGetProperty("configPath", out var configured) ? Expand(configured.GetString()) : null,
            EncoderAppPathDisplay = "Before startup", EncodingThreadCount = 2 };
        var filename = Path.Combine(directory, "encoding.xml"); serializer.SerializeToFile(initial, filename);
        var manager = new ServerConfigurationManager(paths, NullLoggerFactory.Instance, serializer); manager.RegisterConfiguration<EncodingConfigurationFactory>();
        var retained = manager.GetEncodingOptions(); var traceDirectory = Path.Combine(root, "trace"); Directory.CreateDirectory(traceDirectory);
        var controlFile = Path.Combine(root, "control.json");
        var control = new Dictionary<string, object?> { ["ffmpeg"] = ffmpeg, ["ffprobe"] = ffprobe, ["traceDirectory"] = traceDirectory };
        if (sample.TryGetProperty("versionText", out var versionText)) control["versionText"] = versionText.GetString();
        if (sample.TryGetProperty("exitCode", out var exitCode)) control["exitCode"] = exitCode.GetInt32();
        void SaveControl() => File.WriteAllText(controlFile, JsonSerializer.Serialize(control)); SaveControl();
        var environmentNames = new[] { "JELLYFIN_FFMPEG", "JELLYFIN_FFmpeg__novalidation", "MEDIAMANAGER_ENCODER_CONTROL", "PATH" };
        var previous = environmentNames.ToDictionary(name => name, Environment.GetEnvironmentVariable);
        Environment.SetEnvironmentVariable("JELLYFIN_FFMPEG", sample.TryGetProperty("environmentPath", out var environmentPath) ? Expand(environmentPath.GetString()) : null);
        Environment.SetEnvironmentVariable("JELLYFIN_FFmpeg__novalidation", sample.TryGetProperty("skip", out var skipped) && skipped.GetBoolean() ? "true" : "false");
        Environment.SetEnvironmentVariable("MEDIAMANAGER_ENCODER_CONTROL", controlFile);
        Environment.SetEnvironmentVariable("PATH", AppContext.BaseDirectory + Path.PathSeparator + previous["PATH"]);
        var startupOptions = new StartupOptions { FFmpegPath = sample.TryGetProperty("cli", out var cli) ? Expand(cli.GetString()) : null };
        var configuration = new ConfigurationBuilder().AddEnvironmentVariables("JELLYFIN_").AddInMemoryCollection(startupOptions.ConvertToConfig()).Build();
        var events = new List<JsonElement>(); var log = new List<object>(); var nested = false;
        JsonElement Snapshot() => Value(new { current = manager.GetEncodingOptions(), retained, disk = Disk(filename) });
        manager.NamedConfigurationUpdating += (_, change) => {
            events.Add(Value(new { phase = "updating", value = change.NewConfiguration, state = Snapshot() }));
            if (sample.TryGetProperty("observer", out var observer) && observer.GetString() == "updating") throw new IOException("Controlled updating failure.");
        };
        manager.NamedConfigurationUpdated += (_, change) => {
            events.Add(Value(new { phase = "updated", value = change.NewConfiguration, state = Snapshot() }));
            if (sample.TryGetProperty("observer", out var observer)) {
                if (observer.GetString() == "updated") throw new IOException("Controlled updated failure.");
                if (observer.GetString() == "late-alias" && !nested) {
                    nested = true; retained.EncoderAppPathDisplay = "Late retained display"; retained.EncodingThreadCount = 1;
                    manager.SaveConfiguration("encoding", new EncodingOptions { EncoderAppPath = retained.EncoderAppPath, EncodingThreadCount = 3 });
                }
            }
            if (sample.TryGetProperty("afterSave", out var afterSave)) {
                if (afterSave.GetString() == "remove") File.Move(a, a + ".removed");
                else { control["versionMode"] = afterSave.GetString(); SaveControl(); }
            }
        };
        var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
        var localization = new LocalizationManager(manager, NullLogger<LocalizationManager>.Instance);
        var encoder = new MediaEncoder(new CaptureLogger<MediaEncoder>(log), manager, fileSystem,
            Stub.Make<IBlurayExaminer>((method, _) => throw new InvalidOperationException("Unexpected disc operation: " + method.Name)), localization, configuration, manager);
        var before = Snapshot(); bool? accepted = null; object? initializationError = null; var probes = new List<object>(); var hls = new List<object>();
        var sourceBytes = Convert.FromBase64String(input.GetProperty("source").GetProperty("media").GetString()!);
        var sourceFile = Path.Combine(root, "original.mkv"); File.WriteAllBytes(sourceFile, sourceBytes); controls[key] = new PublicControl(sourceBytes);
        var source = input.GetProperty("source").GetProperty("source").Deserialize<MediaSourceInfo>(JsonDefaults.Options)!;
        source.Id = Guid.Parse("F8400000-0000-0000-0000-" + (entry.index + 1).ToString("D12")).ToString("N"); source.Path = origin + "/media/" + key; source.Protocol = MediaProtocol.Http;
        try {
            if (sample.TryGetProperty("saveDirectory", out var saveDirectory) && saveDirectory.GetBoolean()) { File.Move(filename, filename + ".original"); Directory.CreateDirectory(filename); }
            try { accepted = encoder.SetFFmpegPath(); } catch (Exception error) { initializationError = Failure(error); }
            var afterInitialize = Snapshot();
            foreach (var phase in new[] { "before-late-write", "after-late-write" }) {
                if (phase == "after-late-write") { retained.EncodingThreadCount = 7; retained.EncoderAppPathDisplay = "After startup retained display"; }
                object? information = null, error = null;
                try { information = await encoder.GetMediaInfo(new MediaInfoRequest { MediaSource = source, MediaType = DlnaProfileType.Video, ExtractChapters = false }, CancellationToken.None); }
                catch (Exception failure) { error = Failure(failure); }
                probes.Add(new { phase, information, error });
            }
            var sources = Stub.Make<IMediaSourceManager>((method, _) => method.Name switch {
                "GetPlaybackMediaSources" => Task.FromResult<IReadOnlyList<MediaSourceInfo>>([source]), "GetPathProtocol" => MediaProtocol.Http,
                _ => throw new InvalidOperationException("Unexpected source operation: " + method.Name)
            });
            using var subtitles = new SubtitleEncoder(new CaptureLogger<SubtitleEncoder>(log), fileSystem, encoder,
                Stub.Make<IHttpClientFactory>((_, _) => new HttpClient()), sources, new SubtitleEditParser(NullLogger<SubtitleEditParser>.Instance),
                new PathManager(NullLogger<PathManager>.Instance, manager, paths), manager);
            object? subtitleError = null; var subtitle = source.MediaStreams.First(stream => stream.Type == MediaStreamType.Subtitle);
            controls[key].Subtitle = async () => {
                try { return await ((ISubtitleEncoder)subtitles).GetSubtitles(new Movie { Id = Guid.Parse(source.Id), Path = sourceFile }, source.Id, subtitle.Index, "srt", 0, 0, true, CancellationToken.None); }
                catch (Exception error) { subtitleError = Failure(error); throw; }
            };
            var wire = await Wire(origin + "/subtitle/" + key);
            if (sample.TryGetProperty("executeHls", out var executeHls) && executeHls.GetBoolean()) {
                var hlsSource = input.GetProperty("hls").GetProperty("source").Deserialize<MediaSourceInfo>(JsonDefaults.Options)!;
                var mediaKey = key + "-hls"; controls[mediaKey] = new PublicControl(Convert.FromBase64String(input.GetProperty("hls").GetProperty("media").GetString()!));
                hlsSource.Path = origin + "/media/" + mediaKey; hlsSource.Protocol = MediaProtocol.Http;
                foreach (var limit in input.GetProperty("cpuLimits").EnumerateArray().Select((value, index) => (value, index))) {
                    var selected = limit.value.ValueKind == JsonValueKind.Null ? (int?)null : limit.value.GetInt32();
                    var helper = new EncodingHelper(paths, encoder, subtitles, configuration, manager, new PathManager(NullLogger<PathManager>.Instance, manager, paths));
                    var controller = new DynamicHlsController(null!, null!, sources, manager, encoder, fileSystem, null!, NullLogger<DynamicHlsController>.Instance, null!, helper, null!);
                    using var state = new StreamState(sources, TranscodingJobType.Hls, null!) { Request = new VideoRequestDto { Container = "mp4", VideoCodec = "copy", AudioCodec = "copy", SegmentContainer = "mp4", SegmentLength = 6,
                            CpuCoreLimit = selected, AllowVideoStreamCopy = true, AllowAudioStreamCopy = true, EnableAutoStreamCopy = true },
                        MediaSource = hlsSource, MediaPath = hlsSource.Path, InputProtocol = MediaProtocol.Http, OutputVideoCodec = "copy", OutputAudioCodec = "copy", OutputContainer = "mp4",
                        VideoStream = hlsSource.MediaStreams.First(stream => stream.Type == MediaStreamType.Video), AudioStream = hlsSource.MediaStreams.First(stream => stream.Type == MediaStreamType.Audio),
                        IsInputVideo = true, RunTimeTicks = hlsSource.RunTimeTicks };
                    var target = Path.Combine(root, "hls-" + limit.index); Directory.CreateDirectory(target); var playlist = Path.Combine(target, "main.m3u8");
                    string? arguments = null; string? flacArguments = null; object? commandError = null; object? invocationError = null; object? processResult = null;
                    try {
                        arguments = (string)typeof(DynamicHlsController).GetMethod("GetCommandLineArguments", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(controller, [playlist, state, false, 0])!;
                        var originalCodec = state.AudioStream.Codec;
                        try {
                            state.AudioStream.Codec = "flac";
                            flacArguments = (string)typeof(DynamicHlsController).GetMethod("GetAudioArguments", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(controller, [state])!;
                        } finally { state.AudioStream.Codec = originalCodec; }
                        var start = new ProcessStartInfo(encoder.EncoderPath, "-nostdin " + arguments) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                        using var process = Process.Start(start)!; var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
                        await process.WaitForExitAsync(); processResult = new { process.ExitCode, stdout = await stdout, stderr = await stderr, pid = process.Id };
                    } catch (Exception error) { invocationError = Failure(error); commandError = Failure(error is TargetInvocationException wrapper && wrapper.InnerException is not null ? wrapper.InnerException : error); }
                    hls.Add(new { cpuCoreLimit = selected, processorCount = Environment.ProcessorCount, configuredThreads = manager.GetEncodingOptions().EncodingThreadCount,
                        helperThreads = EncodingHelper.GetNumberOfThreads(state, manager.GetEncodingOptions(), "copy"), arguments, flacArguments,
                        flacScope = "Actual GetAudioArguments with controlled metadata only; no FLAC original execution claim", commandError, invocationError, processResult,
                        files = Directory.EnumerateFiles(target).Order(StringComparer.Ordinal).Select(file => new { name = Path.GetFileName(file), bytes = Convert.ToBase64String(File.ReadAllBytes(file)) }).ToArray() });
                }
            }
            var coldPaths = new ServerApplicationPaths(root, Path.Combine(root, "cold-log"), directory, Path.Combine(root, "cold-cache"), Path.Combine(root, "web"));
            var cold = new ServerConfigurationManager(coldPaths, NullLoggerFactory.Instance, serializer); cold.RegisterConfiguration<EncodingConfigurationFactory>();
            results.Add(new { name = sample.GetProperty("name").GetString(), root, a, b, before, accepted, initializationError, afterInitialize,
                requestAdmission = accepted == true ? "Initialized component" : "Controlled component observations after failed startup; not a running-server HTTP claim",
                afterLateWrite = Snapshot(), encoderPath = encoder.EncoderPath, probePath = encoder.ProbePath, version = encoder.EncoderVersion?.ToString(),
                events, probes, subtitle = new { wire, error = subtitleError }, hls, cold = cold.GetEncodingOptions(), diagnostics = log.ToArray(),
                traces = Directory.EnumerateFiles(traceDirectory, "*.json").Order(StringComparer.Ordinal).Select(file => JsonDocument.Parse(File.ReadAllText(file)).RootElement.Clone()).ToArray(),
                sourceBefore = Convert.ToBase64String(sourceBytes), sourceAfter = Convert.ToBase64String(File.ReadAllBytes(sourceFile)) });
        } finally { try { encoder.Dispose(); } finally { foreach (var previousValue in previous) Environment.SetEnvironmentVariable(previousValue.Key, previousValue.Value); } }
    }
} finally { try { await app.StopAsync(); } finally { await app.DisposeAsync(); } }
var assemblies = new[] { typeof(MediaEncoder).Assembly, typeof(EncoderValidator).Assembly, typeof(EncodingHelper).Assembly, typeof(DynamicHlsController).Assembly,
    typeof(ServerConfigurationManager).Assembly, typeof(JsonDefaults).Assembly, typeof(StartupOptions).Assembly }.Distinct().Select(assembly => new {
        name = assembly.GetName().Name, filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(outputFile, JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), processorCount = Environment.ProcessorCount,
    actualSetFFmpegPath = true, actualValidator = true, actualManager = true, actualSerializer = true, actualGetMediaInfo = true, actualSubtitlePublicMethod = true,
    actualHlsCommandBuilder = true, actualStreamingQueryBinding = true, bindingActionShortCircuited = true,
    capabilityProcessesBlocked = true, productionControllersExecuted = false, hostStopped = true, hostDisposed = true,
    toolDirectory = AppContext.BaseDirectory, launcher = new { filename = launcher, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(launcher))) },
    ffmpeg = new { filename = ffmpeg, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(ffmpeg))) },
    ffprobe = new { filename = ffprobe, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(ffprobe))) }, assemblies, binding, bindingActions, httpDiagnostics, results }, json));

public sealed class PublicControl(byte[] bytes) { public byte[] Bytes = bytes; public Func<Task<Stream>>? Subtitle; }
public sealed class CaptureBindingFilter(List<object> observations) : IActionFilter {
    public void OnActionExecuting(ActionExecutingContext context) {
        context.ActionArguments.TryGetValue("cpuCoreLimit", out var cpuCoreLimit);
        var request = context.HttpContext.Request;
        observations.Add(new { method = request.Method, path = request.Path.Value, query = request.QueryString.Value,
            traceIdentifier = context.HttpContext.TraceIdentifier, cpuCoreLimit });
        context.Result = new JsonResult(new { CpuCoreLimit = cpuCoreLimit });
    }
    public void OnActionExecuted(ActionExecutedContext context) { }
}
public class OnlyHlsController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var controller in feature.Controllers.Where(value => value.AsType() != typeof(DynamicHlsController)).ToArray()) feature.Controllers.Remove(controller);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() => Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(
        new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "Administrator")], Scheme.Name)), Scheme.Name)));
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? arguments) => Handler(method!, arguments);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
}
public sealed class CaptureLogger<T>(List<object> log) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) => log.Add(new {
        level = level.ToString(), message = formatter(state, error), error = error is null ? null : Capture(error) });
    private static object Capture(Exception error) => new { type = error.GetType().FullName, error.Message, error.StackTrace, error.HResult, error.Source,
        cause = error.InnerException is null ? null : Capture(error.InnerException), errors = error is AggregateException group ? group.InnerExceptions.Select(Capture).ToArray() : null };
}

public sealed class RequestCaptureLogger<T>(List<object> diagnostics, IHttpContextAccessor contexts) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
        var context = contexts.HttpContext;
        var value = new { phase = "http-exception-middleware", category = typeof(T).FullName, level = level.ToString(),
            message = formatter(state, error), error = error is null ? null : Capture(error),
            request = context is null ? null : new { method = context.Request.Method, path = context.Request.Path.Value,
                query = context.Request.QueryString.Value, traceIdentifier = context.TraceIdentifier } };
        lock (diagnostics) diagnostics.Add(value);
    }
    private static object Capture(Exception error) => new { type = error.GetType().FullName, error.Message, error.StackTrace, error.HResult, error.Source,
        cause = error.InnerException is null ? null : Capture(error.InnerException),
        errors = error is AggregateException group ? group.InnerExceptions.Select(Capture).ToArray() : null };
}
