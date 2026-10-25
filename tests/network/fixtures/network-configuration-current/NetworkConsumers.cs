using System.Net;
using System.Net.WebSockets;
using System.Reflection;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Api.Auth.FirstTimeSetupPolicy;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Data;
using Jellyfin.Extensions.Json;
using Jellyfin.Networking.Manager;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Net;
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
using Microsoft.Extensions.Logging;
using static MediaBrowser.Controller.Extensions.ConfigurationExtensions;
using CommandLine;

public static class NetworkConsumers {
    public static object MapPrefix(JsonElement raw, Func<Exception, object> failure) {
        var configuration = new NetworkConfiguration { BaseUrl = raw.GetString()! };
        using var services = new ServiceCollection().BuildServiceProvider();
        var application = new ApplicationBuilder(services);
        object? error = null;
        try { application.Map(configuration.BaseUrl, _ => { }); }
        catch (Exception source) { error = failure(source); }
        return new { raw = raw.GetString(), baseUrl = configuration.BaseUrl, accepted = error is null, error };
    }
    public static object StartupConfiguration(JsonElement sample) {
        using var parser = new Parser(settings => { settings.HelpWriter = null; settings.AutoHelp = false; settings.AutoVersion = false; });
        var arguments = sample.GetProperty("args").EnumerateArray().Select(value => value.GetString()!).ToArray();
        return parser.ParseArguments<Jellyfin.Server.StartupOptions>(arguments).MapResult(options => {
            var supplied = sample.GetProperty("environment").EnumerateObject().ToDictionary(value => value.Name, value => value.Value.GetString());
            var names = Environment.GetEnvironmentVariables().Keys.Cast<string>()
                .Where(value => value.Equals("JELLYFIN_PublishedServerUrl", StringComparison.OrdinalIgnoreCase)).Concat(supplied.Keys).Distinct().ToArray();
            var original = names.ToDictionary(value => value, Environment.GetEnvironmentVariable);
            try {
                foreach (var name in names) Environment.SetEnvironmentVariable(name, null);
                foreach (var pair in supplied) Environment.SetEnvironmentVariable(pair.Key, pair.Value);
                var configuration = new ConfigurationBuilder().AddEnvironmentVariables("JELLYFIN_").AddInMemoryCollection(options.ConvertToConfig()).Build();
                using var releaseConfiguration = (IDisposable)configuration;
                return (object)new { name = sample.GetProperty("name").GetString(), accepted = true, value = configuration[AddressOverrideKey] };
            } finally { foreach (var pair in original) Environment.SetEnvironmentVariable(pair.Key, pair.Value); }
        }, errors => (object)new { name = sample.GetProperty("name").GetString(), accepted = false, errors = errors.Select(value => value.ToString()).ToArray() });
    }
    public static void Apply(NetworkConfiguration value, JsonElement fields) {
        foreach (var field in fields.EnumerateObject()) {
            var property = typeof(NetworkConfiguration).GetProperty(field.Name) ?? throw new InvalidOperationException("Unknown network input field: " + field.Name);
            property.SetValue(value, JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, JsonDefaults.Options));
        }
    }
    private static IConfiguration Startup(JsonElement sample) => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?> {
        [DetectNetworkChangeKey] = "false", [DefaultRedirectKey] = "web/",
        [AddressOverrideKey] = sample.TryGetProperty("publishedUrl", out var url) ? url.GetString() : null,
    }).Build();
    private static JsonElement PrepareInterfaceInput(JsonElement raw, NetworkConfiguration configuration, JsonSerializerOptions options) {
        // The real GetInterfacesCore filters families before bind validation.
        // MockNetworkSettings bypasses it, so supply that same selected input
        // for these failure cases. Recording preparation does not claim that
        // an earlier failing operation reached interface initialization.
        var injected = raw.EnumerateArray().Where(value => IPAddress.Parse(value.GetProperty("address").GetString()!).AddressFamily
            == System.Net.Sockets.AddressFamily.InterNetwork ? configuration.EnableIPv4 : configuration.EnableIPv6).Select(value => value.Clone()).ToArray();
        NetworkManager.MockNetworkSettings = string.Join("|", injected.Select(value =>
            $"{value.GetProperty("address").GetString()}/{value.GetProperty("prefixLength").GetInt32()},{value.GetProperty("index").GetInt32()},{value.GetProperty("name").GetString()}"));
        return JsonSerializer.SerializeToElement(new { raw, injected, ipv4 = configuration.EnableIPv4, ipv6 = configuration.EnableIPv6 }, options);
    }
    public static object Policy(Fixture fixture, JsonElement sample, JsonSerializerOptions options, Func<Exception,object> failure, JsonElement interfaces) {
        var originalInput = NetworkManager.MockNetworkSettings;
        try { return PolicyCore(fixture, sample, options, failure, interfaces); }
        finally { NetworkManager.MockNetworkSettings = originalInput; }
    }
    private static object PolicyCore(Fixture fixture, JsonElement sample, JsonSerializerOptions options, Func<Exception,object> failure, JsonElement interfaces) {
        var initial = new NetworkConfiguration(); Apply(initial, sample.GetProperty("initial")); fixture.Manager.SaveConfiguration("network", initial);
        var prepareFamilies = sample.TryGetProperty("prepareInterfaceFamilies", out var prepare) && prepare.GetBoolean();
        object? interfaceInput = prepareFamilies ? PrepareInterfaceInput(interfaces, initial, options) : null;
        var initialInterfaceInput = interfaceInput;
        var paths = new ServerApplicationPaths(fixture.Root, Path.Combine(fixture.Root,"log"), fixture.Directory, Path.Combine(fixture.Root,"cache"), Path.Combine(fixture.Root,"web"));
        using var host = new UrlHost(paths,fixture.LoggerFactory,Startup(sample)); host.Init(new ServiceCollection());
        var manager=host.ConfigurationManager; using var network=(NetworkManager)host.NetManager;
        var observations = new List<JsonElement>(); var events = new List<JsonElement>();
        manager.NamedConfigurationUpdated += (_, entry) => events.Add(JsonSerializer.SerializeToElement(new { key = entry.Key, configuration = entry.NewConfiguration }, options));
        foreach (var step in sample.GetProperty("steps").EnumerateArray()) {
            object? error = null;
            try {
                switch (step.GetProperty("action").GetString()) {
                    case "save": {
                        var incoming = new NetworkConfiguration(); Apply(incoming, step.GetProperty("values"));
                        var key = step.TryGetProperty("key", out var suppliedKey) ? suppliedKey.GetString()! : "network";
                        if (prepareFamilies && key.Equals("network", StringComparison.Ordinal)) interfaceInput = PrepareInterfaceInput(interfaces, incoming, options);
                        manager.SaveConfiguration(key, incoming); break;
                    }
                    case "mutate": Apply(manager.GetNetworkConfiguration(), step.GetProperty("values")); break;
                    case "inspect": break;
                    default: throw new InvalidOperationException("Unknown network policy operation.");
                }
            } catch (Exception source) { error = failure(source); }
            var addresses = sample.GetProperty("addresses").EnumerateArray().Select(entry => {
                var address = IPAddress.Parse(entry.GetString()!); var bind = network.GetBindAddress(address, out var port);
                var direct = network.GetBindAddress(address, out var directPort, true);
                var access = network.ShouldAllowServerAccess(address);
                return new { address = entry.GetString(), local = network.IsInLocalNetwork(address), access = access.ToString(),
                    allowed = access == RemoteAccessPolicyResult.Allow,
                    bind = new { address = bind, port }, direct = new { address = direct, port = directPort } };
            }).ToArray();
            observations.Add(JsonSerializer.SerializeToElement(new { step, accepted = error is null, error,
                configuration = manager.GetNetworkConfiguration(), interfaceInput, addresses,
                localUrls = new[] { "10.20.0.10", "2001:db8:1::10" }.Select(hostname=>new { host=hostname,value=host.GetLocalApiUrl(hostname) }).ToArray() }, options));
        }
        return new { name = sample.GetProperty("name").GetString(), initialInterfaceInput, steps = observations, events, diagnostics = fixture.Log };
    }
    public static object Urls(Fixture fixture, JsonElement sample, JsonSerializerOptions options, Func<Exception,object> failure) {
        var serializer = new MyXmlSerializer(); var initial = new NetworkConfiguration(); Apply(initial, sample.GetProperty("initial"));
        serializer.SerializeToFile(initial, Path.Combine(fixture.Directory,"network.xml"));
        var paths = new ServerApplicationPaths(fixture.Root, Path.Combine(fixture.Root,"log"), fixture.Directory, Path.Combine(fixture.Root,"cache"), Path.Combine(fixture.Root,"web"));
        // Real Init captures listener ports, constructs NetworkManager and discovers
        // real configuration factories. RegisterServices is deliberately bounded:
        // no Resolve/FindParts/RunStartupTasks/encoder or media services execute.
        using var host = new UrlHost(paths, fixture.LoggerFactory, Startup(sample));
        host.Init(new ServiceCollection());
        try {
            var observations = new List<JsonElement>();
            foreach (var step in sample.GetProperty("steps").EnumerateArray()) {
                object? error = null;
                try {
                    if (step.GetProperty("action").GetString() == "save") {
                        var next = new NetworkConfiguration(); Apply(next, step.GetProperty("values")); host.ConfigurationManager.SaveConfiguration("network", next);
                    } else if (step.GetProperty("action").GetString() == "mutate") Apply(host.ConfigurationManager.GetNetworkConfiguration(), step.GetProperty("values"));
                } catch (Exception source) { error = failure(source); }
                var requests = sample.GetProperty("requests").EnumerateArray().Select(entry => {
                    var context = new DefaultHttpContext(); context.Request.Host = new HostString(entry.GetProperty("host").GetString()!);
                    context.Request.Scheme = entry.GetProperty("scheme").GetString()!; context.Connection.RemoteIpAddress = IPAddress.Parse(entry.GetProperty("remote").GetString()!);
                    return new { request = entry, value = host.GetSmartApiUrl(context.Request) };
                }).ToArray();
                var local = sample.GetProperty("localHosts").EnumerateArray().Select(entry => new { host = entry.GetString(), value = host.GetLocalApiUrl(entry.GetString()!) }).ToArray();
                observations.Add(JsonSerializer.SerializeToElement(new { step, accepted = error is null, error, configuration = host.ConfigurationManager.GetNetworkConfiguration(), requests, local }, options));
            }
            return new { name = sample.GetProperty("name").GetString(), steps = observations, diagnostics = fixture.Log };
        } finally { ((IDisposable)host.NetManager).Dispose(); }
    }
    public static async Task<object> Http(Fixture fixture, JsonElement sample, JsonSerializerOptions options, Func<Exception,object> failure) {
        var initial = new NetworkConfiguration { KnownProxies = ["127.0.0.1"], EnableRemoteAccess = !(sample.TryGetProperty("disabled", out var disabled) && disabled.GetBoolean()) };
        if (sample.TryGetProperty("initial", out var initialFields)) Apply(initial, initialFields);
        if(sample.TryGetProperty("coldKnownProxies",out var coldProxies)) initial.KnownProxies=JsonSerializer.Deserialize<string[]>(coldProxies.GetRawText(),JsonDefaults.Options)!;
        fixture.Manager.SaveConfiguration("network", initial);
        using var network = new NetworkManager(fixture.Manager, Startup(sample), fixture.LoggerFactory.CreateLogger<NetworkManager>());
        var key = sample.GetProperty("key").GetString()!;
        var filename = Path.Combine(fixture.Directory, key.ToLowerInvariant() + ".xml");
        if (sample.TryGetProperty("physical", out var physical) && physical.GetString() == "target-directory") { File.Delete(filename); Directory.CreateDirectory(filename); }
        var events = new List<JsonElement>();
        fixture.Manager.NamedConfigurationUpdating += (_, entry) => {
            events.Add(JsonSerializer.SerializeToElement(new { phase = "updating", key = entry.Key, configuration = entry.NewConfiguration }, options));
            if (sample.TryGetProperty("observer", out var observer) && observer.GetString() == "updating") throw new InvalidOperationException("Controlled named updating failure.");
        };
        fixture.Manager.NamedConfigurationUpdated += (_, entry) => {
            events.Add(JsonSerializer.SerializeToElement(new { phase = "updated", key = entry.Key, configuration = entry.NewConfiguration }, options));
            if (sample.TryGetProperty("observer", out var observer) && observer.GetString() == "updated") throw new InvalidOperationException("Controlled named updated failure.");
        };
        await using var host = await MiddlewareHost.Start(fixture, initial, network, sample, failure);
        var route = sample.TryGetProperty("route", out var explicitRoute) ? explicitRoute.GetString()! : "/System/Configuration/" + key;
        var response = await host.Request(sample.GetProperty("method").GetString()!, route,
            sample.TryGetProperty("body", out var body) ? body.GetString() : null,
            sample.TryGetProperty("identity", out var identity) ? identity.GetString()! : "admin",
            sample.TryGetProperty("forwarded", out var forwarded) ? forwarded.GetString() : sample.TryGetProperty("remote", out var remote) && remote.GetBoolean() ? "203.0.113.9" : null);
        var afterRead = await host.Request("GET", "/System/Configuration/" + key, null, "admin",
            sample.TryGetProperty("afterForwarded",out var afterForwarded) ? afterForwarded.GetString() : null);
        object? value = key.Equals("network",StringComparison.OrdinalIgnoreCase) ? fixture.Manager.GetConfiguration(key) : null;
        byte[]? bytes = File.Exists(filename) ? File.ReadAllBytes(filename) : null; object? cold = null, diskError = null;
        if (bytes is not null) try { cold = new MyXmlSerializer().DeserializeFromBytes(typeof(NetworkConfiguration),bytes); } catch (Exception source) { diskError = failure(source); }
        return new { name = sample.GetProperty("name").GetString(), root = fixture.Root, response, afterRead, live = value, events,
            disk = key.Equals("network",StringComparison.OrdinalIgnoreCase) ? new { bytes = bytes is null ? null : Convert.ToBase64String(bytes),
                directory = Directory.Exists(filename), accepted = bytes is null ? (bool?)null : diskError is null, value = cold, error = diskError } : null,
            operationFailures = host.Failures.ToArray(), diagnostics = fixture.Log.ToArray() };
    }
    public static async Task<object> Lifecycle(Fixture fixture, JsonElement sample, JsonSerializerOptions options, Func<Exception,object> failure) {
        var initial = new NetworkConfiguration(); Apply(initial, sample.GetProperty("initial")); fixture.Manager.SaveConfiguration("network",initial);
        using var network = new NetworkManager(fixture.Manager,Startup(sample),fixture.LoggerFactory.CreateLogger<NetworkManager>());
        await using var host = await MiddlewareHost.Start(fixture, initial, network, sample, failure);
        var remote = sample.GetProperty("remote").GetString()!;
        using var socket = new ClientWebSocket(); socket.Options.SetRequestHeader("X-Identity","admin"); socket.Options.SetRequestHeader("X-Forwarded-For",remote);
        await socket.ConnectAsync(new Uri(host.Address.Replace("http:","ws:") + "/a/socket"),CancellationToken.None);
        async Task<string> Echo(string value) {
            await socket.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(value)),WebSocketMessageType.Text,true,CancellationToken.None);
            var buffer = new byte[4096]; var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer),CancellationToken.None);
            if (result.MessageType != WebSocketMessageType.Text || !result.EndOfMessage) throw new IOException("Fixture echo did not return a complete text message.");
            return Encoding.UTF8.GetString(buffer,0,result.Count);
        }
        var before = await Echo(sample.GetProperty("messages")[0].GetString()!);
        var updated = await host.Request("POST","/a/System/Configuration/network","{\"BaseUrl\":\"/a\",\"EnableRemoteAccess\":false,\"KnownProxies\":[]}");
        var rejectedHttp = await host.Request("GET","/a/System/Configuration/network",null,"admin",remote);
        var rejectedUpgrade = await host.Upgrade("/a/socket",remote);
        var after = await Echo(sample.GetProperty("messages")[1].GetString()!);
        var current = fixture.Manager.GetNetworkConfiguration(); current.BaseUrl = sample.GetProperty("nextBaseUrl").GetString()!;
        fixture.Manager.SaveConfiguration("network",current);
        var oldPath = await host.Request("GET","/a/System/Configuration/network");
        var newPath = await host.Request("GET","/b/System/Configuration/network");
        var health = await host.Request("GET","/health");
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure,"fixture finished",CancellationToken.None);
        var close = new { code = (int?)socket.CloseStatus, reason = socket.CloseStatusDescription };
        return new { name = sample.GetProperty("name").GetString(), root = fixture.Root, before, updated, rejectedHttp, rejectedUpgrade, after,
            oldPath, newPath, health, close, live = current, operationFailures = host.Failures.ToArray(), diagnostics = fixture.Log.ToArray() };
    }
}

public sealed class UrlHost : ApplicationHost {
    public UrlHost(ServerApplicationPaths paths, ILoggerFactory logger, IConfiguration startup) : base(paths,logger,new UrlStartupOptions(),startup) { }
    protected override IEnumerable<Assembly> GetAssembliesWithPartsInternal() => [];
    protected override void RegisterServices(IServiceCollection services) { }
}
public sealed class UrlStartupOptions : IStartupOptions {
    public string? FFmpegPath => null; public bool IsService => false; public string? PackageName => null; public string? PublishedServerUrl => null;
}
public sealed class NetworkControllerFeature : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var controller in feature.Controllers.Where(value => value.AsType() != typeof(ConfigurationController) && value.AsType() != typeof(StartupController)).ToArray()) feature.Controllers.Remove(controller);
    }
}
public sealed class MiddlewareHost : IAsyncDisposable {
    private readonly WebApplication _app; private readonly HttpClient _client;
    public readonly List<object> Failures; public readonly string Address;
    private readonly Func<Exception,object> _failure;
    private MiddlewareHost(WebApplication app,string address,List<object> failures,Func<Exception,object> failure) {
        _app=app; Address=address; Failures=failures; _failure=failure; _client=new HttpClient(new HttpClientHandler { AllowAutoRedirect=false });
    }
    public static async Task<MiddlewareHost> Start(Fixture fixture,NetworkConfiguration initial,NetworkManager network,JsonElement sample,Func<Exception,object> failure) {
        var builder=WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName="Production" });
        builder.Configuration[DefaultRedirectKey]="web/"; builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders(); builder.Logging.AddProvider(new EvidenceLoggerProvider(fixture.Log));
        builder.Services.AddSingleton<IServerConfigurationManager>(fixture.Manager); builder.Services.AddSingleton<INetworkManager>(network);
        builder.Services.AddSingleton<MediaBrowser.Common.Configuration.IConfigurationManager>(fixture.Manager);
        var user=new User("network-fixture","controlled","controlled") { Id=Guid.Parse("f82b0000-0000-0000-0000-000000000001") };
        user.SetPermission(PermissionKind.EnableRemoteAccess,true);
        builder.Services.AddSingleton(Stub.Make<IUserManager>((method,_) => method.Name=="GetUserById" ? user : throw new InvalidOperationException("Unexpected user gateway: "+method.Name)));
        builder.Services.AddHttpContextAccessor(); builder.Services.AddSingleton<IAuthorizationHandler,DefaultAuthorizationHandler>();
        builder.Services.AddSingleton<IAuthorizationHandler,FirstTimeSetupHandler>();
        builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions,FixtureAuthentication>("fixture",_=>{});
        builder.Services.AddAuthorization(value=> {
            value.DefaultPolicy=new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement()).Build();
            value.AddPolicy(Policies.RequiresElevation,policy=>policy.AddAuthenticationSchemes("fixture").RequireClaim(ClaimTypes.Role,UserRoles.Administrator));
            value.AddPolicy(Policies.FirstTimeSetupOrElevated,policy=>policy.AddAuthenticationSchemes("fixture").AddRequirements(new FirstTimeSetupRequirement()));
        });
        var failures=new List<object>();
        builder.Services.AddJellyfinApi([],initial).ConfigureApplicationPartManager(value=>value.FeatureProviders.Add(new NetworkControllerFeature()));
        builder.Services.Replace(ServiceDescriptor.Transient<ConfigurationController>(_=>new ConfigurationController(fixture.Manager,
            Stub.Make<IMediaEncoder>((method,_)=>throw new InvalidOperationException("Unexpected media executor: "+method.Name)))));
        builder.Services.AddSingleton<IWebSocketManager,EchoGateway>();
        var app=builder.Build();
        try {
            app.UseMiddleware<BaseUrlRedirectionMiddleware>();
            void Configure(IApplicationBuilder main) {
                main.UseForwardedHeaders(); main.UseMiddleware<ExceptionMiddleware>(); main.UseWebSockets();
                // Preserve the original thrown error before actual ExceptionMiddleware
                // formats the public response, including IOException without a log exception.
                main.Use(async(context,next)=> { try { await next(); } catch(Exception error) {
                    failures.Add(new { method=context.Request.Method,path=context.Request.Path.ToString(),error=failure(error) }); throw;
                } });
                main.UseAuthentication(); main.UseRouting(); main.UseAuthorization();
                main.UseMiddleware<IPBasedAccessValidationMiddleware>(); main.UseMiddleware<WebSocketHandlerMiddleware>();
                main.UseEndpoints(endpoints=>endpoints.MapControllers());
            }
            if (string.IsNullOrEmpty(initial.BaseUrl)) Configure(app); else app.Map(initial.BaseUrl,Configure);
            await app.StartAsync();
            var address=app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            return new MiddlewareHost(app,address,failures,failure);
        } catch(Exception primary) {
            var errors=new List<Exception> { primary };
            try { await app.StopAsync(); } catch(Exception cleanup) { errors.Add(cleanup); }
            try { await app.DisposeAsync(); } catch(Exception cleanup) { errors.Add(cleanup); }
            if(errors.Count>1) throw new AggregateException("Network middleware startup cleanup failed.",errors);
            throw;
        }
    }
    public async Task<object> Request(string method,string path,string? body=null,string identity="admin",string? forwarded=null,bool upgrade=false) {
        using var request=new HttpRequestMessage(new HttpMethod(method),Address+path);
        request.Headers.TryAddWithoutValidation("X-Identity",identity); request.Headers.TryAddWithoutValidation("Accept","application/json");
        if(forwarded is not null) request.Headers.TryAddWithoutValidation("X-Forwarded-For",forwarded);
        if(upgrade) {
            request.Headers.TryAddWithoutValidation("Connection","Upgrade"); request.Headers.TryAddWithoutValidation("Upgrade","websocket");
            request.Headers.TryAddWithoutValidation("Sec-WebSocket-Version","13");
            request.Headers.TryAddWithoutValidation("Sec-WebSocket-Key",Convert.ToBase64String(Encoding.ASCII.GetBytes("network-fixture!")));
        }
        if(body is not null) { request.Content=new ByteArrayContent(Encoding.UTF8.GetBytes(body)); request.Content.Headers.TryAddWithoutValidation("Content-Type","application/json"); }
        HttpResponseMessage? response=null; string text=""; byte[] bytes=[]; JsonElement? value=null; object? error=null;
        try { response=await _client.SendAsync(request); bytes=await response.Content.ReadAsByteArrayAsync(); text=Encoding.UTF8.GetString(bytes);
            try { value=JsonSerializer.Deserialize<JsonElement>(text); } catch(JsonException) { }
        } catch(Exception source) { error=_failure(source); }
        using(response) return new { status=response is null ? (int?)null:(int)response.StatusCode, contentType=response?.Content.Headers.ContentType?.ToString(),
            text,json=value,bodyBase64=Convert.ToBase64String(bytes),error,headers=response?.Headers.Concat(response.Content.Headers).ToDictionary(pair=>pair.Key,pair=>pair.Value.ToArray()) };
    }
    public Task<object> Upgrade(string path,string remote) => Request("GET",path,null,"anonymous",remote,true);
    public async ValueTask DisposeAsync() {
        var errors=new List<Exception>(); _client.Dispose();
        try { await _app.StopAsync(); } catch(Exception error) { errors.Add(error); }
        try { await _app.DisposeAsync(); } catch(Exception error) { errors.Add(error); }
        if(errors.Count>0) throw new AggregateException("Network middleware resources failed to close.",errors);
    }
}
// Explicit gateway: actual WebSocketHandlerMiddleware delegates only transport
// echo here. It does not claim Native SessionManager/auth/token message behavior.
public sealed class EchoGateway : IWebSocketManager {
    public async Task WebSocketRequestHandler(HttpContext context) {
        using var socket=await context.WebSockets.AcceptWebSocketAsync(); var buffer=new byte[4096];
        while(socket.State==WebSocketState.Open) {
            var result=await socket.ReceiveAsync(new ArraySegment<byte>(buffer),context.RequestAborted);
            if(result.MessageType==WebSocketMessageType.Close) {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure,"fixture finished",CancellationToken.None); return;
            }
            await socket.SendAsync(new ArraySegment<byte>(buffer,0,result.Count),result.MessageType,result.EndOfMessage,context.RequestAborted);
        }
    }
}
