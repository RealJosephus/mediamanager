using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Extensions;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Lyrics;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.Lyric;
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

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
var nativeName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var nativeHandle = NativeLibrary.Load(Path.Combine(AppContext.BaseDirectory, nativeName));
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) => name == "e_sqlite3" ? nativeHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var inputBytes = File.ReadAllBytes(args[0]); using var document = JsonDocument.Parse(inputBytes); var input = document.RootElement;
Directory.CreateDirectory(args[2]); var filename = Path.Combine(args[2], "native.db"); var sourceHash = Hash(args[3]); File.Copy(args[3], filename, false);
var factory = new SqlFactory(filename);
using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false, ForeignKeys = true }.ToString())) {
    connection.Open(); using var transaction = connection.BeginTransaction();
    foreach (var table in input.GetProperty("databaseRows").EnumerateArray()) foreach (var row in table.GetProperty("rows").EnumerateArray()) {
        using var command = connection.CreateCommand(); command.Transaction = transaction;
        var properties = row.EnumerateObject().ToArray();
        command.CommandText = "INSERT INTO \"" + table.GetProperty("name").GetString() + "\" (" + string.Join(",", properties.Select(value => "\"" + value.Name + "\"")) + ") VALUES (" + string.Join(",", properties.Select((_, index) => "$p" + index)) + ")";
        for (var index = 0; index < properties.Length; index++) {
            var property = properties[index]; var value = property.Value;
            object parameter = value.ValueKind switch { JsonValueKind.Null => DBNull.Value, JsonValueKind.True => 1, JsonValueKind.False => 0,
                JsonValueKind.Number => value.TryGetInt64(out var number) ? number : value.GetDouble(), _ => value.GetString()! };
            if ((property.Name is "Id" or "ItemId") && parameter is string text) parameter = Guid.Parse(text).ToString().ToUpperInvariant();
            command.Parameters.AddWithValue("$p" + index, parameter);
        }
        command.ExecuteNonQuery();
    }
    transaction.Commit();
}
var capture = new Capture(input);
var userId = Guid.Parse(input.GetProperty("userId").GetString()!); var readerId = Guid.Parse(input.GetProperty("readerId").GetString()!);
var admin = new User("admin", "controlled", "controlled") { Id = userId }; var reader = new User("reader", "controlled", "controlled") { Id = readerId };
var users = Boundary.Make<IUserManager>((method, values) => method.Name == "GetUserById" ? ((Guid)values![0]! == readerId ? reader : admin) : Boundary.Default(method.ReturnType));
var library = Boundary.Make<ILibraryManager>((method, values) => {
    if (method.Name != "GetItemById") throw new InvalidOperationException("Unexpected library operation: " + method.Name);
    var id = (Guid)values![0]!; if (id == Guid.Empty) throw new ArgumentException("Guid can't be empty.", "id");
    var definition = input.GetProperty("items").EnumerateArray().FirstOrDefault(value => Guid.Parse(value.GetProperty("id").GetString()!) == id);
    if (definition.ValueKind == JsonValueKind.Undefined || definition.GetProperty("type").GetString() == "Book"
        || definition.TryGetProperty("hidden", out var hidden) && hidden.GetBoolean() && (Guid)values[1]! == readerId) return null;
    Audio item = definition.GetProperty("type").GetString() == "AudioBook" ? new AudioBook() : new Audio();
    item.Id = id; item.Name = definition.GetProperty("name").GetString()!; item.Path = Path.Combine(input.GetProperty("mediaRoot").GetString()!, "unused.mp3"); return item;
});
var paths = new ServerApplicationPaths(Path.Combine(args[2], "program"), Path.Combine(args[2], "log"), Path.Combine(args[2], "config"), Path.Combine(args[2], "cache"), Path.Combine(args[2], "web"));
Directory.CreateDirectory(paths.ConfigurationDirectoryPath);
var serializer = new MyXmlSerializer(); serializer.SerializeToFile(new ServerConfiguration { IsStartupWizardCompleted = true }, Path.Combine(paths.ConfigurationDirectoryPath, "system.xml"));
var config = new ServerConfigurationManager(paths, NullLoggerFactory.Instance, serializer);
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
var localization = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
var appHost = Boundary.Make<IServerApplicationHost>((method, values) => method.Name == "ExpandVirtualPath"
    ? (values![0] as string)?.Replace("%AppDataPath%", input.GetProperty("dataPath").GetString()!, StringComparison.OrdinalIgnoreCase)
        .Replace("%MetadataPath%", input.GetProperty("metadataPath").GetString()!, StringComparison.OrdinalIgnoreCase)
    : throw new InvalidOperationException("Unexpected path host operation: " + method.Name));
var repository = new MediaStreamRepository(factory, appHost, localization);
using var mediaSources = new MediaSourceManager(appHost, null!, paths, localization, users, library, NullLogger<MediaSourceManager>.Instance, fileSystem, null!, null!, null!, repository, null!);
BaseItem.MediaSourceManager = mediaSources;
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.Logging.AddProvider(new Diagnostics(capture)); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(capture); builder.Services.AddSingleton(library); builder.Services.AddSingleton(users);
builder.Services.AddSingleton<IServerConfigurationManager>(config); builder.Services.AddSingleton<IFileSystem>(fileSystem);
builder.Services.AddSingleton(Boundary.Make<IProviderManager>((method, _) => throw new InvalidOperationException("Metadata mutation is forbidden: " + method.Name)));
builder.Services.AddHttpClient(); builder.Services.AddSingleton<ILyricManager>(services => new LyricManager(NullLogger<LyricManager>.Instance,
    fileSystem, null!, mediaSources, null!, services.GetRequiredService<IHttpClientFactory>(), [], [new LrcLyricParser(), new TxtLyricParser()]));
builder.Services.AddHttpContextAccessor(); builder.Services.AddSingleton(Boundary.Make<INetworkManager>((method, _) => method.Name == "IsInLocalNetwork" ? true : Boundary.Default(method.ReturnType)));
builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(value => value.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement()).Build());
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlyController()));
var before = Streams(factory, input); var app = builder.Build(); var results = new List<object>(); using var client = new HttpClient();
try {
    app.Use(async (context, next) => { var culture = capture.Sample.TryGetProperty("culture", out var value) ? value.GetString()! : "en-US"; CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(culture); CultureInfo.CurrentUICulture = CultureInfo.CurrentCulture; await next(); });
    app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
    var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
    foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
        capture.Sample = sample;
        using var request = new HttpRequestMessage(new HttpMethod(sample.TryGetProperty("method", out var method) ? method.GetString()! : "GET"), address + sample.GetProperty("path").GetString() + (sample.TryGetProperty("suffix", out var suffix) ? suffix.GetString() : ""));
        request.Headers.TryAddWithoutValidation("Accept", sample.TryGetProperty("accept", out var accept) ? accept.GetString() : "application/json");
        using var response = await client.SendAsync(request); results.Add(new { name = sample.GetProperty("name").GetString(), status = (int)response.StatusCode,
            contentType = response.Content.Headers.ContentType?.ToString(), body = await response.Content.ReadAsStringAsync() });
    }
} finally { try { await app.StopAsync(); } finally { await app.DisposeAsync(); } }
var after = Streams(factory, input); if (sourceHash != Hash(args[3])) throw new InvalidOperationException("The designated input changed.");
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Hash(args[0]), sourceSha256 = sourceHash, before, after, results,
    actualMvc = true, actualController = true, actualManager = true, actualParsers = true, actualMediaStreamRepository = true,
    actualEfSqlite = true, noLyricProviders = true, hostStopped = true, hostDisposed = true, diagnostics = capture.Errors,
    scope = "Real Native MVC/default policy, LyricsController, LyricManager, MediaSourceManager, EF MediaStreamRepository and installed LrcParser/TxtLyricParser. Controlled principal/library lookup and item visibility, application roots for path expansion, private source bytes/proxy headers. No full Native host authentication or provider/mutation claim.",
    assemblies = new[] { typeof(LyricsController).Assembly, typeof(LyricManager).Assembly, typeof(MediaStreamRepository).Assembly,
        typeof(MediaSourceManager).Assembly, typeof(JellyfinDbContext).Assembly, typeof(LrcParser.Parser.Lrc.LrcParser).Assembly }
        .Distinct().Select(value => new { filename = value.Location, sha256 = Hash(value.Location), version = value.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion })
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static string Hash(string filename) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename)));
static string Streams(SqlFactory factory, JsonElement input) {
    var ids = input.GetProperty("items").EnumerateArray().Select(value => Guid.Parse(value.GetProperty("id").GetString()!)).ToArray();
    using var db = factory.CreateDbContext(); return JsonSerializer.Serialize(db.MediaStreamInfos.Where(row => ids.Contains(row.ItemId)).OrderBy(row => row.ItemId).ThenBy(row => row.StreamIndex).AsNoTracking().ToArray());
}
public class Capture(JsonElement input) { public JsonElement Input = input; public JsonElement Sample; public List<object> Errors = []; }
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false, ForeignKeys = true }.ToString()).Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
public class Boundary : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!; protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Boundary>(); ((Boundary)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class OnlyController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) { foreach (var item in feature.Controllers.Where(value => value.AsType() != typeof(LyricsController)).ToArray()) feature.Controllers.Remove(item); }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = capture.Sample.TryGetProperty("identity", out var entry) ? entry.GetString() : "admin";
        if (identity is "anonymous" or "invalid") return Task.FromResult(AuthenticateResult.NoResult());
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
