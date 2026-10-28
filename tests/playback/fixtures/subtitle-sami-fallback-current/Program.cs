using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net.Http.Json;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Middleware;
using Jellyfin.Data.Enums;
using Jellyfin.Server;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.MediaEncoding.Configuration;
using MediaBrowser.MediaEncoding.Encoder;
using MediaBrowser.MediaEncoding.Subtitles;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

// The existing copy recorder's apphost isolation is retained. This recorder
// admits only version/probe and the exact declared SAMI -> SRT text operation.
// Encoder enumeration, audio/video codecs, filters, OCR and arbitrary outputs
// never reach the supplied media tools.
if (args.Length > 0 && args[0].StartsWith('-')) {
    await RunMediaTool(args);
    return;
}

CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
var inputBytes = await File.ReadAllBytesAsync(args[0]);
using var inputDocument = JsonDocument.Parse(inputBytes);
var input = inputDocument.RootElement;
var outputFile = Path.GetFullPath(args[1]);
var root = Path.Combine(Path.GetDirectoryName(outputFile)!, "state");
var inputs = Path.Combine(root, "inputs"); Directory.CreateDirectory(inputs);
var traceDirectory = Path.Combine(root, "traces"); Directory.CreateDirectory(traceDirectory);
var json = new JsonSerializerOptions { WriteIndented = true };
var failures = new List<object>(); var results = new List<object>();
var sourceRequests = new ConcurrentQueue<Dictionary<string, object?>>();
var spawnNotifications = new ConcurrentQueue<JsonElement>();
var completedRequests = new ConcurrentQueue<string>();
var emergencyCleanup = new List<object>();
var report = new Dictionary<string, object?> {
    ["schemaVersion"] = 1, ["pid"] = Environment.ProcessId, ["inputSha256"] = Hash(inputBytes),
    ["scope"] = "Actual designated ISubtitleEncoder, ManagedFileSystem, PathManager, ServerConfigurationManager, MediaEncoder, FFmpeg SAMI-to-SRT and ExceptionMiddleware. Media-source descriptors and isolated HTTP input/control are fixture-owned. Production Native controllers are not hosted.",
    ["cases"] = results, ["failures"] = failures, ["root"] = root, ["emergencyCleanup"] = emergencyCleanup,
};
var previousControl = Environment.GetEnvironmentVariable("MEDIAMANAGER_SAMI_FALLBACK_CONTROL");
var suffix = OperatingSystem.IsWindows() ? ".exe" : string.Empty;
var apphost = Path.Combine(AppContext.BaseDirectory, "Oracle" + suffix);
var wrapper = Path.Combine(AppContext.BaseDirectory, "ffmpeg" + suffix);
var probeWrapper = Path.Combine(AppContext.BaseDirectory, "ffprobe" + suffix);
foreach (var filename in new[] { wrapper, probeWrapper }) {
    File.Copy(apphost, filename, true);
    if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(filename, File.GetUnixFileMode(apphost));
}
var paths = new ServerApplicationPaths(root, Path.Combine(root, "log"), Path.Combine(root, "config"), Path.Combine(root, "cache"), Path.Combine(root, "web"));
Directory.CreateDirectory(paths.ConfigurationDirectoryPath);
var serializer = new MyXmlSerializer();
serializer.SerializeToFile(new ServerConfiguration(), Path.Combine(paths.ConfigurationDirectoryPath, "system.xml"));
serializer.SerializeToFile(new EncodingOptions { EncoderAppPath = wrapper, EncodingThreadCount = 2 }, Path.Combine(paths.ConfigurationDirectoryPath, "encoding.xml"));
var configurationManager = new ServerConfigurationManager(paths, NullLoggerFactory.Instance, serializer);
configurationManager.RegisterConfiguration<EncodingConfigurationFactory>();
var configuration = new ConfigurationBuilder().AddInMemoryCollection(new StartupOptions { FFmpegPath = wrapper }.ConvertToConfig()).Build();
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
var pathManager = new PathManager(NullLogger<PathManager>.Instance, configurationManager, paths);
var localization = new LocalizationManager(configurationManager, NullLogger<LocalizationManager>.Instance);
var mediaEncoder = new MediaEncoder(NullLogger<MediaEncoder>.Instance, configurationManager, fileSystem,
    Boundary.Unused<IBlurayExaminer>(), localization, configuration, configurationManager);
// Only descriptor selection is controlled. Protocol classification is the real
// designated manager with its real filesystem; unrelated repositories fail if used.
var protocolManager = new MediaSourceManager(Boundary.Unused<IServerApplicationHost>(), Boundary.Unused<IItemRepository>(), paths,
    localization, Boundary.Unused<IUserManager>(), Boundary.Unused<ILibraryManager>(), NullLogger<MediaSourceManager>.Instance,
    fileSystem, Boundary.Unused<IUserDataManager>(), mediaEncoder, Boundary.Unused<IDirectoryService>(),
    Boundary.Unused<IMediaStreamRepository>(), Boundary.Unused<IMediaAttachmentRepository>());
MediaSourceInfo? selectedSource = null;
var sourceManager = Boundary.Make<IMediaSourceManager>((method, values) => method.Name switch {
    "GetPathProtocol" => protocolManager.GetPathProtocol((string)values![0]!),
    "GetPlaybackMediaSources" => Task.FromResult<IReadOnlyList<MediaSourceInfo>>([selectedSource ?? throw new InvalidOperationException("No declared source selected.")]),
    _ => throw Boundary.Unexpected("IMediaSourceManager." + method.Name),
});
var parser = new SubtitleEditParser(NullLogger<SubtitleEditParser>.Instance);
using var clients = new FixtureClients();
SubtitleEncoder? subtitleEncoder = null;
SubtitleEncoder NewEncoder() => new(NullLogger<SubtitleEncoder>.Instance, fileSystem, mediaEncoder, clients, sourceManager, parser, pathManager, configurationManager);
var sources = input.GetProperty("sources").EnumerateArray().ToDictionary(value => value.GetProperty("name").GetString()!, value => value.Clone());
var cases = new Dictionary<string, Sample>(StringComparer.Ordinal);
const string origin = "http://127.0.0.1:5244";
foreach (var definition in input.GetProperty("cases").EnumerateArray()) {
    var name = definition.GetProperty("name").GetString()!;
    var source = sources[definition.GetProperty("source").GetString()!];
    var sourcePath = Path.Combine(inputs, name + definition.GetProperty("extension").GetString());
    var bytes = Convert.FromBase64String(source.GetProperty("base64").GetString()!);
    await File.WriteAllBytesAsync(sourcePath, bytes);
    File.SetLastWriteTimeUtc(sourcePath, DateTime.Parse(input.GetProperty("modifiedUtc").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal));
    var sample = new Sample {
        Name = name, Definition = definition.Clone(), Source = source, SourcePath = sourcePath,
        Protocol = Enum.Parse<MediaProtocol>(definition.GetProperty("protocol").GetString()!),
        MediaSourceId = definition.GetProperty("mediaSourceId").GetString()!, Index = definition.GetProperty("streamIndex").GetInt32(),
        CachePath = pathManager.GetSubtitlePath(definition.GetProperty("mediaSourceId").GetString()!, definition.GetProperty("streamIndex").GetInt32(), ".srt")
            ?? throw new InvalidOperationException("The declared source has no Native cache path."),
    };
    sample.Url = sample.Protocol == MediaProtocol.File ? LocalMediaProxy.GetProxyUrl(sourcePath)
        : origin + "/http/" + name + definition.GetProperty("extension").GetString();
    cases.Add(name, sample);
}
var bySourceTarget = cases.Values.ToDictionary(sample => Uri.UnescapeDataString(new Uri(sample.Url).PathAndQuery), StringComparer.Ordinal);
var controlFile = Path.Combine(root, "tool-control.json");
await File.WriteAllTextAsync(controlFile, JsonSerializer.Serialize(new {
    ffmpeg = args[2], ffprobe = args[3], traceDirectory, sourceUrls = cases.Values.Select(sample => sample.Url),
    outputPaths = cases.Values.Select(sample => sample.CachePath), notifyUrl = origin + "/control/spawn",
}));
Environment.SetEnvironmentVariable("MEDIAMANAGER_SAMI_FALLBACK_CONTROL", controlFile);
ActiveRequest? active = null;
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = Environments.Production });
builder.Logging.ClearProviders(); builder.WebHost.UseUrls(origin);
var app = builder.Build();
app.Run(async context => {
    var rawTarget = context.Features.Get<IHttpRequestFeature>()!.RawTarget!;
    if (context.Request.Path == "/control/spawn" && context.Request.Method == "POST") {
        using var receipt = await JsonDocument.ParseAsync(context.Request.Body, cancellationToken: context.RequestAborted);
        var value = receipt.RootElement.Clone(); spawnNotifications.Enqueue(value);
        if (active is not null && value.GetProperty("arguments").EnumerateArray().Any(argument => argument.GetString() == active.Sample.Url))
            active.Spawned.TrySetResult(value);
        context.Response.StatusCode = 204; return;
    }
    if (bySourceTarget.TryGetValue(Uri.UnescapeDataString(rawTarget), out var sample) && context.Request.Method is "GET" or "HEAD") {
        var request = new Dictionary<string, object?> {
            ["requestId"] = context.TraceIdentifier, ["caseName"] = sample.Name, ["path"] = context.Request.Path.Value,
            ["rawTarget"] = rawTarget, ["method"] = context.Request.Method, ["range"] = context.Request.Headers.Range.ToString(),
            ["userAgent"] = context.Request.Headers.UserAgent.ToString(), ["bodyWritten"] = 0L,
            ["source"] = FileValue(sample.SourcePath), ["finished"] = false,
        };
        sourceRequests.Enqueue(request);
        context.Response.OnCompleted(() => { completedRequests.Enqueue(context.TraceIdentifier); return Task.CompletedTask; });
        try {
            if (!File.Exists(sample.SourcePath)) { context.Response.StatusCode = 404; request["status"] = 404; return; }
            var bytes = await File.ReadAllBytesAsync(sample.SourcePath, context.RequestAborted);
            long first = 0, last = bytes.LongLength - 1;
            var range = context.Request.Headers.Range.ToString();
            if (range.StartsWith("bytes=", StringComparison.Ordinal)) {
                var pieces = range[6..].Split('-');
                if (pieces.Length != 2 || !long.TryParse(pieces[0], out first) || first < 0
                    || (pieces[1].Length > 0 && !long.TryParse(pieces[1], out last)) || first > last || first >= bytes.LongLength) {
                    context.Response.StatusCode = 416; request["status"] = 416; return;
                }
                last = Math.Min(last, bytes.LongLength - 1); context.Response.StatusCode = 206;
                context.Response.Headers.ContentRange = $"bytes {first}-{last}/{bytes.LongLength}";
            }
            context.Response.ContentType = MimeTypes.GetMimeType(sample.SourcePath);
            context.Response.Headers.AcceptRanges = "bytes"; context.Response.ContentLength = last - first + 1;
            request["status"] = context.Response.StatusCode; request["first"] = first; request["last"] = last;
            request["servedSha256"] = Hash(bytes.AsSpan((int)first, (int)(last - first + 1)).ToArray());
            if (context.Request.Method == "HEAD") return;
            // Charset detection must complete normally. Only a real FFmpeg HTTP
            // read is held; its real child-spawn receipt must also be observed.
            var current = active;
            if (current is not null && current.Sample == sample && current.CancelAfterRead
                && context.Request.Headers.UserAgent.ToString().StartsWith("Lavf/", StringComparison.OrdinalIgnoreCase)) {
                await context.Response.StartAsync(context.RequestAborted);
                await context.Response.Body.FlushAsync(context.RequestAborted);
                request["heldForCancellation"] = true;
                current.Held.TrySetResult(context.TraceIdentifier);
                await Task.Delay(Timeout.Infinite, context.RequestAborted);
            }
            await context.Response.Body.WriteAsync(bytes.AsMemory((int)first, (int)(last - first + 1)), context.RequestAborted);
            request["bodyWritten"] = last - first + 1;
        } catch (Exception error) when (error is OperationCanceledException || context.RequestAborted.IsCancellationRequested) {
            request["aborted"] = true; request["error"] = Failure(error);
        } finally { request["finished"] = true; }
        return;
    }
    var consumer = active;
    if (consumer is null || rawTarget != consumer.PublicTarget || context.Request.Method != "GET") { context.Response.StatusCode = 404; return; }
    var middleware = new ExceptionMiddleware(async response => {
        try {
            var item = new Video { Id = Guid.Parse(consumer.Sample.MediaSourceId), Path = consumer.Sample.SourcePath };
            await using (var stream = await ((ISubtitleEncoder)subtitleEncoder!).GetSubtitles(item, consumer.Sample.MediaSourceId,
                consumer.Sample.Index, consumer.Format, 0, 0, true, consumer.Cancellation.Token)) {
                consumer.StreamAcquired = true;
                response.Response.ContentType = MimeTypes.GetMimeType("subtitle." + consumer.Format);
                await stream.CopyToAsync(response.Response.Body, response.RequestAborted);
            }
            consumer.StreamDisposed = true;
        } catch (Exception error) { consumer.Error = Failure(error); throw; }
    }, NullLogger<ExceptionMiddleware>.Instance, configurationManager, app.Environment);
    await middleware.Invoke(context);
});

try {
    await app.StartAsync(); report["inputHostStarted"] = true;
    report["startupAccepted"] = mediaEncoder.SetFFmpegPath();
    report["version"] = mediaEncoder.EncoderVersion?.ToString();
    subtitleEncoder = NewEncoder();
    foreach (var sample in cases.Values) {
        selectedSource = new MediaSourceInfo {
            Id = sample.MediaSourceId, Path = sample.Protocol == MediaProtocol.File ? sample.SourcePath : sample.Url, Protocol = sample.Protocol,
            MediaStreams = [new MediaStream { Index = sample.Index, Type = MediaStreamType.Subtitle, Codec = "sami",
                Path = sample.Protocol == MediaProtocol.File ? sample.SourcePath : sample.Url,
                IsExternal = true, SupportsExternalStream = true }],
        };
        var actions = new List<object>();
        results.Add(new { name = sample.Name, protocol = sample.Protocol.ToString(), sourcePath = selectedSource.Path,
            cachePath = sample.CachePath, mediaSourceId = sample.MediaSourceId, actions });
        foreach (var definition in sample.Definition.GetProperty("actions").EnumerateArray()) {
            var name = definition.GetProperty("name").GetString()!; var op = definition.GetProperty("op").GetString()!;
            var row = new Dictionary<string, object?> { ["name"] = name, ["op"] = op, ["before"] = Snapshot(sample) };
            actions.Add(row);
            var tracesBefore = Directory.GetFiles(traceDirectory, "*.json").ToHashSet(StringComparer.Ordinal);
            var sourceRequestsBefore = sourceRequests.Count;
            try {
                switch (op) {
                    case "write-source":
                        var changed = definition.GetProperty("revision").GetString() == "changed";
                        await File.WriteAllBytesAsync(sample.SourcePath, Convert.FromBase64String(sample.Source.GetProperty(changed ? "changedBase64" : "base64").GetString()!));
                        File.SetLastWriteTimeUtc(sample.SourcePath, DateTime.Parse(input.GetProperty(changed ? "changedModifiedUtc" : "modifiedUtc").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal));
                        break;
                    case "delete-source": File.Delete(sample.SourcePath); break;
                    case "delete-meta": File.Delete(sample.CachePath + ".meta"); break;
                    case "empty-cache": Directory.CreateDirectory(Path.GetDirectoryName(sample.CachePath)!); await File.WriteAllBytesAsync(sample.CachePath, Array.Empty<byte>()); break;
                    case "delete-cache": File.Delete(sample.CachePath); break;
                    case "request":
                        var cold = definition.TryGetProperty("cold", out var coldValue) && coldValue.GetBoolean();
                        if (cold) { subtitleEncoder.Dispose(); subtitleEncoder = NewEncoder(); }
                        var format = definition.GetProperty("format").GetString()!;
                        var cancel = definition.TryGetProperty("cancelAfterRead", out var cancelValue) && cancelValue.GetBoolean();
                        using (var current = new ActiveRequest(sample, format, cancel)) {
                            active = current;
                            var request = clients.Wire.GetAsync(origin + current.PublicTarget, HttpCompletionOption.ResponseHeadersRead);
                            try {
                                if (cancel) {
                                    var first = await Task.WhenAny(current.Held.Task, request, Task.Delay(TimeSpan.FromSeconds(10)));
                                    if (first != current.Held.Task) throw new InvalidOperationException("Cancellation did not reach an actual held FFmpeg source read.");
                                    await current.Spawned.Task.WaitAsync(TimeSpan.FromSeconds(10));
                                    row["cancellation"] = new { heldRequestId = await current.Held.Task, spawn = await current.Spawned.Task, triggered = true };
                                    current.Cancellation.Cancel();
                                }
                                using var response = await request.WaitAsync(TimeSpan.FromSeconds(20));
                                var bytes = await response.Content.ReadAsByteArrayAsync();
                                row["wire"] = new { status = (int)response.StatusCode, contentType = response.Content.Headers.ContentType?.ToString(),
                                    base64 = Convert.ToBase64String(bytes), bytes = bytes.Length, sha256 = Hash(bytes), text = Encoding.UTF8.GetString(bytes) };
                                row["error"] = current.Error;
                                row["streamAcquired"] = current.StreamAcquired; row["streamDisposed"] = current.StreamDisposed;
                            } catch {
                                current.Cancellation.Cancel();
                                try { using var ignored = await request.WaitAsync(TimeSpan.FromSeconds(10)); }
                                catch (Exception cleanup) { row["requestDrainError"] = Failure(cleanup); }
                                throw;
                            } finally { active = null; }
                        }
                        break;
                    default: throw new InvalidOperationException("Undeclared fixture operation: " + op);
                }
            } catch (Exception error) {
                // Domain failures arrive through the real middleware above.
                // Harness failures are distinct and can never establish a baseline.
                row["harnessError"] = Failure(error); failures.Add(new { caseName = sample.Name, action = name, error = Failure(error) });
            }
            row["after"] = Snapshot(sample);
            var actionTraces = Directory.GetFiles(traceDirectory, "*.json").Where(filename => !tracesBefore.Contains(filename)).Order().ToArray();
            row["traceFiles"] = actionTraces;
            var processes = await ObserveProcesses(actionTraces);
            row["processesAfter"] = processes;
            if (processes.Any(process => process.Alive)) failures.Add(new { caseName = sample.Name, action = name, error = "An actual media process survived the request drain.", processes });
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed < TimeSpan.FromSeconds(5) && sourceRequests.Skip(sourceRequestsBefore).Any(request => !Equals(request["finished"], true))) await Task.Delay(10);
            row["sourceRequests"] = sourceRequests.Skip(sourceRequestsBefore).ToArray();
            if (sourceRequests.Skip(sourceRequestsBefore).Any(request => !Equals(request["finished"], true))) failures.Add(new { caseName = sample.Name, action = name, error = "An actual input HTTP response did not finish after request drain." });
            if (File.Exists(sample.CachePath)) {
                using var reopened = new FileStream(sample.CachePath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                row["cacheReopenedExclusively"] = true;
            }
        }
    }
    report["actualExecution"] = true;
    report["errorEnvironment"] = app.Environment.EnvironmentName;
    report["assemblies"] = new[] { typeof(SubtitleEncoder).Assembly, typeof(ManagedFileSystem).Assembly, typeof(PathManager).Assembly,
        typeof(MediaEncoder).Assembly, typeof(ServerConfigurationManager).Assembly, typeof(ExceptionMiddleware).Assembly,
        typeof(UtfUnknown.CharsetDetector).Assembly, typeof(Nikse.SubtitleEdit.Core.SubtitleFormats.SubtitleFormat).Assembly }
        .Distinct().Select(assembly => new { name = assembly.GetName().Name, filename = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray();
    report["tools"] = new { ffmpeg = Descriptor(args[2]), ffprobe = Descriptor(args[3]), launcher = Descriptor(wrapper) };
} catch (Exception error) { failures.Add(Failure(error)); }
finally {
    try { subtitleEncoder?.Dispose(); report["subtitleEncoderDisposed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    try { protocolManager.Dispose(); report["protocolManagerDisposed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    try { mediaEncoder.Dispose(); report["mediaEncoderDisposed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    try { clients.Dispose(); report["inputClientsClosed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    // Emergency cleanup is recorded separately. A survivor already failed the
    // request; fixture cleanup cannot turn that failed observation into success.
    foreach (var process in await ObserveProcesses(Directory.GetFiles(traceDirectory, "*.json"))) {
        if (!process.Alive) continue;
        try {
            using var original = Process.GetProcessById(process.Pid);
            original.Kill(entireProcessTree: true); await original.WaitForExitAsync();
            emergencyCleanup.Add(new { process.Pid, killed = true });
        } catch (Exception error) { emergencyCleanup.Add(new { process.Pid, error = Failure(error) }); failures.Add(Failure(error)); }
    }
    try { await app.StopAsync(); await app.DisposeAsync(); report["inputHostClosed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    foreach (var operation in Boundary.UnexpectedCalls) failures.Add(new { error = "Out-of-scope dependency invoked.", operation });
    Environment.SetEnvironmentVariable("MEDIAMANAGER_SAMI_FALLBACK_CONTROL", previousControl);
    report["sourceRequests"] = sourceRequests.ToArray(); report["completedRequests"] = completedRequests.ToArray();
    report["spawnNotifications"] = spawnNotifications.ToArray(); report["traces"] = TraceValues(traceDirectory);
    report["processesAfter"] = await ObserveProcesses(Directory.GetFiles(traceDirectory, "*.json"));
    report["filesAfterClose"] = cases.Values.Select(sample => new { name = sample.Name, snapshot = Snapshot(sample) }).ToArray();
    await File.WriteAllTextAsync(outputFile, JsonSerializer.Serialize(report, json) + "\n");
}
if (failures.Count != 0) Environment.ExitCode = 1;

static async Task RunMediaTool(string[] arguments) {
    using var document = JsonDocument.Parse(await File.ReadAllBytesAsync(Environment.GetEnvironmentVariable("MEDIAMANAGER_SAMI_FALLBACK_CONTROL")!));
    var control = document.RootElement;
    var probe = Path.GetFileNameWithoutExtension(Environment.ProcessPath!) == "ffprobe";
    var version = arguments.Length == 1 && arguments[0] == "-version";
    var sourceUrls = control.GetProperty("sourceUrls").EnumerateArray().Select(value => value.GetString()!).ToHashSet(StringComparer.Ordinal);
    var outputs = control.GetProperty("outputPaths").EnumerateArray().Select(value => Path.GetFullPath(value.GetString()!)).ToHashSet(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
    var inputIndex = Array.IndexOf(arguments, "-i");
    var original = inputIndex >= 0 && inputIndex + 1 < arguments.Length && sourceUrls.Contains(arguments[inputIndex + 1]);
    var position = 0;
    bool Next(string expected) => position < arguments.Length && arguments[position++] == expected;
    var text = !probe && Next("-nostdin") && Next("-y");
    if (text && position < arguments.Length && arguments[position] == "-sub_charenc") {
        position++;
        text = position < arguments.Length && !string.IsNullOrWhiteSpace(arguments[position]) && !arguments[position].StartsWith('-');
        position++;
    }
    text = text && Next("-i") && position < arguments.Length && sourceUrls.Contains(arguments[position++])
        && Next("-c:s") && Next("srt") && position == arguments.Length - 1 && outputs.Contains(Path.GetFullPath(arguments[position]));
    var forbidden = arguments.Any(value => value is "lavfi" or "-init_hw_device" or "-vf" or "-af" or "-ac" or "-show_frames"
        || value.StartsWith("-hwaccel", StringComparison.Ordinal) || value.StartsWith("-filter", StringComparison.Ordinal)
        || value.StartsWith("nullsrc", StringComparison.Ordinal));
    var admitted = version || !forbidden && original && (probe || text);
    var trace = Path.Combine(control.GetProperty("traceDirectory").GetString()!, Guid.NewGuid().ToString("N") + ".json");
    var row = new Dictionary<string, object?> { ["wrapperPid"] = Environment.ProcessId, ["childPid"] = null,
        ["arguments"] = arguments, ["forwarded"] = admitted, ["kind"] = version ? "version" : probe ? "probe" : "sami-to-srt",
        ["boundary"] = "Only version, declared-source probe and exact declared SAMI text -> SRT cache conversion are admitted." };
    WriteTrace(trace, row);
    if (!admitted) { Environment.ExitCode = 2; return; }
    var executable = control.GetProperty(probe ? "ffprobe" : "ffmpeg").GetString()!;
    var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var argument in arguments) start.ArgumentList.Add(argument);
    using var process = Process.Start(start) ?? throw new IOException("The admitted media tool did not start.");
    process.StandardInput.Close(); row["childPid"] = process.Id; row["executable"] = executable;
    row["spawnedUtc"] = DateTime.UtcNow.ToString("O"); WriteTrace(trace, row);
    using var termination = OperatingSystem.IsWindows() ? null : PosixSignalRegistration.Create(PosixSignal.SIGTERM, context => {
        context.Cancel = true; try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
    });
    var stdout = Forward(process.StandardOutput.BaseStream, Console.OpenStandardOutput(), trace + ".stdout.bin", process);
    var stderr = Forward(process.StandardError.BaseStream, Console.OpenStandardError(), trace + ".stderr.bin", process);
    if (!version) {
        try {
            using var notify = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            using var response = await notify.PostAsJsonAsync(control.GetProperty("notifyUrl").GetString(), new {
                wrapperPid = Environment.ProcessId, childPid = process.Id, arguments, trace,
            }); response.EnsureSuccessStatusCode();
        } catch (Exception error) {
            row["harnessError"] = Failure(error);
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
        }
    }
    await process.WaitForExitAsync();
    var pipeErrors = new List<object>();
    foreach (var task in new[] { stdout, stderr }) try { await task; } catch (Exception error) { pipeErrors.Add(Failure(error)); }
    row["exitCode"] = process.ExitCode; row["closedUtc"] = DateTime.UtcNow.ToString("O");
    row["stdout"] = FileValue(trace + ".stdout.bin"); row["stderr"] = FileValue(trace + ".stderr.bin"); row["pipeErrors"] = pipeErrors;
    WriteTrace(trace, row);
    Environment.ExitCode = row.ContainsKey("harnessError") || pipeErrors.Count != 0 ? 2 : process.ExitCode;
}
static void WriteTrace(string filename, object value) {
    var temporary = filename + ".pending";
    File.WriteAllText(temporary, JsonSerializer.Serialize(value)); File.Move(temporary, filename, true);
}
static async Task Forward(Stream source, Stream destination, string filename, Process process) {
    await using var saved = new FileStream(filename, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
    var buffer = new byte[16384];
    try {
        while (await source.ReadAsync(buffer) is var count && count > 0) {
            await saved.WriteAsync(buffer.AsMemory(0, count)); await saved.FlushAsync();
            await destination.WriteAsync(buffer.AsMemory(0, count));
        }
        await destination.FlushAsync();
    } catch (Exception error) {
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        catch (Exception cleanup) { throw new AggregateException("Media-tool output and cleanup failed.", error, cleanup); }
        throw;
    }
}
static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
static object Descriptor(string filename) => new { filename, bytes = new FileInfo(filename).Length,
    sha256 = Hash(File.ReadAllBytes(filename)) };
static object Failure(Exception error) => new { name = error.GetType().Name, message = error.Message, stack = error.StackTrace,
    cause = error.InnerException is null ? null : Failure(error.InnerException),
    errors = error is AggregateException group ? group.InnerExceptions.Select(Failure).ToArray() : null };
static object FileValue(string filename) {
    if (!File.Exists(filename)) return new { filename, exists = false };
    var bytes = File.ReadAllBytes(filename); var stat = new FileInfo(filename);
    return new { filename, exists = true, bytes = bytes.LongLength, sha256 = Hash(bytes), base64 = Convert.ToBase64String(bytes),
        text = Encoding.UTF8.GetString(bytes), modifiedUtc = stat.LastWriteTimeUtc.ToString("O"), modifiedTicks = stat.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture) };
}
static object Snapshot(Sample sample) => new { source = FileValue(sample.SourcePath), cache = FileValue(sample.CachePath), meta = FileValue(sample.CachePath + ".meta") };
static object[] TraceValues(string directory) => Directory.GetFiles(directory, "*.json").Order().Select(filename => new {
    filename, value = JsonDocument.Parse(File.ReadAllBytes(filename)).RootElement.Clone(),
    stdout = FileValue(filename + ".stdout.bin"), stderr = FileValue(filename + ".stderr.bin"),
}).Cast<object>().ToArray();
static bool Alive(int pid) {
    try { using var process = Process.GetProcessById(pid); return !process.HasExited; }
    catch (ArgumentException) { return false; }
}
static async Task<ProcessObservation[]> ObserveProcesses(IEnumerable<string> traceFiles) {
    var pids = traceFiles.SelectMany(filename => {
        using var document = JsonDocument.Parse(File.ReadAllBytes(filename)); var value = document.RootElement;
        return new[] { value.GetProperty("wrapperPid"), value.GetProperty("childPid") }
            .Where(pid => pid.ValueKind == JsonValueKind.Number).Select(pid => pid.GetInt32()).ToArray();
    }).Distinct().ToArray();
    var deadline = Stopwatch.StartNew();
    while (deadline.Elapsed < TimeSpan.FromSeconds(5) && pids.Any(Alive)) await Task.Delay(20);
    return pids.Select(pid => new ProcessObservation(pid, Alive(pid))).ToArray();
}
public sealed record ProcessObservation(int Pid, bool Alive);
public sealed class Sample {
    public string Name = "", SourcePath = "", Url = "", CachePath = "", MediaSourceId = "";
    public MediaProtocol Protocol; public int Index;
    public JsonElement Definition, Source;
}
public sealed class ActiveRequest : IDisposable {
    public Sample Sample; public string Format, PublicTarget; public bool CancelAfterRead;
    public CancellationTokenSource Cancellation = new();
    public TaskCompletionSource<string> Held = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource<JsonElement> Spawned = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public object? Error; public bool StreamAcquired, StreamDisposed;
    public ActiveRequest(Sample sample, string format, bool cancel) {
        Sample = sample; Format = format; CancelAfterRead = cancel;
        PublicTarget = $"/Videos/{sample.MediaSourceId}/{sample.MediaSourceId}/Subtitles/{sample.Index}/Stream.{format}";
    }
    public void Dispose() => Cancellation.Dispose();
}
public sealed class FixtureClients : IHttpClientFactory, IDisposable {
    private readonly HttpClient _source = new();
    public HttpClient Wire { get; } = new();
    public HttpClient CreateClient(string name) => _source;
    public void Dispose() { _source.Dispose(); Wire.Dispose(); }
}
public class Boundary : DispatchProxy {
    public static readonly ConcurrentQueue<string> UnexpectedCalls = new();
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Boundary>(); ((Boundary)(object)value).Handler = handler; return value;
    }
    public static Exception Unexpected(string operation) {
        UnexpectedCalls.Enqueue(operation); return new InvalidOperationException("Out-of-scope dependency invoked: " + operation);
    }
    public static T Unused<T>() where T : class => Make<T>((method, _) => throw Unexpected(typeof(T).Name + "." + method.Name));
}
