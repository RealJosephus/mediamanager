using System.Collections.Concurrent;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Extensions.Json;
using Jellyfin.Networking.Manager;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Net;
using MediaBrowser.Common.Updates;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Updates;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using static MediaBrowser.Controller.Extensions.ConfigurationExtensions;

public static class HostCases {
    public static object Failure(Exception error) => new { type = error.GetType().FullName, error.Message, error.StackTrace, text = error.ToString(),
        hresult = error.HResult, error.Source, data = error.Data.Cast<System.Collections.DictionaryEntry>().ToDictionary(entry => entry.Key.ToString()!, entry => entry.Value?.ToString()),
        cause = error.InnerException is null ? null : Failure(error.InnerException),
        errors = error is AggregateException group ? group.InnerExceptions.Select(Failure).ToArray() : null };
    private static int AvailablePort() {
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        try { return ((IPEndPoint)listener.LocalEndpoint).Port; } finally { listener.Stop(); }
    }
    public static async Task<object> Run(JsonElement input, JsonElement prepared, JsonElement sample, string group, string root, JsonSerializerOptions options) {
        Directory.CreateDirectory(root); var directory = Path.Combine(root, "config"); Directory.CreateDirectory(directory);
        var serializer = new MyXmlSerializer(); var systemFile = Path.Combine(directory, "system.xml"); var networkFile = Path.Combine(directory, "network.xml");
        var phases = new List<object>(); var steps = new List<object>(); var probes = new List<object>(); var unboundProbes = new List<object>(); var cleanupErrors = new List<object>();
        var log = new ConcurrentQueue<object>(); var operationFailures = new ConcurrentQueue<object>(); var lifecycle = new List<object>();
        object? owner = new { phase = "prepare", name = sample.GetProperty("name").GetString() };
        using var loggerFactory = LoggerFactory.Create(value => value.AddProvider(new ListenerLogger(log, () => owner)));
        var httpPort = AvailablePort(); int httpsPort, nextPort;
        do { httpsPort = AvailablePort(); } while (httpsPort == httpPort);
        do { nextPort = AvailablePort(); } while (nextPort == httpPort || nextPort == httpsPort);
        var tokens = new Dictionary<string, object?> {
            ["$http"] = httpPort, ["$https"] = httpsPort, ["$nextHttp"] = nextPort,
            ["$a"] = prepared.GetProperty("a").GetProperty("file").GetProperty("filename").GetString(),
            ["$b"] = prepared.GetProperty("b").GetProperty("file").GetProperty("filename").GetString(),
            ["$certificateOnly"] = prepared.GetProperty("certificateOnly").GetProperty("file").GetProperty("filename").GetString(),
            ["$bad"] = prepared.GetProperty("bad").GetProperty("filename").GetString(), ["$missing"] = prepared.GetProperty("missing").GetString(),
            ["$password"] = prepared.GetProperty("password").GetString(),
        };
        JsonNode? Resolve(JsonElement value) => value.ValueKind switch {
            JsonValueKind.Object => new JsonObject(value.EnumerateObject().Select(field => KeyValuePair.Create(field.Name, Resolve(field.Value)))),
            JsonValueKind.Array => new JsonArray(value.EnumerateArray().Select(Resolve).ToArray()),
            JsonValueKind.String when tokens.TryGetValue(value.GetString()!, out var replacement) => JsonSerializer.SerializeToNode(replacement),
            _ => JsonNode.Parse(value.GetRawText()),
        };
        JsonElement Snapshot(object? value) => JsonSerializer.SerializeToElement(value, options);
        object Disk(string filename, Type type) {
            byte[]? bytes = null; object? value = null, error = null;
            try { if (File.Exists(filename)) bytes = File.ReadAllBytes(filename); if (bytes is not null) value = serializer.DeserializeFromBytes(type, bytes); }
            catch (Exception source) { error = Failure(source); }
            return new { filename, bytes = bytes is null ? null : Convert.ToBase64String(bytes), directory = Directory.Exists(filename), value, error };
        }
        var initial = JsonSerializer.Deserialize<NetworkConfiguration>(Resolve(sample.GetProperty("initial"))!.ToJsonString(), JsonDefaults.Options)!;
        serializer.SerializeToFile(new ServerConfiguration { IsStartupWizardCompleted = true, IsPortAuthorized = true, ServerName = "Listener fixture" }, systemFile);
        serializer.SerializeToFile(initial, networkFile);
        var paths = new ServerApplicationPaths(root, Path.Combine(root, "log"), directory, Path.Combine(root, "cache"), Path.Combine(root, "web"));
        var startup = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { [DetectNetworkChangeKey] = "false", [DefaultRedirectKey] = "web/" }).Build();
        using var releaseStartup = (IDisposable)startup;
        ListenerApplicationHost? host = null; WebApplication? app = null; UpdateBridge? bridge = null;
        var addresses = new List<string>(); var phase = "init"; object? error = null, afterInit = null;
        object LocalUrl() {
            try { return new { value = host!.GetLocalApiUrl("127.0.0.1"), error = (object?)null }; }
            catch (Exception source) { return new { value = (string?)null, error = Failure(source) }; }
        }
        object State() => new { captured = new { host!.HttpPort, host.HttpsPort }, host.ListenWithHttps, host.HasPendingRestart,
            configuration = Snapshot(host.ConfigurationManager.GetNetworkConfiguration()), system = Snapshot(host.ConfigurationManager.Configuration),
            localUrl = LocalUrl(),
            networkDisk = Disk(networkFile, typeof(NetworkConfiguration)), systemDisk = Disk(systemFile, typeof(ServerConfiguration)),
            metadataDisk = Disk(Path.Combine(directory, "metadata.xml"), typeof(MetadataConfiguration)) };
        try {
            NetworkManager.MockNetworkSettings = input.GetProperty("interfaceInput").GetString()!;
            host = new ListenerApplicationHost(paths, loggerFactory, startup); owner = new { phase, name = sample.GetProperty("name").GetString() };
            phases.Add(new { phase, boundary = "before" }); host.Init(new ServiceCollection()); afterInit = Snapshot(State()); phases.Add(new { phase, boundary = "after", state = afterInit });
            bridge = new UpdateBridge(host, () => State());
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production", Args = [] });
            builder.Logging.ClearProviders(); builder.Logging.AddProvider(new ListenerLogger(log, () => owner));
            builder.Configuration.Sources.Clear(); builder.Configuration.AddConfiguration(startup);
            builder.WebHost.UseUrls(input.GetProperty("fallbackUrl").GetString()!);
            builder.WebHost.UseKestrel((context, kestrel) => {
                phases.Add(new { phase = "kestrel-options", boundary = "before" });
                Jellyfin.Server.Extensions.WebHostBuilderExtensions.SetupJellyfinWebServer(host.NetManager.GetAllBindInterfaces(false), host.HttpPort,
                    host.ListenWithHttps ? host.HttpsPort : null, host.Certificate, startup, paths,
                    loggerFactory.CreateLogger("listener-setup"), context, kestrel);
                phases.Add(new { phase = "kestrel-options", boundary = "after" });
            });
            builder.Services.AddSingleton<IServerConfigurationManager>(host.ConfigurationManager);
            builder.Services.AddSingleton<MediaBrowser.Common.Configuration.IConfigurationManager>(host.ConfigurationManager);
            builder.Services.AddSingleton<INetworkManager>(host.NetManager);
            builder.Services.AddSingleton<IServerApplicationHost>(host); builder.Services.AddSingleton<IServerApplicationPaths>(paths);
            builder.Services.AddSingleton<IFileSystem>(ListenerStub.Throwing<IFileSystem>());
            builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, ListenerAuthentication>("fixture", _ => { });
            builder.Services.AddAuthorization(value => {
                value.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").RequireAuthenticatedUser().Build();
                foreach (var policy in new[] { Policies.RequiresElevation, Policies.FirstTimeSetupOrIgnoreParentalControl, Policies.LocalAccessOrRequiresElevation })
                    value.AddPolicy(policy, new AuthorizationPolicyBuilder("fixture").RequireAuthenticatedUser().Build());
            });
            builder.Services.AddHttpsRedirection(value => value.HttpsPort = host.HttpsPort);
            builder.Services.AddJellyfinApi([], initial).ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new ListenerControllers()));
            builder.Services.Replace(ServiceDescriptor.Transient<ConfigurationController>(_ => new ConfigurationController(host.ConfigurationManager, ListenerStub.Throwing<IMediaEncoder>())));
            builder.Services.AddSingleton<ISystemManager>(services => new SystemManager(services.GetRequiredService<IHostApplicationLifetime>(), host, paths,
                host.ConfigurationManager, new ListenerStartupOptions(), ListenerStub.Make<IInstallationManager>((method, _) => method.Name == "get_CompletedInstallations"
                    ? Array.Empty<InstallationInfo>() : throw new InvalidOperationException("Unexpected installation gateway: " + method.Name)), ListenerStub.Throwing<ILibraryManager>()));
            phase = "build"; owner = new { phase }; phases.Add(new { phase, boundary = "before" }); app = builder.Build(); phases.Add(new { phase, boundary = "after" });
            app.UseMiddleware<BaseUrlRedirectionMiddleware>();
            void Configure(IApplicationBuilder main) {
                main.UseForwardedHeaders(); main.UseMiddleware<ExceptionMiddleware>();
                main.Use(async (context, next) => { try { await next(); } catch (Exception source) {
                    operationFailures.Enqueue(new { owner, method = context.Request.Method, path = context.Request.Path.ToString(), error = Failure(source) }); throw;
                } });
                if (initial.RequireHttps && host.ListenWithHttps) main.UseHttpsRedirection();
                main.UseAuthentication(); main.UseRouting(); main.UseAuthorization(); main.UseEndpoints(endpoints => endpoints.MapControllers());
            }
            if (string.IsNullOrEmpty(initial.BaseUrl)) Configure(app); else app.Map(initial.BaseUrl, Configure);
            phase = "start"; owner = new { phase }; phases.Add(new { phase, boundary = "before" });
            await app.StartAsync(); phases.Add(new { phase, boundary = "after" });
            addresses.AddRange(app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses);
            foreach (var address in addresses) probes.Add(await ObserveEndpoint(address, initial.BaseUrl, prepared, host, "initial"));
            if (sample.TryGetProperty("steps", out var declaredSteps)) foreach (var entry in declaredSteps.EnumerateArray().Select((step, index) => (step, index))) {
                var step = entry.step; var action = step.GetProperty("action").GetString()!;
                owner = new { phase = "step", index = entry.index, action }; bridge.Begin(owner);
                object? stepError = null, barrierError = null, response = null;
                try {
                    switch (action) {
                        case "blockSystemFile": File.Move(systemFile, systemFile + ".original"); Directory.CreateDirectory(systemFile); break;
                        case "mutateNetwork": {
                            var configuration = host.ConfigurationManager.GetNetworkConfiguration();
                            foreach (var field in Resolve(step.GetProperty("values"))!.AsObject()) {
                                var property = typeof(NetworkConfiguration).GetProperty(field.Key) ?? throw new InvalidOperationException("Unknown public input: " + field.Key);
                                property.SetValue(configuration, JsonSerializer.Deserialize(field.Value?.ToJsonString() ?? "null", property.PropertyType, JsonDefaults.Options));
                            }
                            break;
                        }
                        case "postNetwork": {
                            var values = JsonSerializer.SerializeToNode(host.ConfigurationManager.GetNetworkConfiguration(), JsonDefaults.Options)!.AsObject();
                            foreach (var field in Resolve(step.GetProperty("values"))!.AsObject()) values[field.Key] = field.Value?.DeepClone();
                            response = await Request(ManagementAddress(addresses), initial.BaseUrl + "/System/Configuration/network", prepared, values.ToJsonString()); break;
                        }
                        case "postNamed": response = await Request(ManagementAddress(addresses), initial.BaseUrl + "/System/Configuration/" + step.GetProperty("key").GetString(), prepared, Resolve(step.GetProperty("values"))!.ToJsonString()); break;
                        case "postSystem": response = await Request(ManagementAddress(addresses), initial.BaseUrl + "/System/Configuration", prepared, JsonSerializer.Serialize(host.ConfigurationManager.Configuration, JsonDefaults.Options)); break;
                        default: throw new InvalidOperationException("Unknown listener operation: " + action);
                    }
                } catch (Exception source) { stepError = Failure(source); }
                // This is an explicitly declared source-operation barrier, not an
                // event-count assertion. It also captures a throwing queued handler.
                if (step.TryGetProperty("waitSystemEvent", out var wait) && wait.GetBoolean()) {
                    try { await bridge.WaitSystem().WaitAsync(TimeSpan.FromSeconds(10)); }
                    catch (Exception source) { barrierError = Failure(source); }
                }
                steps.Add(new { index = entry.index, step, response, error = stepError, barrierError, state = Snapshot(State()), events = bridge.Snapshot() });
                foreach (var address in addresses) probes.Add(await ObserveEndpoint(address, initial.BaseUrl, prepared, host, "after-step-" + entry.index));
                if (sample.TryGetProperty("probeUnboundHttps", out var probeUnbound) && probeUnbound.GetBoolean())
                    unboundProbes.Add(new { index = entry.index, response = await Request("https://127.0.0.1:" + host.HttpsPort, initial.BaseUrl + "/System/Ping", prepared) });
            }
        } catch (Exception source) { error = Failure(source); phases.Add(new { phase, boundary = "failure", error }); }
        finally {
            owner = new { phase = "close" };
            if (app is not null) {
                try { await app.StopAsync(); lifecycle.Add(new { phase = "stop", accepted = true }); } catch (Exception source) { cleanupErrors.Add(Failure(source)); }
                try { await app.DisposeAsync(); lifecycle.Add(new { phase = "dispose-web", accepted = true }); } catch (Exception source) { cleanupErrors.Add(Failure(source)); }
            }
            bridge?.Dispose();
            if (host is not null) {
                try { (host.NetManager as IDisposable)?.Dispose(); } catch (Exception source) { cleanupErrors.Add(Failure(source)); }
                try { host.Certificate?.Dispose(); } catch (Exception source) { cleanupErrors.Add(Failure(source)); }
                try { host.Dispose(); } catch (Exception source) { cleanupErrors.Add(Failure(source)); }
            }
            NetworkManager.MockNetworkSettings = "";
        }
        var closed = new List<object>();
        foreach (var address in addresses) {
            var uri = ConnectUri(address); object? connectError = null, rebindError = null;
            using (var socket = new TcpClient()) try { await socket.ConnectAsync(uri.Host, uri.Port); } catch (Exception source) { connectError = Failure(source); }
            var listener = new TcpListener(IPAddress.Parse(uri.Host), uri.Port);
            try { listener.Start(); } catch (Exception source) { rebindError = Failure(source); } finally { listener.Stop(); }
            closed.Add(new { address, connectedAfterClose = connectError is null, connectError, reboundAfterClose = rebindError is null, rebindError });
        }
        return new { name = sample.GetProperty("name").GetString(), group, root, sample, resolvedInitial = Snapshot(initial), tokens,
            afterInit, accepted = error is null, error, phases, addresses, probes, unboundProbes, steps, events = bridge?.Snapshot(), operationFailures = operationFailures.ToArray(),
            diagnostics = log.ToArray(), close = new { lifecycle, errors = cleanupErrors, ports = closed },
            finalFiles = new { network = Disk(networkFile, typeof(NetworkConfiguration)), system = Disk(systemFile, typeof(ServerConfiguration)),
                originalSystem = File.Exists(systemFile + ".original") ? Disk(systemFile + ".original", typeof(ServerConfiguration)) : null } };
    }
    private static Uri ConnectUri(string address) {
        var uri = new UriBuilder(address); if (uri.Host is "0.0.0.0" or "localhost") uri.Host = "127.0.0.1";
        if (uri.Host is "[::]" or "::") uri.Host = "::1"; return uri.Uri;
    }
    private static string ManagementAddress(List<string> addresses) => addresses.FirstOrDefault(value => value.StartsWith("https:", StringComparison.Ordinal)) ?? addresses.First();
    private static async Task<object> ObserveEndpoint(string address, string prefix, JsonElement prepared, ListenerApplicationHost host, string label) => new {
        label, address,
        ping = await Request(address, prefix + "/System/Ping?source=listener%2Fraw&x=1", prepared),
        forwardedHttps = await Request(address, prefix + "/System/Ping?forwarded=true", prepared, forwardedHttps: true),
        info = await Request(address, prefix + "/System/Info", prepared),
        currentUrl = host.GetLocalApiUrl("127.0.0.1"), host.HasPendingRestart, host.ListenWithHttps,
    };
    private static async Task<object> Request(string address, string path, JsonElement prepared, string? body = null, bool forwardedHttps = false) {
        var peers = new List<object>();
        using var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false };
        handler.ServerCertificateCustomValidationCallback = (_, certificate, chain, policy) => {
            var der = certificate?.RawData; var fingerprint = der is null ? null : Certificates.Hash(der);
            var trusted = new[] { "a", "b" }.Any(name => prepared.GetProperty(name).GetProperty("derSha256").GetString() == fingerprint);
            peers.Add(new { derBase64 = der is null ? null : Convert.ToBase64String(der), sha256 = fingerprint, trusted,
                policy = policy.ToString(), chain = chain?.ChainStatus.Select(value => new { status = value.Status.ToString(), value.StatusInformation }).ToArray() });
            return trusted;
        };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10) };
        using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post, new Uri(ConnectUri(address), path));
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        if (forwardedHttps) request.Headers.TryAddWithoutValidation("X-Forwarded-Proto", "https");
        if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        object? error = null; HttpResponseMessage? response = null; byte[] bytes = []; JsonElement? json = null;
        try { response = await client.SendAsync(request); bytes = await response.Content.ReadAsByteArrayAsync(); try { json = JsonSerializer.Deserialize<JsonElement>(bytes); } catch (JsonException) { } }
        catch (Exception source) { error = Failure(source); }
        using (response) return new { method = request.Method.Method, url = request.RequestUri!.ToString(), status = response is null ? (int?)null : (int)response.StatusCode,
            headers = response?.Headers.Concat(response.Content.Headers).ToDictionary(value => value.Key, value => value.Value.ToArray()),
            contentType = response?.Content.Headers.ContentType?.ToString(), text = Encoding.UTF8.GetString(bytes), bodyBase64 = Convert.ToBase64String(bytes), json, error, peers };
    }
}

// The delegate is the actual current-source AppHost method. Reflection only
// selects this otherwise private component boundary; no private state is read or
// installed, and neither its identity nor exception type is an acceptance gate.
public sealed class UpdateBridge : IDisposable {
    private readonly ListenerApplicationHost _host; private readonly EventHandler _actual; private readonly Func<object> _state;
    private readonly ConcurrentQueue<object> _events = new(); private TaskCompletionSource _system = NewCompletion(); private object? _owner;
    private static TaskCompletionSource NewCompletion() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    public UpdateBridge(ListenerApplicationHost host, Func<object> state) {
        _host = host; _state = state;
        _actual = typeof(ApplicationHost).GetMethod("OnConfigurationUpdated", BindingFlags.Instance | BindingFlags.NonPublic)!.CreateDelegate<EventHandler>(host);
        host.ConfigurationManager.ConfigurationUpdated += SystemUpdated;
        host.ConfigurationManager.NamedConfigurationUpdated += NamedUpdated;
    }
    public void Begin(object owner) { _owner = owner; _system = NewCompletion(); }
    public Task WaitSystem() => _system.Task;
    private void Invoke(string phase, object? sender, EventArgs args) {
        object? error = null;
        try { _actual(sender!, args); }
        catch (Exception source) { error = HostCases.Failure(source); throw; }
        finally {
            object? state = null, observationError = null;
            try { state = _state(); } catch (Exception source) { observationError = HostCases.Failure(source); }
            _events.Enqueue(new { phase, owner = _owner, accepted = error is null, error, state, observationError });
        }
    }
    private void SystemUpdated(object? sender, EventArgs args) { try { Invoke("queued-system-updated", sender, args); } finally { _system.TrySetResult(); } }
    private void NamedUpdated(object? sender, MediaBrowser.Common.Configuration.ConfigurationUpdateEventArgs args) => Invoke("synchronous-named-updated", sender, args);
    public object Snapshot() => _events.ToArray();
    public void Dispose() { _host.ConfigurationManager.ConfigurationUpdated -= SystemUpdated; _host.ConfigurationManager.NamedConfigurationUpdated -= NamedUpdated; }
}
public sealed class ListenerApplicationHost(ServerApplicationPaths paths, ILoggerFactory logger, IConfiguration startup)
    : ApplicationHost(paths, logger, new ListenerStartupOptions(), startup) {
    protected override IEnumerable<Assembly> GetAssembliesWithPartsInternal() => [];
    protected override void RegisterServices(IServiceCollection services) { }
}
public sealed class ListenerStartupOptions : IStartupOptions {
    public string? FFmpegPath => null; public bool IsService => false; public string? PackageName => null; public string? PublishedServerUrl => null;
}
public class ListenerStub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Handler(method!, args);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, ListenerStub>(); ((ListenerStub)(object)value).Handler = handler; return value; }
    public static T Throwing<T>() where T : class => Make<T>((method, _) => throw new InvalidOperationException("Unexpected controlled gateway: " + typeof(T).Name + "." + method.Name));
}
public sealed class ListenerControllers : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var value in feature.Controllers.Where(value => value.AsType() != typeof(ConfigurationController) && value.AsType() != typeof(SystemController)).ToArray()) feature.Controllers.Remove(value);
    }
}
public sealed class ListenerAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() => Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(
        new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, UserRoles.Administrator)], Scheme.Name)), Scheme.Name)));
}
public sealed class ListenerLogger(ConcurrentQueue<object> entries, Func<object?> owner) : ILoggerProvider {
    public ILogger CreateLogger(string category) => new Capture(entries, category, owner); public void Dispose() { }
    private sealed class Capture(ConcurrentQueue<object> entries, string category, Func<object?> owner) : ILogger {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null; public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
            if (error is not null || level >= LogLevel.Warning) entries.Enqueue(new { owner = owner(), category, level = level.ToString(), formatted = formatter(state, error), error = error is null ? null : HostCases.Failure(error) });
        }
    }
}
