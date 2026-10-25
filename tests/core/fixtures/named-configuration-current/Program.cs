using System.Reflection;
using System.Diagnostics;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
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
using MediaBrowser.MediaEncoding.Configuration;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Serialization;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

var consume = args[0] == "consume";
var inputBytes = File.ReadAllBytes(args[consume ? 1 : 0]);
using var document = JsonDocument.Parse(inputBytes);
var input = document.RootElement;
var outputFile = args[consume ? 2 : 1];
var outputRoot = Path.Combine(Path.GetDirectoryName(outputFile)!, "states"); Directory.CreateDirectory(outputRoot);
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals | JsonNumberHandling.AllowReadingFromString, WriteIndented = true };
object Failure(Exception error) => new { type = error.GetType().FullName, error.Message, error.StackTrace, hresult = error.HResult,
    error.Source, data = error.Data.Cast<System.Collections.DictionaryEntry>().ToDictionary(entry => entry.Key.ToString()!, entry => entry.Value?.ToString()),
    cause = error.InnerException is null ? null : Failure(error.InnerException),
    errors = error is AggregateException group ? group.InnerExceptions.Select(Failure).ToArray() : null };
var serializer = new MyXmlSerializer();
object Disk(string filename, Type type) {
    byte[]? bytes = null; object? value = null, error = null;
    try { if (File.Exists(filename)) bytes = File.ReadAllBytes(filename); }
    catch (Exception failure) { error = Failure(failure); }
    if (bytes is not null) try { value = serializer.DeserializeFromBytes(type, bytes); } catch (Exception failure) { error = Failure(failure); }
    return new { bytes = bytes is null ? null : Convert.ToBase64String(bytes), directory = Directory.Exists(filename),
        accepted = bytes is null ? (bool?)null : error is null, value, error };
}
JsonNode? Expand(JsonElement value, string root) => value.ValueKind switch {
    JsonValueKind.Object => new JsonObject(value.EnumerateObject().Select(property => KeyValuePair.Create(property.Name, Expand(property.Value, root)))),
    JsonValueKind.Array => new JsonArray(value.EnumerateArray().Select(entry => Expand(entry, root)).ToArray()),
    JsonValueKind.String when value.GetString()!.StartsWith("@/", StringComparison.Ordinal)
        => JsonValue.Create(Path.Combine(root, value.GetString()![2..].Replace('/', Path.DirectorySeparatorChar))),
    _ => JsonNode.Parse(value.GetRawText())
};
void Apply(object target, JsonElement values, string root) {
    foreach (var property in values.EnumerateObject()) {
        var field = target.GetType().GetProperty(property.Name) ?? throw new InvalidOperationException("Unknown public field: " + property.Name);
        field.SetValue(target, JsonSerializer.Deserialize(Expand(property.Value, root)?.ToJsonString() ?? "null", field.PropertyType, JsonDefaults.Options));
    }
}
Fixture Create(string name) {
    var root = Path.Combine(outputRoot, name); Directory.CreateDirectory(root);
    var directory = Path.Combine(root, "config"); Directory.CreateDirectory(directory); Directory.CreateDirectory(Path.Combine(root, "transcodes"));
    serializer.SerializeToFile(new ServerConfiguration { IsStartupWizardCompleted = true }, Path.Combine(directory, "system.xml"));
    var log = new List<object>(); var logger = new EvidenceLoggerProvider(log); var loggerFactory = LoggerFactory.Create(builder => builder.AddProvider(logger));
    var controlled = new ControlledSerializer();
    var paths = new ServerApplicationPaths(root, Path.Combine(root, "log"), directory, Path.Combine(root, "cache"), Path.Combine(root, "web"));
    var manager = new ServerConfigurationManager(paths, loggerFactory, controlled);
    manager.RegisterConfiguration<EncodingConfigurationFactory>(); manager.RegisterConfiguration<MetadataConfigurationStore>();
    log.Clear(); return new Fixture(root, directory, manager, controlled, log, loggerFactory);
}

object Observe(JsonElement sample, int index) {
    using var fixture = Create("core-" + index);
    var root = fixture.Root; var manager = fixture.Manager; var key = sample.GetProperty("key").GetString()!;
    var type = manager.GetConfigurationType(key); var filename = Path.Combine(fixture.Directory, key.ToLowerInvariant() + ".xml");
    string? linkedFilename = null; object? linkPreparation = null;
    if (sample.TryGetProperty("directoryLink", out var directoryLink) && directoryLink.GetBoolean()) {
        var target = Path.Combine(root, "config-target"); Directory.Move(fixture.Directory, target);
        if (OperatingSystem.IsWindows()) {
            var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe")) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            foreach (var argument in new[] { "/d", "/c", "mklink", "/J", fixture.Directory, target }) start.ArgumentList.Add(argument);
            using var process = Process.Start(start) ?? throw new IOException("Could not create the fixture directory junction.");
            var stdout = process.StandardOutput.ReadToEnd(); var stderr = process.StandardError.ReadToEnd(); process.WaitForExit();
            linkPreparation = new { process.ExitCode, stdout, stderr };
            if (process.ExitCode != 0) throw new IOException("Fixture directory junction creation failed: " + stderr + stdout);
        } else Directory.CreateSymbolicLink(fixture.Directory, target);
        linkedFilename = Path.Combine(target, key.ToLowerInvariant() + ".xml");
    }
    if (sample.TryGetProperty("xml", out var initial)) File.WriteAllText(filename, initial.GetString());
    var warm = new HashSet<string>(StringComparer.Ordinal); var retained = new Dictionary<string, object>(StringComparer.Ordinal);
    var events = new List<JsonElement>(); var steps = new List<JsonElement>(); string? observer = null;
    JsonElement Snapshot() => JsonSerializer.SerializeToElement(new {
        current = warm.ToDictionary(name => name, name => manager.GetConfiguration(name)), retained,
        disk = Disk(filename, type), linkedDisk = linkedFilename is null ? null : Disk(linkedFilename, type), files = System.IO.Directory.EnumerateFileSystemEntries(fixture.Directory)
            .Select(Path.GetFileName).Where(name => name is "encoding.xml" or "metadata.xml").Order(StringComparer.Ordinal).ToArray()
    }, options);
    manager.NamedConfigurationUpdating += (_, incoming) => {
        events.Add(JsonSerializer.SerializeToElement(new { phase = "updating", key = incoming.Key, configuration = incoming.NewConfiguration, state = Snapshot() }, options));
        if (observer == "mutate-path") ((EncodingOptions)incoming.NewConfiguration).TranscodingTempPath = Path.Combine(root, "missing-after-updating");
        if (observer == "updating") throw new InvalidOperationException("Controlled named updating failure.");
    };
    manager.NamedConfigurationUpdated += (_, incoming) => {
        events.Add(JsonSerializer.SerializeToElement(new { phase = "updated", key = incoming.Key, configuration = incoming.NewConfiguration, state = Snapshot() }, options));
        if (observer == "updated") throw new InvalidOperationException("Controlled named updated failure.");
    };
    var before = Snapshot();
    foreach (var step in sample.GetProperty("steps").EnumerateArray()) {
        object? result = null, error = null;
        try {
            var action = step.GetProperty("action").GetString();
            var stepKey = step.TryGetProperty("key", out var specifiedKey) ? specifiedKey.GetString()! : key;
            switch (action) {
                case "get":
                    result = manager.GetConfiguration(stepKey); warm.Add(stepKey);
                    if (step.TryGetProperty("retain", out var retainedGet)) retained[retainedGet.GetString()!] = result;
                    break;
                case "save": {
                    var incoming = Activator.CreateInstance(manager.GetConfigurationType(stepKey))!;
                    Apply(incoming, step.GetProperty("values"), root);
                    if (step.TryGetProperty("retain", out var retainedSave)) retained[retainedSave.GetString()!] = incoming;
                    manager.SaveConfiguration(stepKey, incoming); break;
                }
                case "saveRetained": manager.SaveConfiguration(stepKey, retained[step.GetProperty("retain").GetString()!]); break;
                case "mutate": Apply(retained[step.GetProperty("retain").GetString()!], step.GetProperty("values"), root); break;
                case "xml": File.WriteAllText(filename, step.GetProperty("value").GetString()); break;
                case "observer": observer = step.GetProperty("phase").GetString(); break;
                case "readMode": fixture.Serializer.Mode = step.GetProperty("mode").GetString(); fixture.Serializer.Target = filename; break;
                case "physical":
                    switch (step.GetProperty("mode").GetString()) {
                        case "readonly": File.SetAttributes(filename, FileAttributes.ReadOnly); break;
                        case "writable": File.SetAttributes(filename, FileAttributes.Normal); break;
                        case "target-directory": File.Delete(filename); System.IO.Directory.CreateDirectory(filename); break;
                    }
                    break;
                default: throw new InvalidOperationException("Unknown named fixture operation: " + action);
            }
        } catch (Exception failure) { error = Failure(failure); }
        steps.Add(JsonSerializer.SerializeToElement(new { step, accepted = error is null, result, error, state = Snapshot(), diagnostics = fixture.Log.ToArray() }, options));
    }
    if (File.Exists(filename)) File.SetAttributes(filename, FileAttributes.Normal);
    return new { name = sample.GetProperty("name").GetString(), key, root, linkedFilename, linkPreparation, before, steps, events, after = Snapshot(), diagnostics = fixture.Log.ToArray() };
}

object ObservePaths(JsonElement sample, int index) {
    using var fixture = Create("paths-" + index); var root = fixture.Root; var manager = fixture.Manager;
    foreach (var relative in sample.GetProperty("directories").EnumerateArray()) Directory.CreateDirectory(Path.Combine(root, relative.GetString()!));
    _ = manager.GetConfiguration("encoding"); _ = manager.GetConfiguration("metadata");
    object[] Tree() {
        var filenames = new List<string>();
        foreach (var relative in new[] { "cache/transcodes", "a", "b", "foreign" }) {
            var filename = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            if (!Directory.Exists(filename) && !File.Exists(filename)) continue;
            filenames.Add(filename);
            if (Directory.Exists(filename)) filenames.AddRange(Directory.EnumerateFileSystemEntries(filename, "*", SearchOption.AllDirectories));
        }
        return filenames.Select(filename => new { path = Path.GetRelativePath(root, filename).Replace(Path.DirectorySeparatorChar, '/'),
            directory = Directory.Exists(filename), bytes = Directory.Exists(filename) ? null : Convert.ToBase64String(File.ReadAllBytes(filename)) })
            .OrderBy(entry => entry.path, StringComparer.Ordinal).Cast<object>().ToArray();
    }
    JsonElement Snapshot() => JsonSerializer.SerializeToElement(new { encoding = manager.GetConfiguration("encoding"), metadata = manager.GetConfiguration("metadata"),
        cachePath = manager.CommonApplicationPaths.CachePath, tree = Tree() }, options);
    var before = Snapshot(); var steps = new List<JsonElement>();
    foreach (var step in sample.GetProperty("steps").EnumerateArray()) {
        string? result = null; object? error = null;
        try {
            switch (step.GetProperty("action").GetString()) {
                case "get": result = manager.GetTranscodePath(); break;
                case "save": {
                    var key = step.GetProperty("key").GetString()!; var incoming = Activator.CreateInstance(manager.GetConfigurationType(key))!;
                    Apply(incoming, step.GetProperty("values"), root); manager.SaveConfiguration(key, incoming); break;
                }
                case "write": File.WriteAllText(Expand(step.GetProperty("filename"), root)!.GetValue<string>(), step.GetProperty("value").GetString()); break;
                default: throw new InvalidOperationException("Unknown path fixture operation.");
            }
        } catch (Exception failure) { error = Failure(failure); }
        steps.Add(JsonSerializer.SerializeToElement(new { step, accepted = error is null, result, error, state = Snapshot() }, options));
    }
    return new { name = sample.GetProperty("name").GetString(), root, before, steps, after = Snapshot(), diagnostics = fixture.Log.ToArray() };
}

object[] core = Array.Empty<object>(), http = Array.Empty<object>(), consumed = Array.Empty<object>(), pathResults = Array.Empty<object>();
if (consume) {
    consumed = input.EnumerateArray().Select(sample => (object)new { name = sample.GetProperty("name").GetString(),
        root = sample.GetProperty("root").GetString(), disk = Disk(sample.GetProperty("filename").GetString()!,
            sample.GetProperty("root").GetString() == "encoding" ? typeof(EncodingOptions) : typeof(MetadataConfiguration)) }).ToArray();
} else {
    core = input.GetProperty("core").EnumerateArray().Select((sample, index) => Observe(sample, index)).ToArray();
    pathResults = input.GetProperty("paths").EnumerateArray().Select((sample, index) => ObservePaths(sample, index)).ToArray();
    using var initial = Create("http-initial"); Fixture current = initial;
    var diagnostics = new List<object>(); var observations = new List<object>();
    var user = new User("named-fixture", "controlled", "controlled") { Id = Guid.Parse("f82b0000-0000-0000-0000-000000000001") };
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
    builder.Logging.ClearProviders(); builder.Logging.AddProvider(new EvidenceLoggerProvider(diagnostics)); builder.WebHost.UseUrls("http://127.0.0.1:0");
    builder.Services.AddSingleton<IServerConfigurationManager>(initial.Manager);
    builder.Services.AddSingleton(Stub.Make<IUserManager>((method, _) => method.Name == "GetUserById" ? user : Stub.Default(method.ReturnType)));
    builder.Services.AddSingleton(Stub.Make<INetworkManager>((method, _) => method.Name == "IsInLocalNetwork" ? true : Stub.Default(method.ReturnType)));
    builder.Services.AddHttpContextAccessor(); builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
    builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
    builder.Services.AddAuthorization(value => {
        value.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement()).Build();
        value.AddPolicy(Policies.RequiresElevation, policy => policy.AddAuthenticationSchemes("fixture").RequireClaim(ClaimTypes.Role, UserRoles.Administrator));
    });
    builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlyConfigurationController()));
    builder.Services.Replace(ServiceDescriptor.Transient<ConfigurationController>(_ => new ConfigurationController(current.Manager,
        Stub.Make<IMediaEncoder>((method, _) => throw new InvalidOperationException("Unexpected media executor call: " + method.Name)))));
    var app = builder.Build(); using var client = new HttpClient();
    try {
        app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        foreach (var entry in input.GetProperty("http").EnumerateArray().Select((sample, index) => (sample, index))) {
            var sample = entry.sample; using var fixture = Create("http-" + entry.index); current = fixture; diagnostics.Clear();
            var key = sample.GetProperty("key").GetString()!;
            var filename = Path.Combine(fixture.Directory, key.ToLowerInvariant() + ".xml");
            if (sample.TryGetProperty("xml", out var initialXml)) File.WriteAllText(filename, initialXml.GetString());
            if (sample.TryGetProperty("readMode", out var readMode)) { fixture.Serializer.Mode = readMode.GetString(); fixture.Serializer.Target = filename; }
            if (sample.TryGetProperty("physical", out var physical)) {
                if (physical.GetString() == "readonly") File.SetAttributes(filename, FileAttributes.ReadOnly);
                else if (physical.GetString() == "target-directory") { File.Delete(filename); Directory.CreateDirectory(filename); }
            }
            var events = new List<JsonElement>();
            current.Manager.NamedConfigurationUpdating += (_, incoming) => {
                events.Add(JsonSerializer.SerializeToElement(new { phase = "updating", key = incoming.Key, configuration = incoming.NewConfiguration }, options));
                if (sample.TryGetProperty("observer", out var observer) && observer.GetString() == "updating") throw new InvalidOperationException("Controlled named updating failure.");
            };
            current.Manager.NamedConfigurationUpdated += (_, incoming) => {
                events.Add(JsonSerializer.SerializeToElement(new { phase = "updated", key = incoming.Key, configuration = incoming.NewConfiguration }, options));
                if (sample.TryGetProperty("observer", out var observer) && observer.GetString() == "updated") throw new InvalidOperationException("Controlled named updated failure.");
            };
            async Task<object> Request(string method, string? body) {
                using var request = new HttpRequestMessage(new HttpMethod(method), address + "/System/Configuration/" + key);
                request.Headers.TryAddWithoutValidation("X-Identity", sample.TryGetProperty("identity", out var identity) ? identity.GetString() : "admin");
                request.Headers.TryAddWithoutValidation("Accept", "application/json");
                if (body is not null) {
                    body = body.Replace("@/", fixture.Root.Replace('\\', '/') + "/", StringComparison.Ordinal);
                    request.Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body));
                    request.Content.Headers.TryAddWithoutValidation("Content-Type", sample.TryGetProperty("contentType", out var contentType) ? contentType.GetString() : "application/json");
                }
                HttpResponseMessage? response = null; var text = ""; JsonElement? value = null; object? error = null;
                try {
                    response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
                    text = await response.Content.ReadAsStringAsync();
                    try { value = JsonSerializer.Deserialize<JsonElement>(text); } catch (JsonException) { }
                } catch (Exception failure) { error = Failure(failure); }
                using (response) return new { status = response is null ? (int?)null : (int)response.StatusCode,
                    contentType = response?.Content.Headers.ContentType?.ToString(), text, json = value, error,
                    headers = response?.Headers.Concat(response.Content.Headers).ToDictionary(pair => pair.Key, pair => pair.Value.ToArray()) };
            }
            var response = await Request(sample.GetProperty("method").GetString()!, sample.TryGetProperty("body", out var rawBody) ? rawBody.GetString() : null);
            var afterRead = await Request("GET", null);
            object? live = null;
            if (key is "encoding" or "metadata") live = current.Manager.GetConfiguration(key);
            observations.Add(new { name = sample.GetProperty("name").GetString(), root = fixture.Root, response, afterRead, live, events,
                disk = key is "encoding" or "metadata" ? Disk(Path.Combine(fixture.Directory, key + ".xml"), key == "encoding" ? typeof(EncodingOptions) : typeof(MetadataConfiguration)) : null,
                diagnostics = diagnostics.Concat(fixture.Log).ToArray() });
            if (File.Exists(filename)) File.SetAttributes(filename, FileAttributes.Normal);
        }
    } finally { try { await app.StopAsync(); } finally { await app.DisposeAsync(); } }
    http = observations.ToArray();
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location))
    .Select(value => new { name = value.GetName().Name, filename = value.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(value.Location))) }).OrderBy(value => value.name).ToArray();
File.WriteAllText(outputFile, JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    actualManager = !consume, actualFactories = !consume, actualSerializer = true, actualMvc = !consume, actualController = !consume,
    actualAuthorization = !consume, actualExceptionMiddleware = !consume, actualGetTranscodePath = !consume, actualColdRead = consume, hostStopped = !consume, hostDisposed = !consume,
    assemblies, core, http, consumed, paths = pathResults }, options) + "\n");

public sealed record Fixture(string Root, string Directory, ServerConfigurationManager Manager, ControlledSerializer Serializer,
    List<object> Log, ILoggerFactory LoggerFactory) : IDisposable { public void Dispose() => LoggerFactory.Dispose(); }
public sealed class ControlledSerializer : IXmlSerializer {
    private readonly MyXmlSerializer _inner = new(); public string? Mode; public string? Target;
    public object DeserializeFromFile(Type type, string filename) {
        if (filename == Target && Mode == "io") throw new IOException("Controlled named read failure.", new IOException("Original storage failure."));
        if (filename == Target && Mode == "race-delete") File.Delete(filename);
        return _inner.DeserializeFromFile(type, filename)!;
    }
    public object DeserializeFromStream(Type type, Stream stream) => _inner.DeserializeFromStream(type, stream)!;
    public object DeserializeFromBytes(Type type, byte[] bytes) => _inner.DeserializeFromBytes(type, bytes)!;
    public void SerializeToStream(object value, Stream stream) => _inner.SerializeToStream(value, stream);
    public void SerializeToFile(object value, string filename) => _inner.SerializeToFile(value, filename);
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Handler(method!, args);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class OnlyConfigurationController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var controller in feature.Controllers.Where(value => value.AsType() != typeof(ConfigurationController)).ToArray()) feature.Controllers.Remove(controller);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = Request.Headers["X-Identity"].ToString();
        if (identity is "anonymous" or "invalid") return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, (identity == "apiKey").ToString()),
            new(InternalClaimTypes.UserId, "f82b0000000000000000000000000001") };
        if (identity != "regular") claims.Add(new Claim(ClaimTypes.Role, UserRoles.Administrator));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name)), Scheme.Name)));
    }
}
public class EvidenceLoggerProvider(List<object> entries) : ILoggerProvider {
    public ILogger CreateLogger(string category) => new EvidenceLogger(entries, category); public void Dispose() { }
    public class EvidenceLogger(List<object> entries, string category) : ILogger {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null; public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
            if (error is not null) entries.Add(new { category, level = level.ToString(), formatted = formatter(state, error), error = Capture(error) });
        }
        private static object Capture(Exception error) => new { type = error.GetType().FullName, error.Message, error.StackTrace,
            hresult = error.HResult, error.Source, data = error.Data.Cast<System.Collections.DictionaryEntry>().ToDictionary(entry => entry.Key.ToString()!, entry => entry.Value?.ToString()),
            cause = error.InnerException is null ? null : Capture(error.InnerException),
            errors = error is AggregateException group ? group.InnerExceptions.Select(Capture).ToArray() : null };
    }
}
