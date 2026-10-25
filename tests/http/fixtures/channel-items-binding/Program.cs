using System.Globalization;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Extensions.Json;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Channels;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US"); CultureInfo.CurrentUICulture = CultureInfo.CurrentCulture;
var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
var userId = Guid.Parse(input.GetProperty("userId").GetString()!); var user = new User("binding", "controlled", "controlled") { Id = userId };
var lookups = new List<string>(); var queries = new List<object>(); var diagnostics = new List<object>();
var users = Stub.Make<IUserManager>((method, values) => {
    if (method.Name == "GetUserById") { var id = (Guid)values![0]!; lookups.Add(id.ToString("N")); return id == userId ? user : null; }
    return Stub.Default(method.ReturnType);
});
var channels = Stub.Make<IChannelManager>((method, values) => {
    if (method.Name is not ("GetChannelItems" or "GetLatestChannelItems")) throw new InvalidOperationException("Unexpected Channel operation: " + method.Name);
    var query = (InternalItemsQuery)values![0]!;
    queries.Add(new { kind = method.Name == "GetChannelItems" ? "items" : "latest", UserId = query.User?.Id.ToString("N"), ParentId = query.ParentId.ToString("N"),
        ChannelIds = query.ChannelIds.Select(value => value.ToString("N")).ToArray(), query.StartIndex, query.Limit,
        OrderBy = query.OrderBy.Select(pair => new[] { pair.OrderBy.ToString(), pair.SortOrder.ToString() }).ToArray(),
        Fields = query.DtoOptions.Fields.Select(value => value.ToString()).ToArray(), query.IsFolder, query.IsPlayed, query.IsFavorite,
        query.IsResumable, query.IsLiked, query.IsFavoriteOrLiked });
    return Task.FromResult(new QueryResult<BaseItemDto>(query.StartIndex, 0, []));
});
var configuration = new ServerConfiguration { IsStartupWizardCompleted = true };
var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration" ? configuration : Stub.Default(method.ReturnType));
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.Logging.AddProvider(new DiagnosticProvider(diagnostics)); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(channels); builder.Services.AddSingleton(users); builder.Services.AddSingleton(config); builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton(Stub.Make<INetworkManager>((method, _) => method.Name == "IsInLocalNetwork" ? true : Stub.Default(method.ReturnType)));
builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, ChannelAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(value => value.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement()).Build());
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlyChannelController()));
var app = builder.Build(); var observations = new List<object>(); using var client = new HttpClient();
try {
    app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
    var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
    foreach (var sample in input.GetProperty("requests").EnumerateArray()) {
        queries.Clear(); lookups.Clear(); diagnostics.Clear(); using var request = new HttpRequestMessage(HttpMethod.Get, address + sample.GetProperty("path").GetString());
        request.Headers.TryAddWithoutValidation("Accept", "application/json"); request.Headers.TryAddWithoutValidation("X-Identity", sample.TryGetProperty("identity", out var identity) ? identity.GetString() : "admin");
        using var response = await client.SendAsync(request); var body = await response.Content.ReadAsStringAsync(); JsonElement? json = null;
        try { json = JsonSerializer.Deserialize<JsonElement>(body); } catch (JsonException) { }
        observations.Add(new { name = sample.GetProperty("name").GetString(), path = sample.GetProperty("path").GetString(), status = (int)response.StatusCode,
            body, json, contentType = response.Content.Headers.ContentType?.ToString(), queries = queries.ToArray(), lookups = lookups.ToArray(), diagnostics = diagnostics.ToArray() });
    }
} finally { try { await app.StopAsync(); } finally { await app.DisposeAsync(); } }
var assemblies = new[] { typeof(ChannelsController).Assembly, typeof(InternalItemsQuery).Assembly, typeof(QueryResult<>).Assembly }.Distinct()
    .Select(value => new { filename = value.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(value.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), actualMvc = true, actualController = true,
    actualCommaBinder = true, actualDefaultAuthorization = true, actualExceptionMiddleware = true, controlledManager = true, mediaExecutionStarted = false,
    hostStopped = true, hostDisposed = true, assemblies, observations }, new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never }));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class OnlyChannelController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) { foreach (var item in feature.Controllers.Where(value => value.AsType() != typeof(ChannelsController)).ToArray()) feature.Controllers.Remove(item); }
}
public class ChannelAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = Request.Headers["X-Identity"].ToString(); if (identity == "anonymous") return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, (identity == "apiKey").ToString()) };
        if (identity != "apiKey") claims.Add(new Claim(InternalClaimTypes.UserId, "cf100000000000000000000000000001"));
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
            if (error is not null) entries.Add(new { category, type = error.GetType().Name, error.Message, error.StackTrace });
        }
    }
}
