using System.Collections.Concurrent;
using System.Globalization;
using System.IO.Pipelines;
using System.Net.Http.Json;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Extensions.Json;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.MediaEncoding.Configuration;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Net;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Localization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var root = Path.GetFullPath(args[1]);
JsonElement? browser = args.Length > 3 ? JsonDocument.Parse(File.ReadAllBytes(args[3])).RootElement.Clone() : null;
var fileInputs = Directory.EnumerateFiles(Path.Combine(root, "files"), "*", SearchOption.AllDirectories).Select(filename => {
    var info = new FileInfo(filename);
    return new { filename = info.FullName, size = info.Length, info.CreationTimeUtc, info.LastWriteTimeUtc,
        sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename))) };
}).ToArray();
var capture = new Capture(root); capture.Reset(input[0]);
var snapshots = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
var diagnostics = new ConcurrentQueue<object>();
var user = new User("fallback-fonts", "controlled", "controlled") { Id = Guid.Parse("f81b0000000000000000000000000001") };
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.Logging.AddProvider(new DiagnosticProvider(diagnostics));
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton<IServerConfigurationManager>(_ => capture.Configuration);
builder.Services.AddSingleton(Stub.Make<IUserManager>((method, _) => method.Name == "GetUserById" ? user : throw new InvalidOperationException(method.Name)));
builder.Services.AddSingleton(Stub.Make<INetworkManager>((method, _) => method.Name == "IsInLocalNetwork" ? true : throw new InvalidOperationException(method.Name)));
builder.Services.AddHttpContextAccessor(); builder.Services.AddHttpClient();
builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(options => {
    options.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement()).Build();
    options.AddPolicy(Policies.RequiresElevation, policy => policy.AddAuthenticationSchemes("fixture").RequireClaim(ClaimTypes.Role, UserRoles.Administrator));
});
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlySubtitleController()));
builder.Services.Configure<MvcOptions>(options => options.Filters.Add(new PhysicalFileFailureFilter(capture)));
builder.Services.Replace(ServiceDescriptor.Transient<SubtitleController>(services => new SubtitleController(capture.Configuration,
    Stub.Make<ILibraryManager>(), Stub.Make<ISubtitleManager>(), Stub.Make<ISubtitleEncoder>(), Stub.Make<IMediaSourceManager>(),
    Stub.Make<IProviderManager>(), capture.FileSystem, services.GetRequiredService<IHttpClientFactory>(), services.GetRequiredService<ILogger<SubtitleController>>())));
var app = builder.Build(); var observations = new List<object>(); using var client = new HttpClient();
TaskCompletionSource? requestFinished = null;
try {
    if (browser is JsonElement browserConfiguration) {
        var assetRoot = Path.GetFullPath(browserConfiguration.GetProperty("assetRoot").GetString()!);
        if (!assetRoot.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)) throw new InvalidOperationException("Browser assets must belong to this font capture.");
        var assets = browserConfiguration.GetProperty("assets").EnumerateArray().ToDictionary(value => value.GetProperty("filename").GetString()!, value => value.Clone());
        if (assets.Keys.Any(filename => filename != Path.GetFileName(filename))) throw new InvalidOperationException("Invalid browser font asset name.");
        app.Use(async (context, next) => {
            if (context.Request.Path.StartsWithSegments("/font-consumer", out var remaining) && assets.TryGetValue(remaining.Value!.TrimStart('/'), out var asset)) {
                var bytes = await File.ReadAllBytesAsync(Path.Combine(assetRoot, asset.GetProperty("filename").GetString()!));
                if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != asset.GetProperty("sha256").GetString()) throw new InvalidOperationException("Browser font asset changed.");
                context.Response.ContentType = asset.GetProperty("type").GetString(); context.Response.ContentLength = bytes.Length;
                await context.Response.Body.WriteAsync(bytes); return;
            }
            await next();
        });
    }
    app.Use(async (context, next) => { try { await next(); } finally {
        if (browser is null || context.Request.Path.StartsWithSegments("/FallbackFont/Fonts")) {
            capture.FinalResponse = Capture.ResponseValue(context.Response);
            requestFinished?.TrySetResult();
        }
    } });
    app.UseMiddleware<ExceptionMiddleware>();
    app.UseRequestLocalization(new RequestLocalizationOptions {
        DefaultRequestCulture = new RequestCulture("en-US"),
        SupportedCultures = new[] { "en-US", "sv-SE", "tr-TR" }.Select(CultureInfo.GetCultureInfo).ToArray(),
        SupportedUICultures = new[] { "en-US", "sv-SE", "tr-TR" }.Select(CultureInfo.GetCultureInfo).ToArray(),
    });
    app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
    var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
    foreach (var sample in input.EnumerateArray()) {
        capture.Reset(sample); var initial = JsonSerializer.SerializeToElement(capture.Current, snapshots);
        var steps = new List<object>();
        foreach (var step in sample.GetProperty("steps").EnumerateArray()) {
            capture.Before(step); var before = File.ReadAllBytes(capture.ConfigFile);
            requestFinished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var request = new HttpRequestMessage(new HttpMethod(step.GetProperty("method").GetString()!), address + step.GetProperty("path").GetString());
            request.Headers.TryAddWithoutValidation("Accept", Capture.Text(step, "accept") ?? "application/json");
            request.Headers.TryAddWithoutValidation("X-Identity", Capture.Text(step, "identity") ?? "admin");
            if (step.TryGetProperty("headers", out var headers)) foreach (var header in headers.EnumerateObject()) request.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString());
            if (step.TryGetProperty("browserMode", out var browserMode)) {
                if (browser is null) throw new InvalidOperationException("Browser font observation needs its owned control channel.");
                var callback = new Uri(browser.Value.GetProperty("control").GetString()!);
                if (!callback.IsLoopback || callback.Scheme != "http") throw new InvalidOperationException("Browser control must remain on loopback.");
                using var callbackDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(60));
                using var callbackResponse = await client.PostAsJsonAsync(callback, new { origin = address, step }, callbackDeadline.Token);
                var callbackBytes = await callbackResponse.Content.ReadAsByteArrayAsync(callbackDeadline.Token);
                callbackResponse.EnsureSuccessStatusCode();
                var observedBrowser = JsonSerializer.Deserialize<JsonElement>(callbackBytes);
                await requestFinished.Task.WaitAsync(TimeSpan.FromSeconds(30));
                steps.Add(new { name = Capture.Text(step, "name"), browser = observedBrowser,
                    executionFault = capture.ExecutionFault, finalResponse = capture.FinalResponse,
                    diskBeforeBase64 = Convert.ToBase64String(before), diskAfterBase64 = Convert.ToBase64String(File.ReadAllBytes(capture.ConfigFile)),
                    diagnostics = diagnostics.ToArray() });
                continue;
            }
            if (step.TryGetProperty("observeFailure", out var observeFailure) && observeFailure.GetBoolean()) {
                steps.Add(await capture.ObserveFailure(client, request, requestFinished.Task, step, before, diagnostics, snapshots));
                continue;
            }
            var cancelRead = step.TryGetProperty("cancelAfterFirstRead", out var cancel) && cancel.GetBoolean();
            using var cancellation = new CancellationTokenSource();
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation.Token);
            var status = (int)response.StatusCode; var mediaType = response.Content.Headers.ContentType?.MediaType;
            var rawHeaders = response.Headers.Concat(response.Content.Headers).ToDictionary(value => value.Key.ToLowerInvariant(), value => string.Join(", ", value.Value));
            byte[] body;
            if (cancelRead) {
                using var reader = await response.Content.ReadAsStreamAsync(cancellation.Token);
                body = new byte[1024]; await reader.ReadExactlyAsync(body, cancellation.Token);
                cancellation.Cancel(); response.Dispose();
            } else body = await response.Content.ReadAsByteArrayAsync();
            JsonElement? json = null;
            await requestFinished.Task.WaitAsync(TimeSpan.FromSeconds(30));
            if (mediaType == "application/json") json = JsonSerializer.Deserialize<JsonElement>(body);
            // Opening without sharing after completion exercises the actual PhysicalFile reader lifetime.
            // The check uses a real file operation and keeps complete error details if release fails.
            var release = new List<object>();
            if (!string.IsNullOrEmpty(capture.Current.FallbackFontPath) && Directory.Exists(capture.Current.FallbackFontPath)) {
                foreach (var file in capture.FileSystem.GetFiles(capture.Current.FallbackFontPath)) {
                    using var stream = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.None);
                    release.Add(new { file.Name, stream.Length });
                }
            }
            steps.Add(new { name = Capture.Text(step, "name"), status, headers = rawHeaders, partial = cancelRead,
                bodyBase64 = Convert.ToBase64String(body), json,
                current = JsonSerializer.SerializeToElement(capture.Current, snapshots), held = JsonSerializer.SerializeToElement(capture.Held, snapshots),
                disk = JsonSerializer.SerializeToElement(capture.Disk, snapshots), diskBeforeBase64 = Convert.ToBase64String(before),
                diskAfterBase64 = Convert.ToBase64String(File.ReadAllBytes(capture.ConfigFile)), diagnostics = diagnostics.ToArray(), release });
        }
        observations.Add(new { name = Capture.Text(sample, "name"), initial, steps });
    }
} finally { try { await app.StopAsync(); } finally { await app.DisposeAsync(); } }
var assemblies = new[] { typeof(SubtitleController).Assembly, typeof(ManagedFileSystem).Assembly, typeof(EncodingOptions).Assembly,
    typeof(EncodingConfigurationFactory).Assembly, typeof(EncodingConfigurationExtensions).Assembly, typeof(JsonDefaults).Assembly }.Distinct()
    .Select(value => new { filename = value.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(value.Location))) });
var frameworkAssemblies = new[] { typeof(Microsoft.AspNetCore.Mvc.PhysicalFileResult).Assembly,
    typeof(Microsoft.AspNetCore.Http.SendFileResponseExtensions).Assembly }.Distinct()
    .Select(value => new { filename = value.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(value.Location))) });
File.WriteAllText(args[2], JsonSerializer.Serialize(new {
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), actualMvc = true, actualSubtitleController = true,
    actualServerConfigurationManager = true, actualEncodingFactory = true, actualManagedFileSystem = true,
    actualPhysicalFileExecutor = true, actualDefaultAuthorization = true, actualExceptionMiddleware = true,
    hostStopped = true, hostDisposed = true, assemblies, frameworkAssemblies, fileInputs, observations, diagnostics = diagnostics.ToArray(),
}, snapshots));

public sealed class Capture(string root) {
    public ServerApplicationPaths Paths = null!;
    public ServerConfigurationManager Configuration = null!;
    public ManagedFileSystem FileSystem = null!;
    public EncodingOptions Held = null!;
    public string? ExecutionFaultMode;
    public object? ExecutionFault;
    public object? FinalResponse;
    public EncodingOptions Current => Configuration.GetEncodingOptions();
    public EncodingOptions Disk => (EncodingOptions)new MyXmlSerializer().DeserializeFromFile(typeof(EncodingOptions), ConfigFile);
    public string ConfigFile => Path.Combine(Paths.ConfigurationDirectoryPath, "encoding.xml");
    public static string? Text(JsonElement value, string key) => value.TryGetProperty(key, out var entry) ? entry.GetString() : null;
    private string? Resolve(string? value) => string.IsNullOrEmpty(value) ? value : Path.Combine(root, "files", value);
    private EncodingOptions Options(string? value) => new() { FallbackFontPath = Resolve(value), EnableFallbackFont = true, SubtitleExtractionTimeoutMinutes = 31 };
    public void Reset(JsonElement sample) {
        var directory = Path.Combine(root, "configuration", Text(sample, "name")!); Directory.CreateDirectory(directory);
        Paths = new ServerApplicationPaths(directory, Path.Combine(directory, "log"), Path.Combine(directory, "config"), Path.Combine(directory, "cache"), Path.Combine(directory, "web"));
        Directory.CreateDirectory(Paths.ConfigurationDirectoryPath);
        var serializer = new MyXmlSerializer(); serializer.SerializeToFile(Options(Text(sample, "root")), ConfigFile);
        Configuration = new ServerConfigurationManager(Paths, NullLoggerFactory.Instance, serializer);
        Configuration.Configuration.IsStartupWizardCompleted = true;
        Configuration.RegisterConfiguration<EncodingConfigurationFactory>(); Held = Current;
        FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, Paths, []);
    }
    public void Before(JsonElement step) {
        ExecutionFaultMode = Text(step, "executionFault"); ExecutionFault = null; FinalResponse = null;
        if (step.TryGetProperty("replaceRoot", out var replace)) Configuration.SaveConfiguration("encoding", Options(replace.GetString()));
        if (step.TryGetProperty("mutateHeldRoot", out var held)) Held.FallbackFontPath = Resolve(held.GetString());
        if (step.TryGetProperty("mutateCurrentRoot", out var current)) Current.FallbackFontPath = Resolve(current.GetString());
    }
    public static object ResponseValue(HttpResponse response) => new {
        hasStarted = response.HasStarted, status = response.StatusCode,
        headers = response.Headers.ToDictionary(value => value.Key.ToLowerInvariant(), value => value.Value.ToString()),
    };
    public static object? ErrorValue(Exception? error) => error is null ? null : new {
        type = error.GetType().FullName, error.Message, error.StackTrace,
        cause = ErrorValue(error.InnerException),
        errors = error is AggregateException group ? group.InnerExceptions.Select(ErrorValue).ToArray() : null,
    };
    public async Task MissingFile(string filename, HttpResponse response, string phase, Func<Task<Exception?>> operation) {
        var bytes = File.ReadAllBytes(filename); var before = ResponseValue(response);
        var backup = filename + "." + Guid.NewGuid().ToString("N") + ".held";
        File.Move(filename, backup);
        Exception? primary = null;
        try { primary = await operation(); }
        catch (Exception error) { primary = error; throw; }
        finally {
            var after = ResponseValue(response); Exception? cleanup = null; var restored = false;
            try { File.Move(backup, filename); restored = File.Exists(filename) && File.ReadAllBytes(filename).AsSpan().SequenceEqual(bytes); }
            catch (Exception error) { cleanup = error; }
            ExecutionFault = new { phase, filename, bytes = bytes.Length,
                sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), before, after,
                failure = ErrorValue(primary), cleanup = ErrorValue(cleanup), restored };
            if (cleanup is not null) throw primary is null ? cleanup : new AggregateException(primary, cleanup);
        }
    }
    public async Task<object> ObserveFailure(HttpClient client, HttpRequestMessage request, Task requestFinished, JsonElement step,
        byte[] before, ConcurrentQueue<object> diagnostics, JsonSerializerOptions snapshots) {
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var body = new MemoryStream();
        HttpResponseMessage? response = null; Exception? clientFailure = null;
        int? status = null; var headers = new Dictionary<string, string>(); var bodyComplete = false;
        try {
            response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation.Token);
            status = (int)response.StatusCode;
            headers = response.Headers.Concat(response.Content.Headers).ToDictionary(value => value.Key.ToLowerInvariant(), value => string.Join(", ", value.Value));
            await using var reader = await response.Content.ReadAsStreamAsync(cancellation.Token);
            var buffer = new byte[8192]; int count;
            while ((count = await reader.ReadAsync(buffer, cancellation.Token)) != 0) body.Write(buffer, 0, count);
            bodyComplete = true;
        } catch (Exception error) { clientFailure = error; }
        finally { response?.Dispose(); }
        await requestFinished.WaitAsync(TimeSpan.FromSeconds(30));
        return new { name = Text(step, "name"), status, headers, bodyBase64 = Convert.ToBase64String(body.ToArray()), bodyComplete,
            clientFailure = ErrorValue(clientFailure), executionFault = ExecutionFault, finalResponse = FinalResponse,
            current = JsonSerializer.SerializeToElement(Current, snapshots), held = JsonSerializer.SerializeToElement(Held, snapshots),
            disk = JsonSerializer.SerializeToElement(Disk, snapshots), diskBeforeBase64 = Convert.ToBase64String(before),
            diskAfterBase64 = Convert.ToBase64String(File.ReadAllBytes(ConfigFile)), diagnostics = diagnostics.ToArray() };
    }
}
public sealed class PhysicalFileFailureFilter(Capture capture) : IAsyncResultFilter {
    public async Task OnResultExecutionAsync(ResultExecutingContext context, ResultExecutionDelegate next) {
        var mode = capture.ExecutionFaultMode;
        if (mode is null || context.Result is not PhysicalFileResult file) { await next(); return; }
        if (mode == "delete-before-execution") {
            await capture.MissingFile(file.FileName, context.HttpContext.Response, mode, async () => (await next()).Exception);
            return;
        }
        if (mode != "delete-before-sendfile") throw new InvalidOperationException("Unknown controlled physical font fault.");
        var original = context.HttpContext.Features.Get<IHttpResponseBodyFeature>()!;
        context.HttpContext.Features.Set<IHttpResponseBodyFeature>(new MissingFileBodyFeature(original, capture, context.HttpContext.Response));
        try { await next(); }
        finally { context.HttpContext.Features.Set(original); }
    }
}
public sealed class MissingFileBodyFeature(IHttpResponseBodyFeature original, Capture capture, HttpResponse response) : IHttpResponseBodyFeature {
    public Stream Stream => original.Stream;
    public PipeWriter Writer => original.Writer;
    public void DisableBuffering() => original.DisableBuffering();
    public Task StartAsync(CancellationToken cancellationToken = default) => original.StartAsync(cancellationToken);
    public Task CompleteAsync() => original.CompleteAsync();
    public Task SendFileAsync(string path, long offset, long? count, CancellationToken cancellationToken = default) =>
        capture.MissingFile(path, response, "delete-before-sendfile", async () => {
            await original.SendFileAsync(path, offset, count, cancellationToken); return null;
        });
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?>? handler = null) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler ?? ((method, _) => throw new InvalidOperationException("Unexpected font fixture dependency: " + method.Name)); return value;
    }
}
public class OnlySubtitleController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var item in feature.Controllers.Where(value => value.AsType() != typeof(SubtitleController)).ToArray()) feature.Controllers.Remove(item);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = Request.Headers["X-Identity"].ToString(); if (identity == "anonymous") return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, (identity == "apiKey").ToString()), new(InternalClaimTypes.UserId, "f81b0000000000000000000000000001") };
        if (identity != "regular") claims.Add(new Claim(ClaimTypes.Role, UserRoles.Administrator));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name)), Scheme.Name)));
    }
}
public class DiagnosticProvider(ConcurrentQueue<object> entries) : ILoggerProvider {
    public ILogger CreateLogger(string category) => new DiagnosticLogger(entries, category); public void Dispose() { }
    public class DiagnosticLogger(ConcurrentQueue<object> entries, string category) : ILogger {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
            if (error is not null || level >= LogLevel.Error) entries.Enqueue(new { category, level = level.ToString(),
                message = formatter(state, error), error = error is null ? null : CaptureError(error) });
        }
        private static object CaptureError(Exception error) => new { type = error.GetType().FullName, error.Message, error.StackTrace,
            cause = error.InnerException is null ? null : CaptureError(error.InnerException), errors = error is AggregateException group ? group.InnerExceptions.Select(CaptureError).ToArray() : null };
    }
}
