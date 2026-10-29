using System.Globalization;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
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
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US"); CultureInfo.CurrentUICulture = CultureInfo.CurrentCulture;
var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
var userId = Guid.Parse(input.GetProperty("userId").GetString()!);
var parentId = Guid.Parse(input.GetProperty("parentId").GetString()!);
var user = new User("trailer-binding", "controlled", "controlled") { Id = userId };
var lookups = new List<string>(); var libraryCalls = new List<object>(); var queries = new List<object>();
var bindings = new List<object>(); var diagnostics = new List<object>();
void Capture(InternalItemsQuery query) => queries.Add(new {
    UserId = query.User?.Id.ToString("N"), IncludeItemTypes = query.IncludeItemTypes.Select(value => value.ToString()).ToArray(),
    query.IndexNumber, LinkedChildAncestorIds = query.LinkedChildAncestorIds.Select(value => value.ToString("N")).ToArray(),
    query.StartIndex, query.Limit, query.ParentId, query.Recursive,
    Fields = query.DtoOptions.Fields.Select(value => value.ToString()).ToArray(),
    query.EnableTotalRecordCount, query.DtoOptions.EnableImages, query.DtoOptions.EnableUserData,
    query.DtoOptions.ImageTypeLimit, ImageTypes = query.DtoOptions.ImageTypes?.Select(value => value.ToString()).ToArray()
});
var folder = new ControlledRoot(Capture) { Id = parentId, Name = "Controlled empty trailer root" };
var users = Stub.Make<IUserManager>((method, values) => {
    if (method.Name == "GetUserById") { var id = (Guid)values![0]!; lookups.Add(id.ToString("N")); return id == userId ? user : null; }
    return Stub.Default(method.ReturnType);
});
var library = Stub.Make<ILibraryManager>((method, values) => {
    if (method.Name == "GetParentItem") {
        libraryCalls.Add(new { operation = method.Name, parentId = ((Guid?)values![0])?.ToString("N"), userId = ((Guid?)values[1])?.ToString("N") });
        return folder;
    }
    if (method.Name == "GetUserRootFolder") return folder;
    if (method.Name == "GetItemsResult") { var query = (InternalItemsQuery)values![0]!; Capture(query); return new QueryResult<BaseItem>(query.StartIndex, 0, []); }
    if (method.Name == "GetArtist") { libraryCalls.Add(new { operation = method.Name, name = (string)values![0]! }); return new MusicArtist { Id = userId, Name = (string)values[0]! }; }
    if (method.Name == "GetStudio") { libraryCalls.Add(new { operation = method.Name, name = (string)values![0]! }); return new Studio { Id = parentId, Name = (string)values[0]! }; }
    if (method.Name == "GetItemIds") { libraryCalls.Add(new { operation = method.Name, query = ((InternalItemsQuery)values![0]!).Name }); return Array.Empty<Guid>(); }
    throw new InvalidOperationException("Unexpected controlled library operation: " + method.Name);
});
var dto = Stub.Make<IDtoService>((method, _) => method.Name == "GetBaseItemDtos" ? Array.Empty<BaseItemDto>() : Stub.Default(method.ReturnType));
var search = Stub.Make<ISearchManager>((method, values) => {
    if (method.Name == "GetSearchResultsAsync") {
        var query = (SearchProviderQuery)values![0]!;
        libraryCalls.Add(new { operation = method.Name, query.SearchTerm, IncludeItemTypes = query.IncludeItemTypes.Select(value => value.ToString()).ToArray() });
        return Task.FromResult<IReadOnlyList<SearchResult>>([]);
    }
    return Stub.Default(method.ReturnType);
});
var localization = Stub.Make<ILocalizationManager>((method, values) => {
    if (method.Name == "GetRatingScore") return (string)values![0]! == "PG" ? new ParentalRatingScore(5, null)
        : (string)values[0]! == "PG-13" ? new ParentalRatingScore(7, null) : null;
    return Stub.Default(method.ReturnType);
});
var configuration = new ServerConfiguration { IsStartupWizardCompleted = true };
var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration" ? configuration : Stub.Default(method.ReturnType));
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.Logging.AddProvider(new DiagnosticProvider(diagnostics)); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(users); builder.Services.AddSingleton(library); builder.Services.AddSingleton(dto); builder.Services.AddSingleton(search);
builder.Services.AddSingleton(localization); builder.Services.AddSingleton(config); builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton(Stub.Make<ISessionManager>((method, _) => Stub.Default(method.ReturnType)));
builder.Services.AddSingleton(Stub.Make<IUserDataManager>((method, _) => Stub.Default(method.ReturnType)));
builder.Services.AddSingleton(Stub.Make<INetworkManager>((method, _) => method.Name == "IsInLocalNetwork" ? true : Stub.Default(method.ReturnType)));
builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, TrailerAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(value => value.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement()).Build());
builder.Services.AddJellyfinApi([], new NetworkConfiguration())
    .AddMvcOptions(value => value.Filters.Add(new BindingObserver(bindings)))
    .ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlyTrailerControllers()));
var app = builder.Build(); var observations = new List<object>(); using var client = new HttpClient();
var previousLibrary = BaseItem.LibraryManager; BaseItem.LibraryManager = library;
try {
    app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
    var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
    foreach (var sample in input.GetProperty("requests").EnumerateArray()) {
        lookups.Clear(); libraryCalls.Clear(); queries.Clear(); bindings.Clear(); diagnostics.Clear();
        using var request = new HttpRequestMessage(HttpMethod.Get, address + sample.GetProperty("path").GetString());
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        request.Headers.TryAddWithoutValidation("X-Identity", sample.TryGetProperty("identity", out var identity) ? identity.GetString() : "admin");
        if (sample.TryGetProperty("body", out var suppliedBody)) request.Content = new StringContent(suppliedBody.GetString()!, Encoding.UTF8,
            sample.TryGetProperty("contentType", out var contentType) ? contentType.GetString()! : "application/json");
        using var response = await client.SendAsync(request); var body = await response.Content.ReadAsStringAsync(); JsonElement? json = null;
        try { json = JsonSerializer.Deserialize<JsonElement>(body); } catch (JsonException) { }
        observations.Add(new { name = sample.GetProperty("name").GetString(), path = sample.GetProperty("path").GetString(),
            status = (int)response.StatusCode, body, json, contentType = response.Content.Headers.ContentType?.ToString(),
            bindings = bindings.ToArray(), queries = queries.ToArray(), lookups = lookups.ToArray(), libraryCalls = libraryCalls.ToArray(), diagnostics = diagnostics.ToArray() });
    }
} finally {
    try { await app.StopAsync(); } finally { await app.DisposeAsync(); BaseItem.LibraryManager = previousLibrary; }
}
var assemblies = new[] { typeof(TrailersController).Assembly, typeof(InternalItemsQuery).Assembly, typeof(QueryResult<>).Assembly }.Distinct()
    .Select(value => new { filename = value.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(value.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
    actualMvc = true, actualTrailersController = true, actualInjectedItemsController = true, actualCollectionBinders = true,
    actualDefaultAuthorization = true, actualExceptionMiddleware = true, controllerContextAssignedByFixture = false,
    controlled = new { emptyFolder = true, library = true, userLookup = true, emptyDto = true, emptySearchResults = true,
        artistId = userId.ToString("N"), studioId = parentId.ToString("N"), albumIds = Array.Empty<Guid>(), ratingScores = new { PG = 5, PG13 = 7 } },
    mediaExecutionStarted = false, hostStopped = true, hostDisposed = true, assemblies, observations },
    new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never }));

public class ControlledRoot(Action<InternalItemsQuery> capture) : UserRootFolder {
    protected override QueryResult<BaseItem> GetItemsInternal(InternalItemsQuery query) {
        capture(query); return new QueryResult<BaseItem>(query.StartIndex, 0, []);
    }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class BindingObserver(List<object> entries) : IAsyncActionFilter {
    private static object? Value(object? value) {
        if (value is null) return null;
        if (value is Guid id) return id.ToString("N");
        if (value is DateTime date) return new { utcTicks = date.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) };
        if (value is Enum enumeration) return enumeration.ToString();
        if (value is Array array) return array.Cast<object?>().Select(Value).ToArray();
        return value;
    }
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next) {
        var injected = context.Controller is TrailersController
            ? typeof(TrailersController).GetField("_itemsController", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(context.Controller) as ItemsController : null;
        entries.Add(new { controller = context.Controller.GetType().Name,
            injectedItemsControllerHasHttpContext = injected?.HttpContext is not null,
            arguments = context.ActionArguments.ToDictionary(pair => pair.Key, pair => Value(pair.Value)) });
        await next();
    }
}
public class OnlyTrailerControllers : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var item in feature.Controllers.Where(value => value.AsType() != typeof(TrailersController) && value.AsType() != typeof(ItemsController)).ToArray()) feature.Controllers.Remove(item);
    }
}
public class TrailerAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = Request.Headers["X-Identity"].ToString(); if (identity == "anonymous") return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, (identity == "apiKey").ToString()) };
        if (identity != "apiKey") claims.Add(new Claim(InternalClaimTypes.UserId, "cf200000000000000000000000000001"));
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
