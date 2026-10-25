using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Extensions.Json;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Configuration;
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

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var snapshots = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
ServerConfiguration current = new();
var received = new List<JsonElement>(); var diagnostics = new List<object>(); bool rejectReplacement = false;
var user = new User("configuration-binding", "controlled", "controlled") { Id = Guid.Parse("f81b0000000000000000000000000001") };
var configuration = Stub.Make<IServerConfigurationManager>((method, values) => {
    if (method.Name is "get_Configuration" or "get_CommonConfiguration") return current;
    if (method.Name == "ReplaceConfiguration") {
        var next = (ServerConfiguration)values![0]!;
        received.Add(JsonSerializer.SerializeToElement(next, snapshots));
        if (rejectReplacement) throw new IOException("Controlled configuration replacement failure.");
        current = next; return null;
    }
    return Stub.Default(method.ReturnType);
});
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.Logging.AddProvider(new DiagnosticProvider(diagnostics));
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(configuration);
builder.Services.AddSingleton(Stub.Make<IUserManager>((method, _) => method.Name == "GetUserById" ? user : Stub.Default(method.ReturnType)));
builder.Services.AddSingleton(Stub.Make<INetworkManager>((method, _) => method.Name == "IsInLocalNetwork" ? true : Stub.Default(method.ReturnType)));
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(options => {
    options.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement()).Build();
    options.AddPolicy(Policies.RequiresElevation, policy => policy.AddAuthenticationSchemes("fixture").RequireClaim(ClaimTypes.Role, UserRoles.Administrator));
});
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlyConfigurationController()));
builder.Services.Replace(ServiceDescriptor.Transient<ConfigurationController>(_ => new ConfigurationController(configuration, Stub.Make<IMediaEncoder>((method, _) => throw new InvalidOperationException("Unexpected encoder call: " + method.Name)))));
var app = builder.Build(); var observations = new List<object>(); using var client = new HttpClient();
try {
    app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
    var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
    foreach (var sample in input.EnumerateArray()) {
        current = new ServerConfiguration { IsStartupWizardCompleted = true, PreviousVersion = new Version(10, 20, 30) };
        received.Clear(); diagnostics.Clear(); rejectReplacement = sample.TryGetProperty("rejectReplacement", out var reject) && reject.GetBoolean();
        using var request = new HttpRequestMessage(new HttpMethod(sample.GetProperty("method").GetString()!), address + sample.GetProperty("path").GetString());
        request.Headers.TryAddWithoutValidation("Accept", sample.TryGetProperty("accept", out var accept) ? accept.GetString() : "application/json");
        request.Headers.TryAddWithoutValidation("X-Identity", sample.TryGetProperty("identity", out var identity) ? identity.GetString() : "admin");
        if (sample.TryGetProperty("body", out var body)) {
            request.Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body.GetString()!));
            request.Content.Headers.TryAddWithoutValidation("Content-Type", sample.TryGetProperty("contentType", out var type) ? type.GetString() : "application/json");
        }
        using var response = await client.SendAsync(request); var text = await response.Content.ReadAsStringAsync(); JsonElement? json = null;
        try { json = JsonSerializer.Deserialize<JsonElement>(text); } catch (JsonException) { }
        object? currentRead = null;
        if (response.IsSuccessStatusCode && sample.GetProperty("method").GetString() == "POST" && received.Count > 0) {
            using var readRequest = new HttpRequestMessage(HttpMethod.Get, address + "/System/Configuration");
            readRequest.Headers.TryAddWithoutValidation("Accept", "application/json");
            readRequest.Headers.TryAddWithoutValidation("X-Identity", sample.TryGetProperty("identity", out var readIdentity) ? readIdentity.GetString() : "admin");
            using var readResponse = await client.SendAsync(readRequest); var readText = await readResponse.Content.ReadAsStringAsync(); JsonElement? readJson = null;
            try { readJson = JsonSerializer.Deserialize<JsonElement>(readText); } catch (JsonException) { }
            currentRead = new { status = (int)readResponse.StatusCode, contentType = readResponse.Content.Headers.ContentType?.ToString(), text = readText, json = readJson };
        }
        observations.Add(new { name = sample.GetProperty("name").GetString(), status = (int)response.StatusCode,
            contentType = response.Content.Headers.ContentType?.ToString(), text, json, received = received.ToArray(),
            live = JsonSerializer.SerializeToElement(current, snapshots), currentRead, diagnostics = diagnostics.ToArray() });
    }
} finally { try { await app.StopAsync(); } finally { await app.DisposeAsync(); } }
var assemblies = new[] { typeof(ConfigurationController).Assembly, typeof(ServerConfiguration).Assembly, typeof(JsonDefaults).Assembly }.Distinct()
    .Select(value => new { filename = value.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(value.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    actualMvc = true, actualController = true, actualTypedModelsAndSetters = true, actualDefaultAuthorization = true,
    actualExceptionMiddleware = true, controlledReplacement = true, persistenceOrRuntimeConsumersExecuted = false,
    hostStopped = true, hostDisposed = true, processorCount = Environment.ProcessorCount, assemblies, observations }, snapshots));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class OnlyConfigurationController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var item in feature.Controllers.Where(value => value.AsType() != typeof(ConfigurationController)).ToArray()) feature.Controllers.Remove(item);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = Request.Headers["X-Identity"].ToString();
        if (identity is "anonymous" or "invalid") return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, (identity == "apiKey").ToString()),
            new(InternalClaimTypes.UserId, "f81b0000000000000000000000000001") };
        if (identity != "regular") claims.Add(new Claim(ClaimTypes.Role, UserRoles.Administrator));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name)), Scheme.Name)));
    }
}
public class DiagnosticProvider(List<object> entries) : ILoggerProvider {
    public ILogger CreateLogger(string category) => new DiagnosticLogger(entries, category); public void Dispose() { }
    public class DiagnosticLogger(List<object> entries, string category) : ILogger {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
            if (error is not null) entries.Add(new { category, error = Capture(error) });
        }
        private static object Capture(Exception error) => new { type = error.GetType().FullName, error.Message, error.StackTrace,
            cause = error.InnerException is null ? null : Capture(error.InnerException),
            errors = error is AggregateException group ? group.InnerExceptions.Select(Capture).ToArray() : null };
    }
}
