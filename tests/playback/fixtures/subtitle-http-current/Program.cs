using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
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
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Data.Enums;
using Jellyfin.Networking.HappyEyeballs;
using Jellyfin.Server;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.MediaEncoding.Configuration;
using MediaBrowser.MediaEncoding.Encoder;
using MediaBrowser.MediaEncoding.Subtitles;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dlna;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Infrastructure;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

if (args.Length > 0 && args[0].StartsWith('-')) { await RunMediaTool(args); return; }
CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
var inputBytes = await File.ReadAllBytesAsync(args[0]); using var inputDocument = JsonDocument.Parse(inputBytes);
var input = inputDocument.RootElement; var outputFile = Path.GetFullPath(args[1]);
var root = Path.Combine(Path.GetDirectoryName(outputFile)!, "state");
var files = Path.Combine(root, "inputs"); var traces = Path.Combine(root, "traces");
Directory.CreateDirectory(files); Directory.CreateDirectory(traces);
var failures = new List<object>(); var results = new List<object>();
var sourceRequests = new ConcurrentQueue<Dictionary<string, object?>>(); var notifications = new ConcurrentQueue<JsonElement>();
var hostLifecycle = new List<object>(); var emergencyCleanup = new List<object>();
var report = new Dictionary<string, object?> { ["schemaVersion"] = 1, ["pid"] = Environment.ProcessId,
    ["inputSha256"] = Hash(inputBytes), ["root"] = root, ["cases"] = results, ["failures"] = failures,
    ["hostLifecycle"] = hostLifecycle, ["emergencyCleanup"] = emergencyCleanup,
    ["scope"] = "Actual SubtitleController raw and normal formatted ActionResult execution, plus separate actual ISubtitleEncoder caller-token components, with ExceptionMiddleware. HEAD independently uses actual MVC method routing. Controlled item/source descriptors and owned HTTP input/control only; no full MVC binding, authentication, PlaybackInfo or complete Native instance claim." };
var suffix = OperatingSystem.IsWindows() ? ".exe" : string.Empty;
var apphost = Path.Combine(AppContext.BaseDirectory, "Oracle" + suffix); var wrapper = Path.Combine(AppContext.BaseDirectory, "ffmpeg" + suffix);
foreach (var filename in new[] { wrapper, Path.Combine(AppContext.BaseDirectory, "ffprobe" + suffix) }) {
    File.Copy(apphost, filename, true); if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(filename, File.GetUnixFileMode(apphost));
}
var paths = new ServerApplicationPaths(root, Path.Combine(root, "log"), Path.Combine(root, "config"), Path.Combine(root, "cache"), Path.Combine(root, "web"));
Directory.CreateDirectory(paths.ConfigurationDirectoryPath); var serializer = new MyXmlSerializer();
serializer.SerializeToFile(new ServerConfiguration(), Path.Combine(paths.ConfigurationDirectoryPath, "system.xml"));
serializer.SerializeToFile(new EncodingOptions { EncoderAppPath = wrapper, EncodingThreadCount = 2 }, Path.Combine(paths.ConfigurationDirectoryPath, "encoding.xml"));
var manager = new ServerConfigurationManager(paths, NullLoggerFactory.Instance, serializer); manager.RegisterConfiguration<EncodingConfigurationFactory>();
var configuration = new ConfigurationBuilder().AddInMemoryCollection(new StartupOptions { FFmpegPath = wrapper }.ConvertToConfig()).Build();
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
var pathManager = new PathManager(NullLogger<PathManager>.Instance, manager, paths);
var localization = new LocalizationManager(manager, NullLogger<LocalizationManager>.Instance);
var mediaEncoder = new MediaEncoder(NullLogger<MediaEncoder>.Instance, manager, fileSystem, Boundary.Unused<IBlurayExaminer>(), localization, configuration, manager);
var protocolManager = new MediaSourceManager(Boundary.Unused<IServerApplicationHost>(), Boundary.Unused<IItemRepository>(), paths,
    localization, Boundary.Unused<IUserManager>(), Boundary.Unused<ILibraryManager>(), NullLogger<MediaSourceManager>.Instance,
    fileSystem, Boundary.Unused<IUserDataManager>(), mediaEncoder, Boundary.Unused<IDirectoryService>(),
    Boundary.Unused<IMediaStreamRepository>(), Boundary.Unused<IMediaAttachmentRepository>());
MediaSourceInfo? selectedSource = null; Video? selectedItem = null;
var sourceManager = Boundary.Make<IMediaSourceManager>((method, values) => method.Name switch {
    "GetPathProtocol" => protocolManager.GetPathProtocol((string)values![0]!),
    "GetStaticMediaSources" => (IReadOnlyList<MediaSourceInfo>)[selectedSource ?? throw new InvalidOperationException("No declared source selected.")],
    "GetPlaybackMediaSources" => Task.FromResult<IReadOnlyList<MediaSourceInfo>>([selectedSource ?? throw new InvalidOperationException("No declared source selected.")]),
    _ => throw Boundary.Unexpected("IMediaSourceManager." + method.Name),
});
var library = Boundary.Make<ILibraryManager>((method, _) => method.Name == "GetItemById" && method.IsGenericMethod
    ? selectedItem : throw Boundary.Unexpected("ILibraryManager." + method.Name));
var parser = new SubtitleEditParser(NullLogger<SubtitleEditParser>.Instance); using var clients = new FixtureClients();
SubtitleEncoder? encoder = null;
SubtitleEncoder NewEncoder() => new(NullLogger<SubtitleEncoder>.Instance, fileSystem, mediaEncoder, clients, sourceManager, parser, pathManager, manager);
const string sourceOrigin = "http://127.0.0.1:5244";
var sources = input.GetProperty("sources").EnumerateArray().ToDictionary(value => value.GetProperty("name").GetString()!, value => value.Clone());
var cases = new Dictionary<string, Sample>(StringComparer.Ordinal);
foreach (var definition in input.GetProperty("cases").EnumerateArray()) {
    var name = definition.GetProperty("name").GetString()!; var source = sources[definition.GetProperty("source").GetString()!];
    var filename = Path.Combine(files, name + source.GetProperty("extension").GetString());
    await File.WriteAllBytesAsync(filename, Convert.FromBase64String(source.GetProperty("base64").GetString()!));
    var id = definition.GetProperty("mediaSourceId").GetString()!;
    cases.Add(name, new Sample { Name = name, Definition = definition.Clone(), Source = source, SourcePath = filename,
        Url = sourceOrigin + definition.GetProperty("sourceTarget").GetString(), MediaSourceId = id,
        Index = definition.GetProperty("streamIndex").GetInt32(),
        CachePath = pathManager.GetSubtitlePath(id, definition.GetProperty("streamIndex").GetInt32(), ".srt")
            ?? throw new InvalidOperationException("The declared media source has no Native cache path.") });
}
ActiveRequest? active = null; WebApplication? sourceApp = null;
WebApplication SourceHost() {
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = Environments.Production });
    builder.Logging.ClearProviders(); builder.WebHost.UseUrls(sourceOrigin); var host = builder.Build();
    host.Run(async context => {
        var rawTarget = context.Features.Get<IHttpRequestFeature>()!.RawTarget!;
        var target = Uri.UnescapeDataString(rawTarget);
        var sample = cases.Values.FirstOrDefault(value => Uri.UnescapeDataString(value.Definition.GetProperty("sourceTarget").GetString()!) == target);
        var redirected = false;
        if (sample is null && target.StartsWith("/redirected/", StringComparison.Ordinal)) {
            sample = cases.Values.FirstOrDefault(value => "/redirected/" + value.Name + value.Source.GetProperty("extension").GetString() == target);
            redirected = sample is not null;
        }
        if (sample is null || context.Request.Method is not ("GET" or "HEAD")) { context.Response.StatusCode = 404; return; }
        var receipt = new Dictionary<string, object?> { ["requestId"] = context.TraceIdentifier, ["caseName"] = sample.Name,
            ["method"] = context.Request.Method, ["target"] = rawTarget, ["headers"] = context.Request.Headers.ToDictionary(value => value.Key, value => value.Value.ToString()),
            ["source"] = FileValue(sample.SourcePath), ["mode"] = sample.Mode, ["bodyWritten"] = 0L, ["finished"] = false };
        sourceRequests.Enqueue(receipt);
        context.Response.OnCompleted(() => { receipt["responseCompleted"] = true; return Task.CompletedTask; });
        using var abortRegistration = context.RequestAborted.Register(() => receipt["requestAborted"] = true);
        try {
            if (!redirected && sample.Mode == "redirect") {
                context.Response.StatusCode = 302; context.Response.Headers.Location = "/redirected/" + sample.Name + sample.Source.GetProperty("extension").GetString();
                context.Response.ContentLength = 0; return;
            }
            byte[] bytes;
            if (sample.Mode is "403" or "404") {
                context.Response.StatusCode = int.Parse(sample.Mode); bytes = Encoding.UTF8.GetBytes("Owned HTTP " + sample.Mode + " response.\r\n");
            } else bytes = await File.ReadAllBytesAsync(sample.SourcePath, context.RequestAborted);
            context.Response.ContentType = "text/plain; charset=utf-8";
            context.Response.Headers.ETag = sample.Changed ? "\"owned-changed\"" : "\"owned-original\"";
            context.Response.Headers.LastModified = sample.Changed ? "Fri, 03 Jan 2025 03:04:05 GMT" : "Thu, 02 Jan 2025 03:04:05 GMT";
            context.Response.Headers.AcceptRanges = "bytes";
            long first = 0, last = bytes.LongLength - 1;
            var range = context.Request.Headers.Range.ToString(); var ifRange = context.Request.Headers.IfRange.ToString();
            if (context.Response.StatusCode == 200 && sample.Mode != "ignore-range" && range.StartsWith("bytes=", StringComparison.Ordinal)
                && (ifRange.Length == 0 || ifRange == context.Response.Headers.ETag.ToString())) {
                var pieces = range[6..].Split('-');
                var valid = pieces.Length == 2;
                if (valid && pieces[0].Length == 0) {
                    valid = long.TryParse(pieces[1], out var tail) && tail > 0; if (valid) first = Math.Max(0, bytes.LongLength - tail);
                } else if (valid) valid = long.TryParse(pieces[0], out first) && (pieces[1].Length == 0 || long.TryParse(pieces[1], out last));
                valid &= first >= 0 && last >= first && first < bytes.LongLength;
                if (!valid) { context.Response.StatusCode = 416; context.Response.Headers.ContentRange = "bytes */" + bytes.LongLength; context.Response.ContentLength = 0; return; }
                last = Math.Min(last, bytes.LongLength - 1); context.Response.StatusCode = 206;
                context.Response.Headers.ContentRange = $"bytes {first}-{last}/{bytes.LongLength}";
            }
            var payload = bytes.AsSpan((int)first, (int)(last - first + 1)).ToArray();
            if (sample.Mode == "gzip") {
                using var compressed = new MemoryStream();
                using (var gzip = new GZipStream(compressed, CompressionLevel.Optimal, true)) gzip.Write(payload);
                payload = compressed.ToArray(); context.Response.Headers.ContentEncoding = "gzip";
            }
            if (sample.Mode != "chunked") context.Response.ContentLength = payload.LongLength;
            receipt["first"] = first; receipt["last"] = last; receipt["servedSha256"] = Hash(bytes.AsSpan((int)first, (int)(last - first + 1)).ToArray());
            receipt["responseBody"] = new { bytes = payload.Length, base64 = Convert.ToBase64String(payload), sha256 = Hash(payload) };
            if (context.Request.Method == "HEAD") return;
            var current = active; var lavf = context.Request.Headers.UserAgent.ToString().StartsWith("Lavf/", StringComparison.OrdinalIgnoreCase);
            if (current is not null && current.Sample == sample && (current.CancelAt == "charset" && !lavf || current.CancelAt == "ffmpeg" && lavf)) {
                await context.Response.StartAsync(context.RequestAborted); await context.Response.Body.FlushAsync(context.RequestAborted);
                receipt["heldAt"] = current.CancelAt; current.Held.TrySetResult(context.TraceIdentifier);
                await Task.Delay(Timeout.Infinite, context.RequestAborted);
            }
            if (current is not null && current.Sample == sample && current.ClientDisconnectAfterRead && lavf) {
                await context.Response.StartAsync(context.RequestAborted); await context.Response.Body.FlushAsync(context.RequestAborted);
                receipt["heldAt"] = "controller-disconnect"; current.Held.TrySetResult(context.TraceIdentifier);
                await current.SourceReleased.Task.WaitAsync(context.RequestAborted);
                receipt["sourceReleasedAfterClientDisconnect"] = true;
            }
            if (current is not null && current.Sample == sample && current.CancelAfterBytes.HasValue) {
                var prefix = Math.Min(payload.LongLength, current.CancelAfterBytes.Value + 7);
                await context.Response.Body.WriteAsync(payload.AsMemory(0, (int)prefix), context.RequestAborted);
                await context.Response.Body.FlushAsync(context.RequestAborted); receipt["bodyWritten"] = prefix;
                receipt["heldAt"] = "raw-response"; current.Held.TrySetResult(context.TraceIdentifier);
                await Task.Delay(Timeout.Infinite, context.RequestAborted);
            }
            if (sample.Mode == "chunked") {
                var midpoint = payload.Length / 2;
                await context.Response.Body.WriteAsync(payload.AsMemory(0, midpoint), context.RequestAborted);
                await context.Response.Body.FlushAsync(context.RequestAborted);
                await context.Response.Body.WriteAsync(payload.AsMemory(midpoint), context.RequestAborted);
            } else await context.Response.Body.WriteAsync(payload, context.RequestAborted);
            receipt["bodyWritten"] = payload.LongLength;
        } catch (Exception error) when (error is OperationCanceledException || context.RequestAborted.IsCancellationRequested) {
            receipt["aborted"] = true; receipt["error"] = Failure(error);
        } finally {
            receipt["status"] = context.Response.StatusCode;
            receipt["responseHeaders"] = context.Response.Headers.ToDictionary(value => value.Key, value => value.Value.ToString()); receipt["finished"] = true;
        }
    }); return host;
}
async Task StartSource() { sourceApp = SourceHost(); await sourceApp.StartAsync(); hostLifecycle.Add(new { sourceStarted = true, origin = sourceOrigin }); }
async Task StopSource() {
    if (sourceApp is null) return; var owned = sourceApp; sourceApp = null;
    try { await owned.StopAsync(); } finally { await owned.DisposeAsync(); }
    hostLifecycle.Add(new { sourceStopped = true, origin = sourceOrigin });
}
var publicBuilder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = Environments.Production });
publicBuilder.Logging.ClearProviders(); publicBuilder.WebHost.UseUrls("http://127.0.0.1:0");
publicBuilder.Services.AddJellyfinApi([], new NetworkConfiguration())
    .ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlySubtitleController()));
var publicApp = publicBuilder.Build();
publicApp.Use(async (context, next) => {
    if (context.Request.Path == "/control/spawn" && context.Request.Method == "POST") {
        using var receipt = await JsonDocument.ParseAsync(context.Request.Body, cancellationToken: context.RequestAborted); var value = receipt.RootElement.Clone(); notifications.Enqueue(value);
        if (active is not null && value.GetProperty("arguments").EnumerateArray().Any(argument => argument.GetString() == active.Sample.Url)) active.Spawned.TrySetResult(value);
        context.Response.StatusCode = 204; return;
    }
    var current = active;
    if (current is null || context.Request.Path != current.PublicTarget) { context.Response.StatusCode = 404; return; }
    using var disconnected = context.RequestAborted.Register(() => current.ClientDisconnected.TrySetResult());
    context.Response.OnCompleted(() => { current.ResponseCompleted.TrySetResult(); return Task.CompletedTask; });
    if (context.Request.Method == "HEAD") {
        current.ActualMethodRouting = true;
        try { await next(); } finally { current.ExecutionFinished.TrySetResult(); }
        return;
    }
    var middleware = new ExceptionMiddleware(async response => {
        try {
            if (current.Op == "raw" || current.CancelAt is null) {
                var controller = new SubtitleController(manager, library, Boundary.Unused<ISubtitleManager>(), encoder!, sourceManager,
                    Boundary.Unused<IProviderManager>(), fileSystem, clients, NullLogger<SubtitleController>.Instance) {
                    ControllerContext = new ControllerContext { HttpContext = response },
                };
                current.ActualRawController = current.Op == "raw"; current.ActualFormatController = current.Op != "raw";
                var result = await controller.GetSubtitle(Guid.Parse(current.Sample.MediaSourceId), current.Sample.MediaSourceId,
                    current.Sample.Index, current.Op == "raw" ? string.Empty : current.Format, null, null, null, null, null, true, false, 0);
                current.ActualResultExecutor = true;
                await result.ExecuteResultAsync(new ActionContext(response, new RouteData(), new ActionDescriptor()));
            } else {
                await using (var stream = await ((ISubtitleEncoder)encoder!).GetSubtitles(selectedItem!, current.Sample.MediaSourceId, current.Sample.Index,
                    current.Format, 0, 0, true, current.Cancellation.Token)) {
                    current.StreamAcquired = true; response.Response.ContentType = MimeTypes.GetMimeType("subtitle." + current.Format);
                    await stream.CopyToAsync(response.Response.Body, response.RequestAborted);
                } current.StreamDisposed = true;
            }
        } catch (Exception error) { current.Error = Failure(error); throw; }
    }, NullLogger<ExceptionMiddleware>.Instance, manager, publicApp.Environment);
    try { await middleware.Invoke(context); } finally { current.ExecutionFinished.TrySetResult(); }
});
publicApp.MapControllers();
var controlFile = Path.Combine(root, "tool-control.json");
var previousControl = Environment.GetEnvironmentVariable("MEDIAMANAGER_HTTP_SUBTITLE_CONTROL");
try {
    await publicApp.StartAsync(); var publicOrigin = publicApp.Urls.Single();
    _ = publicApp.Services.GetRequiredService<IActionResultExecutor<FileStreamResult>>();
    await StartSource();
    await File.WriteAllTextAsync(controlFile, JsonSerializer.Serialize(new { ffmpeg = args[2], ffprobe = args[3], traceDirectory = traces,
        sourceUrls = cases.Values.Select(sample => sample.Url), outputPaths = cases.Values.Select(sample => sample.CachePath), notifyUrl = publicOrigin + "/control/spawn" }));
    Environment.SetEnvironmentVariable("MEDIAMANAGER_HTTP_SUBTITLE_CONTROL", controlFile);
    report["startupAccepted"] = mediaEncoder.SetFFmpegPath(); report["version"] = mediaEncoder.EncoderVersion?.ToString(); encoder = NewEncoder();
    var profileResults = new List<object>(); report["profiles"] = profileResults;
    foreach (var definition in input.GetProperty("profiles").EnumerateArray()) {
        var stream = new MediaStream { Type = MediaStreamType.Subtitle, Index = 0,
            IsExternal = !definition.TryGetProperty("external", out var external) || external.GetBoolean(), SupportsExternalStream = true,
            Codec = definition.GetProperty("codec").GetString(), Language = "eng", Path = sourceOrigin + "/profile-source.subtitle" };
        var source = new MediaSourceInfo { Id = "f8a00000-0000-0000-0000-000000000099", Protocol = MediaProtocol.File,
            Path = Path.Combine(root, "unread-profile-video.mkv"), MediaStreams = [stream] };
        var candidate = new SubtitleProfile { Method = Enum.Parse<SubtitleDeliveryMethod>(definition.GetProperty("method").GetString()!),
            Format = definition.GetProperty("candidate").GetString(), Container = "mkv" };
        var profile = StreamBuilder.GetSubtitleProfile(source, stream, [candidate],
            Enum.Parse<MediaBrowser.Model.Session.PlayMethod>(definition.GetProperty("playMethod").GetString()!), new NoGenerationSupport(), "mkv", MediaStreamProtocol.http);
        profileResults.Add(new { name = definition.GetProperty("name").GetString(), input = definition.Clone(),
            profile = new { profile.Format, Method = profile.Method.ToString(), profile.DidlMode, profile.Language, profile.Container } });
    }
    foreach (var sample in cases.Values) {
        if (sourceApp is null) await StartSource();
        var mediaProtocol = Enum.Parse<MediaProtocol>(sample.Definition.GetProperty("mediaProtocol").GetString()!);
        var mediaPath = mediaProtocol == MediaProtocol.File ? Path.Combine(root, "unread-media", sample.Name + ".mkv") : sourceOrigin + "/unread-media/" + sample.Name + ".mkv";
        selectedItem = new Video { Id = Guid.Parse(sample.MediaSourceId), Path = mediaPath };
        selectedSource = new MediaSourceInfo { Id = sample.MediaSourceId, Path = mediaPath, Protocol = mediaProtocol,
            MediaStreams = [new MediaStream { Index = sample.Index, Type = MediaStreamType.Subtitle, Codec = sample.Source.GetProperty("codec").GetString(),
                Path = sample.Url, IsExternal = true, SupportsExternalStream = true }] };
        var actions = new List<object>();
        results.Add(new { name = sample.Name, mediaSourceId = sample.MediaSourceId, mediaProtocol = mediaProtocol.ToString(),
            subtitlePath = selectedSource.MediaStreams[0].Path, subtitleProtocol = protocolManager.GetPathProtocol(sample.Url).ToString(), cachePath = sample.CachePath, actions });
        foreach (var definition in sample.Definition.GetProperty("actions").EnumerateArray()) {
            var name = definition.GetProperty("name").GetString()!; var op = definition.GetProperty("op").GetString()!;
            var row = new Dictionary<string, object?> { ["name"] = name, ["op"] = op, ["before"] = Snapshot(sample, sourceApp is not null) }; actions.Add(row);
            var tracesBefore = Directory.GetFiles(traces, "*.json").ToHashSet(StringComparer.Ordinal); var requestsBefore = sourceRequests.Count;
            try {
                switch (op) {
                    case "source-mode":
                        sample.Mode = definition.GetProperty("mode").GetString()!;
                        if (sample.Mode == "offline") await StopSource();
                        else if (sourceApp is null) await StartSource();
                        break;
                    case "write-source":
                        var changed = definition.GetProperty("revision").GetString() == "changed";
                        await File.WriteAllBytesAsync(sample.SourcePath, Convert.FromBase64String(sample.Source.GetProperty(changed ? "changedBase64" : "base64").GetString()!)); sample.Changed = changed; break;
                    case "seed-cache":
                        Directory.CreateDirectory(Path.GetDirectoryName(sample.CachePath)!);
                        if (definition.TryGetProperty("cacheBase64", out var seeded)) await File.WriteAllBytesAsync(sample.CachePath, Convert.FromBase64String(seeded.GetString()!));
                        if (definition.TryGetProperty("metaBase64", out var meta)) await File.WriteAllBytesAsync(sample.CachePath + ".meta", Convert.FromBase64String(meta.GetString()!));
                        break;
                    case "empty-cache": Directory.CreateDirectory(Path.GetDirectoryName(sample.CachePath)!); await File.WriteAllBytesAsync(sample.CachePath, Array.Empty<byte>()); break;
                    case "delete-cache": File.Delete(sample.CachePath); break;
                    case "delete-meta": File.Delete(sample.CachePath + ".meta"); break;
                    case "raw":
                    case "format":
                        if (definition.TryGetProperty("cold", out var cold) && cold.GetBoolean()) { encoder.Dispose(); encoder = NewEncoder(); }
                        using (var current = new ActiveRequest(sample, definition)) {
                            active = current;
                            using var transportCancellation = new CancellationTokenSource();
                            using var request = new HttpRequestMessage(new HttpMethod(op == "raw" ? definition.GetProperty("method").GetString()! : "GET"), publicOrigin + current.PublicTarget);
                            if (definition.TryGetProperty("headers", out var headers)) foreach (var header in headers.EnumerateObject()) request.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString());
                            row["request"] = new { method = request.Method.Method, path = current.PublicTarget,
                                headers = request.Headers.ToDictionary(value => value.Key, value => string.Join(", ", value.Value)),
                                subtitlePath = sample.Url, mediaProtocol = mediaProtocol.ToString() };
                            var responseTask = clients.Wire.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, transportCancellation.Token);
                            try {
                                if (current.ClientDisconnectAfterRead) {
                                    var reached = await Task.WhenAny(current.Held.Task, responseTask, Task.Delay(TimeSpan.FromSeconds(10)));
                                    if (reached != current.Held.Task) throw new InvalidOperationException("Controller disconnect did not reach an actual held FFmpeg read.");
                                    await current.Spawned.Task.WaitAsync(TimeSpan.FromSeconds(10));
                                    transportCancellation.Cancel();
                                    try { using var unexpectedResponse = await responseTask.WaitAsync(TimeSpan.FromSeconds(5)); row["clientTransportReturned"] = true; }
                                    catch (Exception error) { row["clientDisconnectError"] = Failure(error); }
                                    await current.ClientDisconnected.Task.WaitAsync(TimeSpan.FromSeconds(10));
                                    row["cancellation"] = new { stage = "controller-disconnect", heldRequestId = await current.Held.Task,
                                        spawn = await current.Spawned.Task, triggered = true, serverRequestAborted = true,
                                        boundary = "Actual SubtitleController client disconnect; producer keeps its real CancellationToken.None, then the owned source gate is released." };
                                    current.SourceReleased.TrySetResult();
                                    await current.ExecutionFinished.Task.WaitAsync(TimeSpan.FromSeconds(20));
                                } else {
                                if (current.CancelAt is not null) {
                                    var first = await Task.WhenAny(current.Held.Task, responseTask, Task.Delay(TimeSpan.FromSeconds(10)));
                                    if (first != current.Held.Task) throw new InvalidOperationException("The component cancellation did not reach its actual source read.");
                                    if (current.CancelAt == "ffmpeg") await current.Spawned.Task.WaitAsync(TimeSpan.FromSeconds(10));
                                    row["cancellation"] = new { stage = current.CancelAt, heldRequestId = await current.Held.Task,
                                        spawn = current.CancelAt == "ffmpeg" ? (object)await current.Spawned.Task : null, triggered = true,
                                        boundary = "Actual ISubtitleEncoder caller token; not a SubtitleController client-disconnect claim." };
                                    current.Cancellation.Cancel();
                                }
                                using var response = await responseTask.WaitAsync(TimeSpan.FromSeconds(20));
                                byte[] bytes;
                                if (current.CancelAfterBytes.HasValue) {
                                    using var reader = await response.Content.ReadAsStreamAsync(); bytes = new byte[current.CancelAfterBytes.Value];
                                    await reader.ReadExactlyAsync(bytes.AsMemory(), transportCancellation.Token).AsTask().WaitAsync(TimeSpan.FromSeconds(10));
                                    await current.Held.Task.WaitAsync(TimeSpan.FromSeconds(10)); transportCancellation.Cancel(); response.Dispose();
                                    row["cancellation"] = new { stage = "raw-response", heldRequestId = await current.Held.Task, triggered = true,
                                        boundary = "Actual public HTTP body read followed by client cancellation and response disposal." };
                                } else bytes = await response.Content.ReadAsByteArrayAsync();
                                row["wire"] = new { status = (int)response.StatusCode,
                                    headers = response.Headers.Concat(response.Content.Headers).ToDictionary(value => value.Key.ToLowerInvariant(), value => string.Join(", ", value.Value)),
                                    base64 = Convert.ToBase64String(bytes), bodyBase64 = Convert.ToBase64String(bytes), bytes = bytes.Length, sha256 = Hash(bytes), text = Encoding.UTF8.GetString(bytes),
                                    partial = current.CancelAfterBytes.HasValue };
                                await current.ExecutionFinished.Task.WaitAsync(TimeSpan.FromSeconds(10));
                                if (!current.CancelAfterBytes.HasValue) await current.ResponseCompleted.Task.WaitAsync(TimeSpan.FromSeconds(10));
                                }
                                row["error"] = current.Error; row["actualRawController"] = current.ActualRawController;
                                row["actualFormatController"] = current.ActualFormatController; row["actualResultExecutor"] = current.ActualResultExecutor;
                                row["actualMethodRouting"] = current.ActualMethodRouting;
                                row["streamAcquired"] = current.StreamAcquired; row["streamDisposed"] = current.StreamDisposed;
                            } catch {
                                current.Cancellation.Cancel(); transportCancellation.Cancel(); current.SourceReleased.TrySetResult();
                                try { using var ignored = await responseTask.WaitAsync(TimeSpan.FromSeconds(5)); } catch (Exception cleanup) { row["transportDrainError"] = Failure(cleanup); }
                                try { await current.ExecutionFinished.Task.WaitAsync(TimeSpan.FromSeconds(5)); } catch (Exception cleanup) { row["executionDrainError"] = Failure(cleanup); }
                                throw;
                            } finally { current.SourceReleased.TrySetResult(); active = null; }
                        }
                        break;
                    default: throw new InvalidOperationException("Undeclared HTTP fixture operation: " + op);
                }
            } catch (Exception error) { row["harnessError"] = Failure(error); failures.Add(new { caseName = sample.Name, action = name, error = Failure(error) }); }
            var actionTraces = Directory.GetFiles(traces, "*.json").Where(filename => !tracesBefore.Contains(filename)).Order().ToArray();
            row["traceFiles"] = actionTraces; var processes = await ObserveProcesses(actionTraces); row["processesAfter"] = processes;
            if (processes.Any(value => value.Alive)) failures.Add(new { caseName = sample.Name, action = name, error = "An actual media process survived its drain.", processes });
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed < TimeSpan.FromSeconds(5) && sourceRequests.Skip(requestsBefore).Any(value => !Equals(value["finished"], true))) await Task.Delay(10);
            row["sourceRequests"] = sourceRequests.Skip(requestsBefore).ToArray();
            if (sourceRequests.Skip(requestsBefore).Any(value => !Equals(value["finished"], true))) failures.Add(new { caseName = sample.Name, action = name, error = "An owned source response did not close." });
            row["after"] = Snapshot(sample, sourceApp is not null);
            if (File.Exists(sample.CachePath)) { using var readable = new FileStream(sample.CachePath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); row["cacheReopenedExclusively"] = true; }
        }
    }
    report["actualExecution"] = true; report["errorEnvironment"] = publicApp.Environment.EnvironmentName;
    report["defaultClientConfiguration"] = clients.Configuration;
    report["tools"] = new { ffmpeg = Descriptor(args[2]), ffprobe = Descriptor(args[3]), launcher = Descriptor(wrapper) };
    report["assemblies"] = new[] { typeof(SubtitleController).Assembly, typeof(SubtitleEncoder).Assembly, typeof(ManagedFileSystem).Assembly,
        typeof(PathManager).Assembly, typeof(MediaEncoder).Assembly, typeof(ServerConfigurationManager).Assembly,
        typeof(UtfUnknown.CharsetDetector).Assembly, typeof(Nikse.SubtitleEdit.Core.SubtitleFormats.SubtitleFormat).Assembly,
        typeof(HttpClientExtension).Assembly, typeof(CoreAppHost).Assembly }
        .Distinct().Select(assembly => new { name = assembly.GetName().Name, filename = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray();
    report["frameworkAssemblies"] = new[] { typeof(FileStreamResult).Assembly, typeof(WebApplication).Assembly }.Distinct()
        .Select(assembly => new { name = assembly.GetName().Name, filename = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray();
} catch (Exception error) { failures.Add(Failure(error)); }
finally {
    try { encoder?.Dispose(); report["subtitleEncoderDisposed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    try { protocolManager.Dispose(); report["protocolManagerDisposed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    try { mediaEncoder.Dispose(); report["mediaEncoderDisposed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    try { clients.Dispose(); report["inputClientsClosed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    foreach (var process in await ObserveProcesses(Directory.GetFiles(traces, "*.json"))) {
        if (!process.Alive) continue;
        try { using var original = Process.GetProcessById(process.Pid); original.Kill(entireProcessTree: true); await original.WaitForExitAsync(); emergencyCleanup.Add(new { process.Pid, killed = true }); }
        catch (Exception error) { emergencyCleanup.Add(new { process.Pid, error = Failure(error) }); failures.Add(Failure(error)); }
    }
    try { await StopSource(); report["sourceHostClosed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    try { await publicApp.StopAsync(); await publicApp.DisposeAsync(); report["publicHostClosed"] = true; } catch (Exception error) { failures.Add(Failure(error)); }
    foreach (var operation in Boundary.UnexpectedCalls) failures.Add(new { error = "Out-of-scope dependency invoked.", operation });
    Environment.SetEnvironmentVariable("MEDIAMANAGER_HTTP_SUBTITLE_CONTROL", previousControl);
    report["sourceRequests"] = sourceRequests.ToArray(); report["spawnNotifications"] = notifications.ToArray(); report["traces"] = TraceValues(traces);
    report["processesAfter"] = await ObserveProcesses(Directory.GetFiles(traces, "*.json"));
    report["filesAfterClose"] = cases.Values.Select(sample => new { name = sample.Name, snapshot = Snapshot(sample, false) }).ToArray();
    await File.WriteAllTextAsync(outputFile, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }) + "\n");
}
if (failures.Count != 0) Environment.ExitCode = 1;

static async Task RunMediaTool(string[] arguments) {
    using var document = JsonDocument.Parse(await File.ReadAllBytesAsync(Environment.GetEnvironmentVariable("MEDIAMANAGER_HTTP_SUBTITLE_CONTROL")!));
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
        ["arguments"] = arguments, ["forwarded"] = admitted, ["kind"] = version ? "version" : probe ? "probe" : "text-to-srt",
        ["boundary"] = "Only version, declared-source probe and exact declared subtitle text -> SRT cache conversion are admitted." };
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
static object Snapshot(Sample sample, bool sourceOnline) => new { source = FileValue(sample.SourcePath), cache = FileValue(sample.CachePath), meta = FileValue(sample.CachePath + ".meta"), sourceOnline, sourceMode = sample.Mode };
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
    public string Name = "", SourcePath = "", Url = "", CachePath = "", MediaSourceId = "", Mode = "online";
    public int Index; public bool Changed; public JsonElement Definition, Source;
}
public sealed class ActiveRequest : IDisposable {
    public Sample Sample; public string Op, Format, PublicTarget, Method; public string? CancelAt; public int? CancelAfterBytes; public bool ClientDisconnectAfterRead;
    public CancellationTokenSource Cancellation = new();
    public TaskCompletionSource<string> Held = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource<JsonElement> Spawned = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource ExecutionFinished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource ResponseCompleted = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource ClientDisconnected = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource SourceReleased = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public object? Error; public bool StreamAcquired, StreamDisposed, ActualRawController, ActualFormatController, ActualResultExecutor, ActualMethodRouting;
    public ActiveRequest(Sample sample, JsonElement definition) {
        Sample = sample; Op = definition.GetProperty("op").GetString()!;
        Method = Op == "raw" ? definition.GetProperty("method").GetString()! : "GET";
        Format = definition.TryGetProperty("format", out var format) ? format.GetString()! : "";
        CancelAt = definition.TryGetProperty("cancelAt", out var cancel) ? cancel.GetString() : null;
        CancelAfterBytes = definition.TryGetProperty("cancelAfterBytes", out var limit) ? limit.GetInt32() : null;
        ClientDisconnectAfterRead = definition.TryGetProperty("clientDisconnectAfterRead", out var disconnected) && disconnected.GetBoolean();
        PublicTarget = $"/Videos/{sample.MediaSourceId}/{sample.MediaSourceId}/Subtitles/{sample.Index}/Stream"
            + (Op == "raw" ? Method == "HEAD" ? ".srt" : "" : "." + Format);
    }
    public void Dispose() => Cancellation.Dispose();
}
public sealed class OnlySubtitleController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var controller in feature.Controllers.Where(value => value.AsType() != typeof(SubtitleController)).ToArray()) feature.Controllers.Remove(controller);
    }
}
public sealed class FixtureClients : IHttpClientFactory, IDisposable {
    private readonly HttpClient _source;
    public object Configuration { get; }
    public HttpClient Wire { get; } = new();
    public FixtureClients() {
        // Startup's actual named default-client transport and headers. The
        // designated entry assembly supplies the real product metadata.
        _source = new HttpClient(new SocketsHttpHandler { AutomaticDecompression = DecompressionMethods.All,
            RequestHeaderEncodingSelector = (_, _) => Encoding.UTF8, ConnectCallback = HttpClientExtension.OnConnect });
        var product = FileVersionInfo.GetVersionInfo(typeof(CoreAppHost).Assembly.Location).ProductName!.Replace(' ', '-');
        var version = typeof(Emby.Server.Implementations.ApplicationHost).Assembly.GetName().Version!.ToString(3);
        _source.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue(product, version));
        _source.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json", 1.0));
        _source.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/xml", 0.9));
        _source.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("*/*", 0.8));
        Configuration = new { userAgent = _source.DefaultRequestHeaders.UserAgent.ToString(), accept = _source.DefaultRequestHeaders.Accept.ToString(),
            automaticDecompression = "All", requestHeaderEncoding = "UTF-8", connectCallback = "Actual designated HttpClientExtension.OnConnect" };
    }
    public HttpClient CreateClient(string name) {
        if (name != MediaBrowser.Common.Net.NamedClient.Default) throw Boundary.Unexpected("IHttpClientFactory.CreateClient:" + name);
        return _source;
    }
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
public sealed class NoGenerationSupport : ITranscoderSupport {
    private static bool Reject(string operation) { Boundary.UnexpectedCalls.Enqueue(operation); return false; }
    public bool CanEncodeToAudioCodec(string codec) => Reject("ITranscoderSupport.CanEncodeToAudioCodec");
    public bool CanEncodeToSubtitleCodec(string codec) => Reject("ITranscoderSupport.CanEncodeToSubtitleCodec");
    public bool CanExtractSubtitles(string codec) => codec is "ass" or "ssa" || Reject("ITranscoderSupport.CanExtractSubtitles");
}
