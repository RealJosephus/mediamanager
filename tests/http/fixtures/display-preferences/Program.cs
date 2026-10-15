using System.Net;
using System.Reflection;
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
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

SQLitePCL.Batteries_V2.Init();
var inputBytes = File.ReadAllBytes(args[0]);
var samples = JsonDocument.Parse(inputBytes).RootElement;
var capture = new Capture(Path.Combine(Path.GetDirectoryName(args[1])!, "states"));
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
app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var results = new List<object>(); using var client = new HttpClient();
try {
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
} finally { await app.StopAsync(); await app.DisposeAsync(); }
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location)).Select(a => new { name = a.GetName().Name, filename = a.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(a.Location))) }).OrderBy(a => a.name).ToArray();
var nativeLibraries = System.Diagnostics.Process.GetCurrentProcess().Modules.Cast<System.Diagnostics.ProcessModule>().Where(m => m.ModuleName.Equals("e_sqlite3.dll", StringComparison.OrdinalIgnoreCase)).Select(m => new { filename = m.FileName, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(m.FileName))) }).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), actualController = true, actualBinding = true, actualManager = true, actualEfSqlite = true, principalControlled = true, assemblies, nativeLibraries, results }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Capture {
    public static Guid UserId(int index) => Guid.Parse($"df100000-0000-0000-0000-{index:000000000000}");
    public static string? Text(JsonElement value, string name) => value.TryGetProperty(name, out var field) ? field.GetString() : null;
    public static bool Flag(JsonElement value, string name) => value.TryGetProperty(name, out var field) && field.GetBoolean();
    public string Root, DatabaseFile = ""; public JsonElement Sample; public List<object> Calls = new();
    public IUserManager Users; public INetworkManager Network; public IDisplayPreferencesManager Manager;
    public Capture(string root) {
        Root = root;
        Users = Stub.Make<IUserManager>((m, a) => m.Name == "GetUserById" ? new User("Alpha", "provider", "reset") : Stub.Default(m.ReturnType));
        Network = Stub.Make<INetworkManager>((m, a) => m.Name == "IsInLocalNetwork" ? true : Stub.Default(m.ReturnType));
        Manager = Stub.Make<IDisplayPreferencesManager>((m, a) => {
            Calls.Add(new { method = m.Name, arguments = a });
            return Stub.Forward(new DisplayPreferencesManager(new SqlFactory(DatabaseFile)), m, a);
        });
    }
    public void Reset(JsonElement sample, int index) {
        Sample = sample; Calls.Clear(); var root = Path.Combine(Root, index.ToString()); Directory.CreateDirectory(root); DatabaseFile = Path.Combine(root, "native.db");
        using var db = new SqlFactory(DatabaseFile).CreateDbContext(); db.Database.EnsureCreated();
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
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options, NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
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
