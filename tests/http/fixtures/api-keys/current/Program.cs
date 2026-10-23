using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Extensions;
using Jellyfin.Server.Implementations.Security;
using MediaBrowser.Common.Net;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Security;
using MediaBrowser.Model.Configuration;
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

var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqliteFilename = Path.Combine(AppContext.BaseDirectory, sqliteName);
var sqliteHandle = NativeLibrary.Load(sqliteFilename);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly,
    (name, _, _) => name == "e_sqlite3" ? sqliteHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var inputBytes = File.ReadAllBytes(args[0]);
var capture = new Capture(Path.Combine(Path.GetDirectoryName(args[1])!, "states"));
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(capture); builder.Services.AddSingleton(capture.Manager);
builder.Services.AddSingleton(Stub.Make<IServerConfigurationManager>((method, arguments) =>
    method.Name is "get_Configuration" or "get_CommonConfiguration" ? new ServerConfiguration() : null));
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { })
    .AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>(Jellyfin.Api.Constants.AuthenticationSchemes.CustomAuthentication, _ => { });
builder.Services.AddAuthorization(options => options.AddPolicy(Policies.RequiresElevation, policy =>
    policy.AddAuthenticationSchemes(Jellyfin.Api.Constants.AuthenticationSchemes.CustomAuthentication).RequireClaim(ClaimTypes.Role, UserRoles.Administrator)));
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(manager => manager.FeatureProviders.Add(new OnlyApiKeyController()));
var app = builder.Build();
app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var results = new List<object>(); using var client = new HttpClient();
try {
    foreach (var sample in JsonDocument.Parse(inputBytes).RootElement.EnumerateArray()) {
        capture.Reset(sample, results.Count); var before = capture.Snapshot(); var observations = new List<object>();
        foreach (var step in sample.TryGetProperty("steps", out var steps) ? steps.EnumerateArray().ToArray() : new[] { sample }) {
            var path = Capture.Text(step, "path")!;
            if (step.TryGetProperty("generated", out var generated)) {
                var token = capture.Tokens()[generated.GetInt32()];
                if (step.TryGetProperty("uppercase", out var uppercase) && uppercase.GetBoolean()) token = token.ToUpperInvariant();
                path = path.Replace("{key}", token);
            }
            using var request = new HttpRequestMessage(new HttpMethod(Capture.Text(step, "method") ?? "GET"), address + path);
            request.Headers.TryAddWithoutValidation("Accept", Capture.Text(step, "accept") ?? "application/json");
            if (step.TryGetProperty("body", out var body)) { request.Content = new StringContent(body.GetString()!); request.Content.Headers.ContentType = new(Capture.Text(step, "contentType") ?? "application/json"); }
            var started = DateTime.UtcNow;
            using var response = await client.SendAsync(request); var text = await response.Content.ReadAsStringAsync();
            var completed = DateTime.UtcNow;
            JsonElement? json = null; try { json = JsonSerializer.Deserialize<JsonElement>(text); } catch (JsonException) { }
            observations.Add(new { status = (int)response.StatusCode, body = text, json, contentType = response.Content.Headers.ContentType?.ToString(),
                allow = string.Join(", ", response.Content.Headers.Allow), state = capture.Snapshot(), started, completed });
        }
        results.Add(new { name = Capture.Text(sample, "name"), before, observations, after = capture.Snapshot(), calls = capture.Calls.ToArray() });
        File.AppendAllText(Path.Combine(Path.GetDirectoryName(args[1])!, "progress.jsonl"), JsonSerializer.Serialize(results.Last()) + "\n");
    }
} finally { await app.StopAsync(); await app.DisposeAsync(); }
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location)).Select(a => new { name = a.GetName().Name, filename = a.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(a.Location))) }).OrderBy(a => a.name).ToArray();
var nativeLibraries = new[] { new { filename = sqliteFilename, runtimeIdentifier = RuntimeInformation.RuntimeIdentifier, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(sqliteFilename))) } };
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), actualController = true, actualBinding = true,
    actualManager = true, actualEfSqlite = true, principalControlled = true, assemblies, nativeLibraries, results }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Capture {
    public static string? Text(JsonElement value, string name) => value.TryGetProperty(name, out var field) ? field.GetString() : null;
    public string Root, DatabaseFile = ""; public JsonElement Sample; public List<object> Calls = new();
    public IAuthenticationManager Manager;
    public Capture(string root) {
        Root = root;
        Manager = Stub.Make<IAuthenticationManager>((method, arguments) => {
            Calls.Add(new { method = method.Name, arguments });
            return Stub.Forward(new AuthenticationManager(new SqlFactory(DatabaseFile)), method, arguments);
        });
    }
    public void Reset(JsonElement sample, int index) {
        Sample = sample; Calls.Clear(); var root = Path.Combine(Root, index.ToString()); Directory.CreateDirectory(root); DatabaseFile = Path.Combine(root, "native.db");
        using var db = new SqlFactory(DatabaseFile).CreateDbContext(); db.Database.EnsureCreated();
        if (sample.TryGetProperty("seed", out var seed)) foreach (var command in seed.EnumerateArray()) db.Database.ExecuteSqlRaw(command.GetString()!);
        if (sample.TryGetProperty("fail", out var fail)) {
            var operation = fail.GetString() == "delete" ? "DELETE" : "INSERT";
            db.Database.ExecuteSqlRaw($"CREATE TRIGGER controlled_failure BEFORE {operation} ON ApiKeys BEGIN SELECT RAISE(ABORT, 'Controlled database failure'); END");
        }
    }
    public object Snapshot() {
        using var connection = new SqliteConnection($"Data Source={DatabaseFile};Pooling=False"); connection.Open();
        using var command = connection.CreateCommand(); command.CommandText = "SELECT * FROM ApiKeys ORDER BY Id";
        using var reader = command.ExecuteReader(); var rows = new List<Dictionary<string, object?>>();
        while (reader.Read()) rows.Add(Enumerable.Range(0, reader.FieldCount).ToDictionary(i => reader.GetName(i), i => reader.IsDBNull(i) ? null : reader.GetValue(i)));
        return rows;
    }
    public string[] Tokens() {
        using var connection = new SqliteConnection($"Data Source={DatabaseFile};Pooling=False"); connection.Open();
        using var command = connection.CreateCommand(); command.CommandText = "SELECT AccessToken FROM ApiKeys ORDER BY Id";
        using var reader = command.ExecuteReader(); var rows = new List<string>(); while (reader.Read()) rows.Add(reader.GetString(0)); return rows.ToArray();
    }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? arguments) => Handler(method!, arguments);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var proxy = Create<T, Stub>(); ((Stub)(object)proxy).Handler = handler; return proxy; }
    public static object? Forward(object target, MethodInfo method, object?[]? arguments) {
        try { return method.Invoke(target, arguments); }
        catch (TargetInvocationException error) { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; }
    }
}
public class OnlyApiKeyController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var controller in feature.Controllers.Where(type => type.AsType() != typeof(ApiKeyController)).ToArray()) feature.Controllers.Remove(controller);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = Capture.Text(capture.Sample, "identity") ?? "admin";
        if (identity == "anonymous") return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim> { new(ClaimTypes.Role, identity is "admin" or "api" ? UserRoles.Administrator : UserRoles.User) };
        if (identity == "api") claims.Add(new(InternalClaimTypes.IsApiKey, "True"));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name)), Scheme.Name)));
    }
}
