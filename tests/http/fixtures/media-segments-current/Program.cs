using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Extensions;
using Jellyfin.Server.Implementations.MediaSegments;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Model;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.MediaSegments;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US"); CultureInfo.CurrentUICulture = CultureInfo.CurrentCulture;
var nativeName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var nativeFilename = Path.Combine(AppContext.BaseDirectory, nativeName); var nativeHandle = NativeLibrary.Load(nativeFilename);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) => name == "e_sqlite3" ? nativeHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var inputBytes = File.ReadAllBytes(args[0]); using var document = JsonDocument.Parse(inputBytes); var input = document.RootElement;
var sourceHash = Hash(args[3]); var filename = Path.Combine(args[2], "native.db"); Directory.CreateDirectory(args[2]); File.Copy(args[3], filename, false);
var factory = new SqlFactory(filename);
if (args[4] is not ("seed" or "read")) throw new ArgumentException("Use seed or read for the controlled data mode.");
if (args[4] == "seed") using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false }.ToString())) {
    connection.Open(); using var clear = connection.CreateCommand(); clear.CommandText = "DELETE FROM MediaSegments"; clear.ExecuteNonQuery();
    foreach (var row in input.GetProperty("rows").EnumerateArray()) {
        using var insert = connection.CreateCommand(); insert.CommandText = "INSERT INTO MediaSegments(Id,ItemId,Type,StartTicks,EndTicks,SegmentProviderId) VALUES($id,$item,$type,$start,$end,$provider)";
        insert.Parameters.AddWithValue("$id", Guid.Parse(row.GetProperty("id").GetString()!).ToString().ToUpperInvariant());
        insert.Parameters.AddWithValue("$item", Guid.Parse(row.GetProperty("itemId").GetString()!).ToString().ToUpperInvariant());
        insert.Parameters.AddWithValue("$type", row.GetProperty("type").GetInt32());
        insert.Parameters.AddWithValue("$start", long.Parse(row.GetProperty("startTicks").GetString()!, CultureInfo.InvariantCulture));
        insert.Parameters.AddWithValue("$end", long.Parse(row.GetProperty("endTicks").GetString()!, CultureInfo.InvariantCulture));
        var provider = row.GetProperty("provider").GetString()!.ToLowerInvariant();
        insert.Parameters.AddWithValue("$provider", new Guid(MD5.HashData(System.Text.Encoding.Unicode.GetBytes(provider))).ToString("N")); insert.ExecuteNonQuery();
    }
}
var capture = new Capture(input); var itemId = Guid.Parse(input.GetProperty("itemId").GetString()!); var hiddenId = Guid.Parse(input.GetProperty("hiddenId").GetString()!);
var userId = Guid.Parse(input.GetProperty("userId").GetString()!); var readerId = Guid.Parse(input.GetProperty("readerId").GetString()!);
var admin = new User("admin", "controlled", "controlled") { Id = userId }; var reader = new User("reader", "controlled", "controlled") { Id = readerId };
var users = Stub.Make<IUserManager>((method, values) => method.Name == "GetUserById" ? ((Guid)values![0]! == readerId ? reader : admin) : Stub.Default(method.ReturnType));
var library = Stub.Make<ILibraryManager>((method, values) => {
    if (method.Name == "GetItemById") {
        var id = (Guid)values![0]!; if (id == Guid.Empty) throw new ArgumentException("Guid can't be empty.", "id");
        if (id != itemId && id != hiddenId || id == hiddenId && (Guid)values[1]! == readerId) return null;
        return new Movie { Id = id, Name = "Controlled segments" };
    }
    if (method.Name == "GetLibraryOptions") return new LibraryOptions { DisabledMediaSegmentProviders = capture.Sample.TryGetProperty("disabled", out var disabled) ? disabled.ValueKind == JsonValueKind.Null ? null! : disabled.EnumerateArray().Select(value => value.GetString()!).ToArray() : [] };
    throw new InvalidOperationException("Unexpected library operation: " + method.Name);
});
var segments = Stub.Make<IMediaSegmentManager>((method, values) => {
    if (method.Name != "GetSegmentsAsync") throw new InvalidOperationException("Media execution is forbidden: " + method.Name);
    var providers = capture.Sample.TryGetProperty("providers", out var supplied) ? supplied.EnumerateArray().Select(value => value.GetString()!).ToArray() : new[] { "Control Primary", "Secondary" };
    var manager = new MediaSegmentManager(NullLogger<MediaSegmentManager>.Instance, factory, providers.Select(name => new ReadProvider(name)));
    return manager.GetSegmentsAsync((BaseItem?)values![0], (IEnumerable<MediaSegmentType>?)values[1], (LibraryOptions)values[2]!, (bool)values[3]!);
});
var configuration = new ServerConfiguration { IsStartupWizardCompleted = true };
var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration" ? configuration : Stub.Default(method.ReturnType));
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" }); builder.Logging.ClearProviders(); builder.Logging.AddProvider(new Diagnostics(capture)); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(capture); builder.Services.AddSingleton(library); builder.Services.AddSingleton(users); builder.Services.AddSingleton(segments); builder.Services.AddSingleton(config); builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton(Stub.Make<INetworkManager>((method, _) => method.Name == "IsInLocalNetwork" ? true : Stub.Default(method.ReturnType)));
builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(value => value.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement()).Build());
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlyController()));
var before = ReadRows(factory); var app = builder.Build(); var results = new List<object>(); using var client = new HttpClient();
try {
    app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
    var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
    foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
        capture.Sample = sample; using var request = new HttpRequestMessage(new HttpMethod(sample.TryGetProperty("method", out var method) ? method.GetString()! : "GET"), address + sample.GetProperty("path").GetString());
        request.Headers.TryAddWithoutValidation("Accept", sample.TryGetProperty("accept", out var accept) ? accept.GetString() : "application/json");
        using var response = await client.SendAsync(request); var body = await response.Content.ReadAsStringAsync();
        results.Add(new { name = sample.GetProperty("name").GetString(), status = (int)response.StatusCode, body, contentType = response.Content.Headers.ContentType?.ToString(), allow = string.Join(",", response.Content.Headers.Allow) });
    }
} finally { try { await app.StopAsync(); } finally { await app.DisposeAsync(); } }
var after = ReadRows(factory); if (before != after || sourceHash != Hash(args[3])) throw new InvalidOperationException("Media segment reads changed their persisted input.");
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Hash(args[0]), sourceSha256 = sourceHash, before, after, results,
    actualMvc = true, actualController = true, actualManager = true, actualEfSqlite = true, controlledLibraryAndPrincipal = true, diagnostics = capture.Errors,
    providerMethodsInvoked = false, hostStopped = true, hostDisposed = true, databaseFilename = filename,
    assemblies = new[] { typeof(MediaSegmentsController).Assembly, typeof(MediaSegmentManager).Assembly, typeof(JellyfinDbContext).Assembly }.Distinct().Select(value => new { filename = value.Location, sha256 = Hash(value.Location) }) }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static string Hash(string filename) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename)));
static string ReadRows(SqlFactory factory) { using var db = factory.CreateDbContext(); return JsonSerializer.Serialize(db.MediaSegments.OrderBy(row => row.Id).AsNoTracking().ToArray()); }
public class Capture(JsonElement input) { public JsonElement Input = input; public JsonElement Sample; public List<object> Errors = []; }
public class ReadProvider(string name) : IMediaSegmentProvider {
    public string Name => name;
    public Task<IReadOnlyList<MediaSegmentDto>> GetMediaSegments(MediaSegmentGenerationRequest request, CancellationToken token) => throw new InvalidOperationException("Generation is forbidden.");
    public ValueTask<bool> Supports(BaseItem item) => throw new InvalidOperationException("Support analysis is forbidden.");
    public Task CleanupExtractedData(Guid id, CancellationToken token) => throw new InvalidOperationException("Cleanup is forbidden.");
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false, ForeignKeys = true }.ToString()).Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!; protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class OnlyController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) { foreach (var item in feature.Controllers.Where(value => value.AsType() != typeof(MediaSegmentsController)).ToArray()) feature.Controllers.Remove(item); }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = capture.Sample.TryGetProperty("identity", out var entry) ? entry.GetString() : "admin"; if (identity == "anonymous") return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, (identity == "apiKey").ToString()) };
        if (identity != "apiKey") claims.Add(new(InternalClaimTypes.UserId, capture.Input.GetProperty(identity == "regular" ? "readerId" : "userId").GetString()!));
        if (identity != "regular") claims.Add(new(ClaimTypes.Role, UserRoles.Administrator));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name)), Scheme.Name)));
    }
}
public class Diagnostics(Capture capture) : ILoggerProvider {
    public ILogger CreateLogger(string category) => new EntryLogger(capture, category); public void Dispose() { }
    public class EntryLogger(Capture capture, string category) : ILogger {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
            if (error is not null) capture.Errors.Add(new { category, type = error.GetType().Name, error.Message, error.StackTrace });
        }
    }
}
