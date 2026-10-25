using System.Diagnostics;
using System.Collections.Concurrent;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Data.Enums;
using Jellyfin.Api.Middleware;
using Jellyfin.Extensions.Json;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.MediaEncoding.Configuration;
using MediaBrowser.MediaEncoding.Encoder;
using MediaBrowser.MediaEncoding.Subtitles;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dlna;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Session;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

// The apphost is a fixture process owner. It forwards only the supplied real
// ffmpeg invocation and reports its actual PIDs over the private control port.
if (args[0].StartsWith('-')) {
    var executable = Environment.GetEnvironmentVariable("MEDIAMANAGER_SUBTITLE_REAL_FFMPEG")!;
    var trace = Environment.GetEnvironmentVariable("MEDIAMANAGER_SUBTITLE_TRACE_URL");
    var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var argument in args) start.ArgumentList.Add(argument);
    using var process = Process.Start(start) ?? throw new IOException("The actual subtitle copy process did not start.");
    process.StandardInput.Close();
    if (trace is not null) {
        using var client = new HttpClient();
        using var response = await client.PostAsync(trace, new StringContent(JsonSerializer.Serialize(new {
            wrapperPid = Environment.ProcessId, childPid = process.Id, executable, arguments = args }), Encoding.UTF8, "application/json"));
        response.EnsureSuccessStatusCode();
    }
    var stdout = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
    var stderr = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
    await process.WaitForExitAsync(); await Task.WhenAll(stdout, stderr); Environment.ExitCode = process.ExitCode; return;
}

var inputBytes = File.ReadAllBytes(args[0]); using var document = JsonDocument.Parse(inputBytes); var input = document.RootElement;
var output = args[1]; var ffmpeg = args[2]; var root = Path.Combine(Path.GetDirectoryName(output)!, "states"); Directory.CreateDirectory(root);
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never, WriteIndented = true };
object Failure(Exception error) => new { type = error.GetType().FullName, error.Message, error.StackTrace, hresult = error.HResult,
    cause = error.InnerException is null ? null : Failure(error.InnerException),
    errors = error is AggregateException group ? group.InnerExceptions.Select(Failure).ToArray() : null };
bool Alive(int pid) { try { using var process = Process.GetProcessById(pid); return !process.HasExited; } catch (ArgumentException) { return false; } }
object[] Files(string directory) => !Directory.Exists(directory) ? [] : Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories)
    .Order(StringComparer.Ordinal).Select(filename => {
        string? bytes = null; object? error = null;
        try { bytes = Convert.ToBase64String(File.ReadAllBytes(filename)); } catch (Exception failure) { error = Failure(failure); }
        return (object)new { path = Path.GetRelativePath(directory, filename).Replace(Path.DirectorySeparatorChar, '/'), bytes, error };
    }).ToArray();

var controls = new ConcurrentDictionary<string, Control>(); var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
var serializer = new MyXmlSerializer(); var configDirectory = Path.Combine(root, "config"); Directory.CreateDirectory(configDirectory);
serializer.SerializeToFile(new ServerConfiguration(), Path.Combine(configDirectory, "system.xml"));
var applicationPaths = new ServerApplicationPaths(root, Path.Combine(root, "log"), configDirectory, Path.Combine(root, "cache"), Path.Combine(root, "web"));
var manager = new ServerConfigurationManager(applicationPaths, NullLoggerFactory.Instance, serializer); manager.RegisterConfiguration<EncodingConfigurationFactory>();
builder.Services.AddSingleton<IServerConfigurationManager>(manager);
var app = builder.Build();
app.UseMiddleware<ExceptionMiddleware>();
app.MapGet("/public/{key}", async (HttpContext context, string key) => {
    await using var stream = await controls[key].Public!(); context.Response.ContentType = "application/x-subrip";
    await stream.CopyToAsync(context.Response.Body, context.RequestAborted);
});
app.MapPost("/trace/{key}", async (HttpContext context, string key) => {
    var value = await JsonSerializer.DeserializeAsync<JsonElement>(context.Request.Body);
    controls[key].Trace.TrySetResult(value.Clone()); context.Response.StatusCode = 204;
});
app.MapMethods("/media/{key}", ["GET", "HEAD"], async (HttpContext context, string key) => {
    var control = controls[key]; var bytes = control.Bytes; long start = 0, end = bytes.Length - 1;
    var range = context.Request.Headers.Range.ToString();
    if (range.StartsWith("bytes=", StringComparison.Ordinal)) {
        var segments = range[6..].Split('-'); start = long.Parse(segments[0]);
        if (segments[1].Length > 0) end = Math.Min(end, long.Parse(segments[1]));
        if (start > end) { context.Response.StatusCode = 416; return; }
        context.Response.StatusCode = 206; context.Response.Headers.ContentRange = $"bytes {start}-{end}/{bytes.Length}";
    }
    context.Response.ContentLength = end - start + 1; context.Response.Headers.AcceptRanges = "bytes";
    if (context.Request.Method == "HEAD") return;
    control.Read.TrySetResult();
    try {
        if (control.Hold) await control.Body.Task.WaitAsync(context.RequestAborted);
        await context.Response.Body.WriteAsync(bytes.AsMemory((int)start, (int)(end - start + 1)), context.RequestAborted);
    } catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
});
await app.StartAsync(); var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, applicationPaths, []);
using var capability = new MediaEncoder(NullLogger<MediaEncoder>.Instance, manager, fileSystem,
    Stub.Make<IBlurayExaminer>((method, _) => throw new InvalidOperationException("Unexpected disc operation: " + method.Name)),
    Stub.Make<ILocalizationManager>((method, _) => throw new InvalidOperationException("Unexpected localization operation: " + method.Name)),
    new ConfigurationBuilder().Build(), manager);
var profiles = new List<object>(); var extractions = new List<object>();
try {
    foreach (var sample in input.GetProperty("profiles").EnumerateArray()) {
        manager.SaveConfiguration("encoding", new EncodingOptions { EnableSubtitleExtraction = sample.GetProperty("enabled").GetBoolean() });
        var source = sample.GetProperty("source").Deserialize<MediaSourceInfo>(JsonDefaults.Options)!;
        var stream = sample.GetProperty("stream").Deserialize<MediaStream>(JsonDefaults.Options)!;
        var requested = sample.GetProperty("profiles").Deserialize<SubtitleProfile[]>(JsonDefaults.Options)!;
        object? result = null, error = null;
        try { result = StreamBuilder.GetSubtitleProfile(source, stream, requested,
            Enum.Parse<PlayMethod>(sample.GetProperty("playMethod").GetString()!), capability,
            sample.GetProperty("container").GetString(), Enum.Parse<MediaStreamProtocol>(sample.GetProperty("protocol").GetString()!)); }
        catch (Exception failure) { error = Failure(failure); }
        profiles.Add(new { name = sample.GetProperty("name").GetString(), capability = capability.CanExtractSubtitles(stream.Codec), result, error });
    }
    var original = Convert.FromBase64String(input.GetProperty("source").GetProperty("media").GetString()!);
    foreach (var entry in input.GetProperty("timeout").EnumerateArray().Select((sample, index) => (sample, index))) {
        foreach (var boundary in new[] { "helper", "public" }) {
            var sample = entry.sample; var key = entry.index + "-" + boundary; var stateRoot = Path.Combine(root, key); Directory.CreateDirectory(stateRoot);
            var sourceFile = Path.Combine(stateRoot, "original.mkv"); File.WriteAllBytes(sourceFile, original);
            var control = new Control(original, sample.TryGetProperty("holdBody", out var held) && held.GetBoolean()); controls[key] = control;
            Environment.SetEnvironmentVariable("MEDIAMANAGER_SUBTITLE_REAL_FFMPEG", ffmpeg);
            Environment.SetEnvironmentVariable("MEDIAMANAGER_SUBTITLE_TRACE_URL", address + "/trace/" + key);
            var launcher = Path.Combine(AppContext.BaseDirectory, OperatingSystem.IsWindows() ? "Oracle.exe" : "Oracle");
            if (sample.TryGetProperty("executableMissing", out var missing) && missing.GetBoolean()) launcher = Path.Combine(stateRoot, "missing-ffmpeg-executable");
            var enabled = !sample.TryGetProperty("enabled", out var enableValue) || enableValue.GetBoolean();
            manager.SaveConfiguration("encoding", new EncodingOptions { EnableSubtitleExtraction = enabled,
                SubtitleExtractionTimeoutMinutes = sample.GetProperty("minutes").GetInt32() });
            var events = new List<object>(); var changed = false;
            var logger = new EvidenceLogger<SubtitleEncoder>(events, () => {
                if (!changed && sample.TryGetProperty("nextMinutes", out var next)) {
                    changed = true; manager.SaveConfiguration("encoding", new EncodingOptions { EnableSubtitleExtraction = enabled, SubtitleExtractionTimeoutMinutes = next.GetInt32() });
                }
            });
            var source = input.GetProperty("source").GetProperty("source").Deserialize<MediaSourceInfo>(JsonDefaults.Options)!;
            source.Id = Guid.Parse("F83A0000-0000-0000-0000-" + (entry.index * 2 + (boundary == "public" ? 2 : 1)).ToString("D12")).ToString("N");
            source.Path = address + "/media/" + key; source.Protocol = MediaProtocol.Http;
            var subtitle = source.MediaStreams.First(stream => stream.Type == MediaStreamType.Subtitle);
            var encoder = Stub.Make<IMediaEncoder>((method, arguments) => method.Name switch {
                "get_EncoderPath" => launcher,
                "GetInputPathArgument" => capability.GetInputPathArgument((string)arguments![0]!, (MediaSourceInfo)arguments[1]!),
                "CanExtractSubtitles" => capability.CanExtractSubtitles((string)arguments![0]!),
                _ => throw new InvalidOperationException("Unexpected media executor dependency: " + method.Name)
            });
            var sources = Stub.Make<IMediaSourceManager>((method, _) => method.Name switch {
                "GetPlaybackMediaSources" => Task.FromResult<IReadOnlyList<MediaSourceInfo>>([source]),
                "GetPathProtocol" => MediaProtocol.Http,
                _ => throw new InvalidOperationException("Unexpected media source dependency: " + method.Name)
            });
            var paths = new PathManager(NullLogger<PathManager>.Instance, manager, applicationPaths);
            using var subtitles = new SubtitleEncoder(logger, fileSystem, encoder,
                Stub.Make<IHttpClientFactory>((method, _) => new HttpClient()), sources,
                new SubtitleEditParser(NullLogger<SubtitleEditParser>.Instance), paths, manager);
            using var cancellation = new CancellationTokenSource(); object? result = null, error = null, wire = null;
            var outputFile = Path.Combine(stateRoot, "copied.srt");
            async Task Run() {
                if (boundary == "helper") {
                    var arguments = "-y -i " + capability.GetInputPathArgument(source.Path, source)
                        + $" -map 0:{subtitle.Index} -an -vn -c:s copy -f srt \"{outputFile}\"";
                    var method = typeof(SubtitleEncoder).GetMethod("RunSubtitleExtractionProcess", BindingFlags.NonPublic | BindingFlags.Instance)!;
                    var operation = (Task<(int ExitCode, string StandardError)>)method.Invoke(subtitles, [arguments, cancellation.Token])!;
                    var value = await operation; result = new { value.ExitCode, value.StandardError };
                } else {
                    control.Public = async () => {
                        try { return await ((ISubtitleEncoder)subtitles).GetSubtitles(new Movie { Id = Guid.Parse(source.Id), Path = sourceFile },
                            source.Id, subtitle.Index, "srt", 0, 0, true, cancellation.Token); }
                        catch (Exception failure) { error = Failure(failure); throw; }
                    };
                    using var client = new HttpClient(); using var response = await client.GetAsync(address + "/public/" + key);
                    var bytes = await response.Content.ReadAsByteArrayAsync(); wire = new { status = (int)response.StatusCode,
                        contentType = response.Content.Headers.ContentType?.ToString(), bytes = Convert.ToBase64String(bytes), text = Encoding.UTF8.GetString(bytes),
                        headers = response.Headers.Concat(response.Content.Headers).ToDictionary(pair => pair.Key, pair => pair.Value.ToArray()) };
                    if (response.IsSuccessStatusCode) result = new { bytes = Convert.ToBase64String(bytes) };
                }
            }
            var operation = Run();
            if (sample.TryGetProperty("cancelAfterRead", out var cancel) && cancel.GetBoolean()) {
                await Task.WhenAny(control.Read.Task, operation);
                if (control.Read.Task.IsCompleted) cancellation.Cancel();
            }
            try { await operation; } catch (Exception failure) { error = Failure(failure is TargetInvocationException { InnerException: not null } invocation ? invocation.InnerException : failure); }
            var beforeCleanup = Files(applicationPaths.DataPath);
            JsonElement? trace = null; var processes = new List<object>();
            var effectiveMinutes = manager.GetEncodingOptions().SubtitleExtractionTimeoutMinutes;
            if (!sample.TryGetProperty("executableMissing", out _) && (effectiveMinutes < 0 || effectiveMinutes > 71582)) await control.Trace.Task;
            if (control.Trace.Task.IsCompletedSuccessfully) {
                trace = await control.Trace.Task;
                foreach (var pid in new[] { trace.Value.GetProperty("wrapperPid").GetInt32(), trace.Value.GetProperty("childPid").GetInt32() }) {
                    var active = Alive(pid); object? cleanupError = null;
                    try { if (active) { using var process = Process.GetProcessById(pid); process.Kill(true); await process.WaitForExitAsync(); } }
                    catch (ArgumentException) { } catch (Exception failure) { cleanupError = Failure(failure); }
                    processes.Add(new { pid, activeBeforeFixtureCleanup = active, activeAfterFixtureCleanup = Alive(pid), error = cleanupError });
                }
            }
            control.Body.TrySetResult();
            extractions.Add(new { name = sample.GetProperty("name").GetString(), boundary, root = stateRoot, result, error, wire,
                current = manager.GetEncodingOptions(), cancellationRequested = cancellation.IsCancellationRequested, events, trace, processes,
                outputBytes = File.Exists(outputFile) ? Convert.ToBase64String(File.ReadAllBytes(outputFile)) : null,
                beforeFixtureCleanup = beforeCleanup, afterFixtureCleanup = Files(applicationPaths.DataPath),
                sourceBefore = Convert.ToBase64String(original), sourceAfter = Convert.ToBase64String(File.ReadAllBytes(sourceFile)) });
        }
    }
} finally {
    foreach (var control in controls.Values) control.Body.TrySetResult();
    try { await app.StopAsync(); } finally { await app.DisposeAsync(); }
}
var assemblies = new[] { typeof(SubtitleEncoder).Assembly, typeof(MediaEncoder).Assembly, typeof(StreamBuilder).Assembly, typeof(ServerConfigurationManager).Assembly, typeof(JsonDefaults).Assembly, typeof(ExceptionMiddleware).Assembly }
    .Distinct().Select(assembly => new { name = assembly.GetName().Name, filename = assembly.Location,
        sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(output, JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), actualNamedManager = true,
    actualMediaEncoderCapability = true, actualStreamBuilder = true, actualSubtitleEncoder = true, actualCopyExecutor = true,
    actualExceptionMiddleware = true, productionControllerExecuted = false, helperAndPublicBoundariesSeparate = true, hostStopped = true, hostDisposed = true,
    ffmpeg = new { filename = ffmpeg, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(ffmpeg))) },
    fixtureLauncher = new { filename = Path.Combine(AppContext.BaseDirectory, OperatingSystem.IsWindows() ? "Oracle.exe" : "Oracle"),
        sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, OperatingSystem.IsWindows() ? "Oracle.exe" : "Oracle")))) },
    assemblies, profiles, extractions }, options));

public sealed class Control(byte[] bytes, bool hold) {
    public byte[] Bytes = bytes; public bool Hold = hold; public TaskCompletionSource Body = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Read = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource<JsonElement> Trace = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public Func<Task<Stream>>? Public;
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? arguments) => Handler(method!, arguments);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
}
public sealed class EvidenceLogger<T>(List<object> events, Action beforeStart) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null; public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
        events.Add(new { level = level.ToString(), message = formatter(state, error), error = error is null ? null : Capture(error) });
        if (state is IEnumerable<KeyValuePair<string, object?>> fields && fields.Any(field => field.Key == "{OriginalFormat}" && field.Value?.ToString() == "{File} {Arguments}")) beforeStart();
    }
    private static object Capture(Exception error) => new { type = error.GetType().FullName, error.Message, error.StackTrace,
        cause = error.InnerException is null ? null : Capture(error.InnerException),
        errors = error is AggregateException group ? group.InnerExceptions.Select(Capture).ToArray() : null };
}
