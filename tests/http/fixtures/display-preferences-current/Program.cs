using System.Net;
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
using Jellyfin.Server.Implementations.Users;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Configuration;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

// Only the supplied RID's real SQLite library is admitted; no host fallback.
var nativeName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var nativeFilename = Path.Combine(AppContext.BaseDirectory, nativeName);
var nativeHandle = NativeLibrary.Load(nativeFilename);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly,
    (name, _, _) => name == "e_sqlite3" ? nativeHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var mode = args[0];
if (mode is not ("http" or "snapshot")) throw new ArgumentException("Expected http or snapshot mode.");
var inputBytes = File.ReadAllBytes(args[1]);
var samples = JsonDocument.Parse(inputBytes).RootElement;
var outputFilename = Path.GetFullPath(args[2]);
var sourceFilename = Path.GetFullPath(args[3]);
var sourceHash = PrivateDatabase.Hash(sourceFilename);
var capture = new Capture(Path.Combine(Path.GetDirectoryName(outputFilename)!, "states"), sourceFilename);
object observation;
if (mode == "snapshot") {
    observation = SnapshotObservation.Run(capture);
} else {
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(capture); builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton(capture.Users); builder.Services.AddSingleton(capture.Network);
builder.Services.AddSingleton(Stub.Make<IServerConfigurationManager>((m, a) => m.Name is "get_Configuration" or "get_CommonConfiguration" ? new ServerConfiguration() : Stub.Default(m.ReturnType)));
builder.Services.AddSingleton<IDisplayPreferencesManager>(capture.Manager);
builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { });
builder.Services.AddAuthorization(options => options.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement()).Build());
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(manager => manager.FeatureProviders.Add(new OnlyDisplayController()));
var app = builder.Build();
var results = new List<object>(); using var client = new HttpClient();
try {
    app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
    var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
    foreach (var sample in samples.EnumerateArray()) {
        capture.Reset(sample, results.Count); var before = capture.Snapshot(); var observations = new List<object>();
        foreach (var step in sample.TryGetProperty("steps", out var steps) ? steps.EnumerateArray().ToArray() : new[] { sample }) {
            using var request = new HttpRequestMessage(new HttpMethod(Capture.Text(step, "method") ?? "GET"), address + Capture.Text(step, "path"));
            request.Headers.TryAddWithoutValidation("Accept", "application/json");
            if (step.TryGetProperty("body", out var body)) { request.Content = new StringContent(body.GetString()!); request.Content.Headers.ContentType = new(Capture.Text(step, "contentType") ?? "application/json"); }
            using var response = await client.SendAsync(request); var text = await response.Content.ReadAsStringAsync();
            JsonElement? json = null; try { json = JsonSerializer.Deserialize<JsonElement>(text); } catch (JsonException) { }
            observations.Add(new { status = (int)response.StatusCode, body = text, json, contentType = response.Content.Headers.ContentType?.ToString(), allow = string.Join(", ", response.Content.Headers.Allow), state = capture.Snapshot() });
        }
        results.Add(new { name = Capture.Text(sample, "name"), before, observations, after = capture.Snapshot(), calls = capture.Calls.ToArray() });
    }
} finally { try { await app.StopAsync(); } finally { await app.DisposeAsync(); } }
observation = new { results, hostStopped = true, hostDisposed = true };
}
if (PrivateDatabase.Hash(sourceFilename) != sourceHash) throw new InvalidOperationException("The supplied stopped database changed.");
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location)).Select(a => new { name = a.GetName().Name, filename = a.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(a.Location))) }).OrderBy(a => a.name).ToArray();
var nativeLibraries = new[] { new { filename = nativeFilename, sha256 = PrivateDatabase.Hash(nativeFilename), loadedByExplicitResolver = true } };
File.WriteAllText(outputFilename, JsonSerializer.Serialize(new { mode, runtimeIdentifier = RuntimeInformation.RuntimeIdentifier, inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), sourceDatabaseSha256 = sourceHash,
    actualController = true, actualBinding = mode == "http", actualManager = true, actualEfSqlite = true, principalControlled = true,
    historicalRecordingReused = false, actualNativeServerStarted = false, prohibitedMediaExecution = false,
    databasePreparations = capture.Preparations, assemblies, nativeLibraries, observation }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Capture {
    public static Guid UserId(int index) => Guid.Parse($"df100000-0000-0000-0000-{index:000000000000}");
    public static string? Text(JsonElement value, string name) => value.TryGetProperty(name, out var field) ? field.GetString() : null;
    public static bool Flag(JsonElement value, string name) => value.TryGetProperty(name, out var field) && field.GetBoolean();
    public string Root, SourceFilename, DatabaseFile = ""; public JsonElement Sample; public List<object> Calls = new();
    public List<object> Preparations = new();
    public IUserManager Users; public INetworkManager Network; public IDisplayPreferencesManager Manager;
    public Capture(string root, string sourceFilename) {
        Root = root; SourceFilename = sourceFilename;
        Users = Stub.Make<IUserManager>((m, a) => m.Name == "GetUserById" ? new User("Alpha", "provider", "reset") : Stub.Default(m.ReturnType));
        Network = Stub.Make<INetworkManager>((m, a) => m.Name == "IsInLocalNetwork" ? true : Stub.Default(m.ReturnType));
        Manager = Stub.Make<IDisplayPreferencesManager>((m, a) => {
            Calls.Add(new { method = m.Name, arguments = a });
            return Stub.Forward(new DisplayPreferencesManager(new SqlFactory(DatabaseFile)), m, a);
        });
    }
    public void Reset(JsonElement sample, int index) {
        Sample = sample; Calls.Clear(); var root = Path.Combine(Root, index.ToString()); Directory.CreateDirectory(root); DatabaseFile = Path.Combine(root, "native.db");
        Preparations.Add(PrivateDatabase.Clone(SourceFilename, DatabaseFile));
        using var db = new SqlFactory(DatabaseFile).CreateDbContext();
        foreach (var id in new[] { UserId(1), UserId(2) }) { var user = new User(id.ToString(), "provider", "reset"); typeof(User).GetProperty("Id")!.SetValue(user, id); db.Users.Add(user); }
        db.SaveChanges();
        if (sample.TryGetProperty("seed", out var seed)) foreach (var command in seed.EnumerateArray()) db.Database.ExecuteSqlRaw(command.GetString()!);
        if (sample.TryGetProperty("fail", out var fail)) {
            var name = fail.GetString();
            var target = name switch { "custom-insert" => ("CustomItemDisplayPreferences", "INSERT"), "custom-delete" => ("CustomItemDisplayPreferences", "DELETE"), "item-update" => ("ItemDisplayPreferences", "UPDATE"), "display-update" => ("DisplayPreferences", "UPDATE"), "home-insert" => ("HomeSection", "INSERT"), _ => ("DisplayPreferences", "INSERT") };
            db.Database.ExecuteSqlRaw($"CREATE TRIGGER controlled_failure BEFORE {target.Item2} ON {target.Item1} BEGIN SELECT RAISE(ABORT, 'Controlled database failure'); END");
        }
    }
    public object Snapshot() {
        using var connection = new SqliteConnection($"Data Source={DatabaseFile};Pooling=False"); connection.Open();
        return new[] { "DisplayPreferences", "ItemDisplayPreferences", "CustomItemDisplayPreferences", "HomeSection" }.ToDictionary(table => table, table => {
            using var command = connection.CreateCommand(); command.CommandText = $"SELECT * FROM {table} ORDER BY Id"; using var reader = command.ExecuteReader(); var rows = new List<Dictionary<string, object?>>();
            while (reader.Read()) rows.Add(Enumerable.Range(0, reader.FieldCount).ToDictionary(i => reader.GetName(i), i => reader.IsDBNull(i) ? null : reader.GetValue(i))); return rows;
        });
    }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite(new SqliteConnectionStringBuilder { DataSource = filename, Pooling = false, ForeignKeys = true }.ToString()).Options, NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}

public static class PrivateDatabase {
    public static string Hash(string filename) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename)));
    static string Digest(object value) => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value)));
    static object[][] Rows(SqliteConnection connection, string sql) {
        using var command = connection.CreateCommand(); command.CommandText = sql; using var reader = command.ExecuteReader();
        var rows = new List<object[]>();
        while (reader.Read()) rows.Add(Enumerable.Range(0, reader.FieldCount).Select(i => reader.IsDBNull(i) ? null! : reader.GetValue(i)).ToArray());
        return rows.ToArray();
    }
    public static object Clone(string source, string destination) {
        if (string.Equals(Path.GetFullPath(source), Path.GetFullPath(destination), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("A fresh private database is required.");
        File.Copy(source, destination, overwrite: false);
        var sourceSha256 = Hash(source); var cloneSha256 = Hash(destination);
        if (sourceSha256 != cloneSha256) throw new InvalidOperationException("The stopped database clone is not byte-identical.");
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = destination, Pooling = false, ForeignKeys = false }.ToString()); connection.Open();
        const string schemaSql = "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
        const string historySql = "SELECT MigrationId, ProductVersion FROM __EFMigrationsHistory ORDER BY MigrationId";
        var schema = Rows(connection, schemaSql); var history = Rows(connection, historySql);
        if (history.Length == 0) throw new InvalidOperationException("The actual migrated schema is required.");
        var tables = Rows(connection, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__EFMigrationsHistory' ORDER BY name").Select(row => (string)row[0]).ToArray();
        var hasSequence = Rows(connection, "SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'").Length != 0;
        using (var transaction = connection.BeginTransaction()) {
            foreach (var table in tables) {
                using var command = connection.CreateCommand(); command.Transaction = transaction;
                command.CommandText = "DELETE FROM \"" + table.Replace("\"", "\"\"") + "\""; command.ExecuteNonQuery();
            }
            if (hasSequence) {
                using var command = connection.CreateCommand(); command.Transaction = transaction; command.CommandText = "DELETE FROM sqlite_sequence"; command.ExecuteNonQuery();
            }
            transaction.Commit();
        }
        var schemaSha256 = Digest(schema); var historySha256 = Digest(history);
        var schemaPreserved = schemaSha256 == Digest(Rows(connection, schemaSql)); var historyPreserved = historySha256 == Digest(Rows(connection, historySql));
        if (!schemaPreserved || !historyPreserved) throw new InvalidOperationException("Private data preparation must preserve the real schema and migration history.");
        bool managerForeignKeysEnabled;
        using (var managerDb = new SqlFactory(destination).CreateDbContext()) {
            managerDb.Database.OpenConnection(); using var command = managerDb.Database.GetDbConnection().CreateCommand(); command.CommandText = "PRAGMA foreign_keys";
            managerForeignKeysEnabled = Convert.ToInt64(command.ExecuteScalar()) == 1;
        }
        if (!managerForeignKeysEnabled) throw new InvalidOperationException("Real manager connections must enforce foreign keys.");
        return new { filename = destination, sourceSha256, cloneSha256, schemaSha256, historySha256, schemaPreserved, historyPreserved,
            migrationCount = history.Length, clearedTables = tables, resetIntegerIdentities = true, ensureCreatedUsed = false, managerForeignKeysEnabled };
    }
}

public static class SnapshotObservation {
    public static object Run(Capture capture) {
        using var sample = JsonDocument.Parse("{}"); capture.Reset(sample.RootElement, 0);
        var factory = new SqlFactory(capture.DatabaseFile); var userId = Capture.UserId(1);
        var itemId = Guid.Parse("3ce5b65d-e116-d731-65d1-efc4a30ec35c");
        using (var db = factory.CreateDbContext()) {
            var preferences = new DisplayPreferences(userId, itemId, "emby");
            preferences.HomeSections.Add(new HomeSection { Order = 0, Type = HomeSectionType.Resume });
            db.DisplayPreferences.Add(preferences); db.SaveChanges();
        }
        var before = capture.Snapshot(); var manager = new DisplayPreferencesManager(factory); var changed = false;
        var proxy = Stub.Make<IDisplayPreferencesManager>((method, arguments) => {
            if (method.Name == "GetItemDisplayPreferences" && !changed) {
                changed = true; using var db = factory.CreateDbContext();
                db.DisplayPreferences.Single().ShowBackdrop = false; db.Set<HomeSection>().Single().Type = HomeSectionType.LatestMedia; db.SaveChanges();
            }
            return Stub.Forward(manager, method, arguments);
        });
        var controller = new DisplayPreferencesController(proxy, NullLogger<DisplayPreferencesController>.Instance) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(new[] {
                new Claim(InternalClaimTypes.UserId, userId.ToString("N")), new Claim(ClaimTypes.Role, UserRoles.Administrator)
            }, "snapshot")) } }
        };
        var dto = controller.GetDisplayPreferences("usersettings", userId, "emby").Value!;
        var after = capture.Snapshot(); var current = controller.GetDisplayPreferences("usersettings", userId, "emby").Value!;
        return new { mutationBeforeItemLookup = changed, actual = new { dto.ShowBackdrop, home = dto.CustomPrefs["homesection0"] },
            current = new { current.ShowBackdrop, home = current.CustomPrefs["homesection0"] }, before, after, afterCurrentRead = capture.Snapshot() };
    }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? m, object?[]? a) => Handler(m!, a);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var proxy = Create<T, Stub>(); ((Stub)(object)proxy).Handler = handler; return proxy; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? args) { try { return method.Invoke(target, args); } catch (TargetInvocationException error) { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; } }
}
public class OnlyDisplayController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) { foreach (var controller in feature.Controllers.Where(t => t.AsType() != typeof(DisplayPreferencesController)).ToArray()) feature.Controllers.Remove(controller); }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        if (Capture.Flag(capture.Sample, "anonymous")) return Task.FromResult(AuthenticateResult.NoResult());
        var apiKey = Capture.Flag(capture.Sample, "apiKey");
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, apiKey.ToString()) };
        if (!apiKey) claims.Add(new Claim(InternalClaimTypes.UserId, Capture.UserId(1).ToString("N")));
        if (apiKey || !Capture.Flag(capture.Sample, "regular")) claims.Add(new Claim(ClaimTypes.Role, UserRoles.Administrator));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name)), Scheme.Name)));
    }
}
