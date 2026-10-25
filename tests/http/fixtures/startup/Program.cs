using System.Net;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.Cryptography;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Api.Auth.FirstTimeSetupPolicy;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Data;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Extensions;
using Jellyfin.Server.Implementations.Users;
using MediaBrowser.Common;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
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

if (args[0] == "read-config") {
    var manifest = File.ReadAllBytes(args[1]);
    var rows = JsonDocument.Parse(manifest).RootElement.EnumerateArray().Select(entry => {
        object? system = null, network = null;
        try { system = Capture.Settings((ServerConfiguration)new MyXmlSerializer().DeserializeFromBytes(typeof(ServerConfiguration), Convert.FromBase64String(entry.GetProperty("system").GetString()!))!); } catch { }
        try { var value = (NetworkConfiguration)new MyXmlSerializer().DeserializeFromBytes(typeof(NetworkConfiguration), Convert.FromBase64String(entry.GetProperty("network").GetString()!))!; network = new { value.EnableRemoteAccess, value.BaseUrl }; } catch { }
        return new { name = entry.GetProperty("name").GetString(), disk = system, networkDisk = network };
    }).ToArray();
    File.WriteAllText(args[2], JsonSerializer.Serialize(new { actualNativeReader = true, manifestSha256 = Convert.ToHexStringLower(SHA256.HashData(manifest)), rows }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
    return;
}

SQLitePCL.Batteries_V2.Init();
var inputBytes = File.ReadAllBytes(args[0]);
var capture = new Capture(Path.Combine(Path.GetDirectoryName(args[1])!, "states"));
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(capture); builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton(capture.ConfigurationProxy); builder.Services.AddSingleton<IConfigurationManager>(capture.ConfigurationProxy);
builder.Services.AddSingleton(capture.UserProxy); builder.Services.AddSingleton(capture.Network);
builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, FirstTimeSetupHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { })
    .AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>(Jellyfin.Api.Constants.AuthenticationSchemes.CustomAuthentication, _ => { });
builder.Services.AddAuthorization(options => options.AddPolicy(Policies.FirstTimeSetupOrElevated,
    new AuthorizationPolicyBuilder("fixture").AddRequirements(new FirstTimeSetupRequirement()).Build()));
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(manager => manager.FeatureProviders.Add(new OnlyStartupController()));
var app = builder.Build();
app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var results = new List<object>(); using var client = new HttpClient();
try {
    foreach (var sample in JsonDocument.Parse(inputBytes).RootElement.EnumerateArray()) {
        capture.Reset(sample, results.Count); var before = capture.Snapshot(); var observations = new List<object>();
        foreach (var step in sample.TryGetProperty("steps", out var steps) ? steps.EnumerateArray().ToArray() : new[] { sample }) {
            using var request = new HttpRequestMessage(new HttpMethod(Capture.Text(step, "method") ?? "GET"), address + Capture.Text(step, "path"));
            request.Headers.TryAddWithoutValidation("Accept", "application/json");
            if (step.TryGetProperty("body", out var body)) { request.Content = new StringContent(body.GetString()!); request.Content.Headers.ContentType = new(Capture.Text(step, "contentType") ?? "application/json"); }
            using var response = await client.SendAsync(request); var text = await response.Content.ReadAsStringAsync();
            JsonElement? json = null; try { json = JsonSerializer.Deserialize<JsonElement>(text); } catch (JsonException) { }
            observations.Add(new { status = (int)response.StatusCode, body = text, json, contentType = response.Content.Headers.ContentType?.ToString(),
                allow = string.Join(", ", response.Content.Headers.Allow), state = capture.Snapshot() });
        }
        results.Add(new { name = Capture.Text(sample, "name"), before, observations, after = capture.Snapshot(), calls = capture.Calls.ToArray(), events = capture.Events.ToArray() });
        capture.Release();
    }
} finally { capture.Release(); await app.StopAsync(); await app.DisposeAsync(); }
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location)).Select(a => new { name = a.GetName().Name, filename = a.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(a.Location))) }).OrderBy(a => a.name).ToArray();
var nativeLibraries = System.Diagnostics.Process.GetCurrentProcess().Modules.Cast<System.Diagnostics.ProcessModule>().Where(m => m.ModuleName.Equals("e_sqlite3.dll", StringComparison.OrdinalIgnoreCase)).Select(m => new { filename = m.FileName, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(m.FileName))) }).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), environmentUserName = Environment.UserName,
    actualController = true, actualBinding = true, actualAuthorizationHandlers = true, actualUserManager = true, actualEfSqlite = true, actualConfigurationManager = true,
    principalControlled = true, networkControlled = true, eventConsumerControlled = true, caseFoldExceptions = Capture.CaseFoldExceptions(), assemblies, nativeLibraries, results }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Capture {
    public string Root, DatabaseFile = "";
    public JsonElement Sample;
    public ServerApplicationPaths Paths = null!;
    public ServerConfigurationManager Configuration = null!;
    public IServerConfigurationManager ConfigurationProxy;
    public UserManager Manager = null!;
    public IUserManager UserProxy;
    public INetworkManager Network;
    public CryptographyProvider Crypto = new();
    public List<object> Calls = new(), Events = new();
    public Dictionary<Guid, string?> OriginalPasswords = new();
    public static Guid Id(int index) => Guid.Parse($"e5100000-0000-0000-0000-{index:000000000000}");
    public static string? Text(JsonElement value, string key) => value.TryGetProperty(key, out var entry) ? entry.GetString() : null;
    public static bool Flag(JsonElement value, string key) => value.TryGetProperty(key, out var entry) && entry.GetBoolean();
    public Capture(string root) {
        Root = root;
        ConfigurationProxy = Stub.Make<IServerConfigurationManager>((m, a) => Stub.Forward(Configuration, m, a));
        UserProxy = Stub.Make<IUserManager>((m, a) => {
            if (m.Name is "InitializeAsync" or "GetFirstUser" or "UpdateUserAsync" or "RenameUser" or "ChangePassword") Calls.Add(new { method = m.Name });
            return Stub.Forward(Manager, m, a);
        });
        Network = Stub.Make<INetworkManager>((m, a) => m.Name == "IsInLocalNetwork" ? !Flag(Sample, "remote") : Stub.Default(m.ReturnType));
    }
    public void Reset(JsonElement sample, int index) {
        Manager?.Dispose(); Sample = sample; Calls.Clear(); Events.Clear(); OriginalPasswords.Clear();
        var root = Path.Combine(Root, index.ToString()); Directory.CreateDirectory(root);
        Paths = new ServerApplicationPaths(Path.Combine(root, "program"), Path.Combine(root, "log"), Path.Combine(root, "config"), Path.Combine(root, "cache"), Path.Combine(root, "web"));
        Directory.CreateDirectory(Paths.ConfigurationDirectoryPath);
        var settings = new ServerConfiguration { ServerName = "Initial", UICulture = "en-US", MetadataCountryCode = "US", PreferredMetadataLanguage = "en", IsStartupWizardCompleted = Flag(sample, "completed") };
        new MyXmlSerializer().SerializeToFile(settings, Paths.SystemConfigurationFilePath);
        new MyXmlSerializer().SerializeToFile(new NetworkConfiguration { EnableRemoteAccess = true, BaseUrl = "/media" }, Path.Combine(Paths.ConfigurationDirectoryPath, "network.xml"));
        Configuration = new ServerConfigurationManager(Paths, NullLoggerFactory.Instance, new MyXmlSerializer());
        Configuration.RegisterConfiguration<NetworkConfigurationFactory>();
        _ = Configuration.Configuration; _ = Configuration.GetNetworkConfiguration();
        DatabaseFile = Path.Combine(root, "native.db"); var factory = new SqlFactory(DatabaseFile);
        var appHost = Stub.Empty<IApplicationHost>();
        var events = Stub.Make<IEventManager>((m, a) => {
            if (m.Name == "PublishAsync") {
                var user = (User)a![0]!.GetType().GetProperty("Argument")!.GetValue(a[0])!;
                var name = a[0]!.GetType().Name.Replace("EventArgs", ""); Events.Add(new { name, userId = user.Id.ToString("N"), username = user.Username });
                if (Text(Sample, "fail") == "event-" + name) return Task.FromException(new IOException("Controlled event failure"));
            }
            return Stub.Default(m.ReturnType);
        });
        Manager = new UserManager(factory, events, Network, appHost, Stub.Empty<IImageProcessor>(), NullLogger<UserManager>.Instance, Configuration,
            new IPasswordResetProvider[] { new DefaultPasswordResetProvider(Configuration, appHost) },
            new IAuthenticationProvider[] { new DefaultAuthenticationProvider(NullLogger<DefaultAuthenticationProvider>.Instance, Crypto), new InvalidAuthProvider() });
        using (var db = factory.CreateDbContext()) {
            db.Database.EnsureCreated();
            if (sample.TryGetProperty("users", out var users)) foreach (var entry in users.EnumerateArray()) {
                var number = entry.GetProperty("index").GetInt32();
                var user = new User(Text(entry, "name") ?? "Alpha", typeof(DefaultAuthenticationProvider).FullName!, typeof(DefaultPasswordResetProvider).FullName!) {
                    Id = Id(number), InternalId = entry.TryGetProperty("internalId", out var internalId) ? internalId.GetInt64() : number,
                    Password = Text(entry, "password") is string password ? Crypto.CreatePasswordHash(password).ToString() : null };
                user.AddDefaultPermissions(); user.AddDefaultPreferences(); user.SetPermission(PermissionKind.IsAdministrator, Flag(entry, "admin"));
                user.SetPermission(PermissionKind.EnableRemoteAccess, !Flag(sample, "denyRemote"));
                user.AccessSchedules.Add(new(DynamicDayOfWeek.Sunday, 1, 2, user.Id));
                db.Users.Add(user); db.SaveChanges(); OriginalPasswords[user.Id] = user.Password;
            }
            if (Text(sample, "fail") == "save-user") db.Database.ExecuteSqlRaw("CREATE TRIGGER fail_startup_save BEFORE DELETE ON AccessSchedules BEGIN SELECT RAISE(ABORT, 'Controlled user save failure'); END");
            if (Text(sample, "fail") == "rename") db.Database.ExecuteSqlRaw("CREATE TRIGGER fail_startup_rename BEFORE UPDATE OF Username ON Users WHEN NEW.Username IS NOT OLD.Username BEGIN SELECT RAISE(ABORT, 'Controlled rename failure'); END");
            if (Text(sample, "fail") == "password") db.Database.ExecuteSqlRaw("CREATE TRIGGER fail_startup_password BEFORE UPDATE OF Password ON Users WHEN NEW.Password IS NOT OLD.Password BEGIN SELECT RAISE(ABORT, 'Controlled password failure'); END");
        }
        if (Flag(sample, "readOnlySystem")) File.SetAttributes(Paths.SystemConfigurationFilePath, FileAttributes.ReadOnly);
        if (Flag(sample, "readOnlyNetwork")) File.SetAttributes(Path.Combine(Paths.ConfigurationDirectoryPath, "network.xml"), FileAttributes.ReadOnly);
    }
    public void Release() {
        if (Paths is null) return;
        foreach (var name in new[] { "system.xml", "network.xml" }) { var file = Path.Combine(Paths.ConfigurationDirectoryPath, name); if (File.Exists(file)) File.SetAttributes(file, FileAttributes.Normal); }
    }
    public static object Settings(ServerConfiguration value) => new { value.ServerName, value.UICulture, value.MetadataCountryCode, value.PreferredMetadataLanguage, value.IsStartupWizardCompleted };
    public static Dictionary<string, string> CaseFoldExceptions() {
        var parent = Enumerable.Range(0, 65536).ToArray();
        int Find(int value) { while (parent[value] != value) value = parent[value]; return value; }
        void Join(char left, char right) { if (string.Equals(left.ToString(), right.ToString(), StringComparison.InvariantCultureIgnoreCase)) parent[Find(right)] = Find(left); }
        for (var number = 0; number <= 65535; number++) { var value = (char)number; if (char.IsSurrogate(value)) continue; Join(value, char.ToUpperInvariant(value)); Join(value, char.ToLowerInvariant(value)); }
        var groups = Enumerable.Range(0, 65536).Where(n => !char.IsSurrogate((char)n)).GroupBy(Find);
        var exceptions = new Dictionary<string, string>();
        foreach (var group in groups) {
            var first = (char)group.Min(); var canonical = char.ToLowerInvariant(first);
            if (!group.Contains(canonical)) canonical = first;
            foreach (var number in group) if (char.ToLowerInvariant((char)number) != canonical) exceptions[((char)number).ToString()] = canonical.ToString();
        }
        return exceptions;
    }
    public object Snapshot() {
        using var connection = new SqliteConnection($"Data Source={DatabaseFile};Pooling=False"); connection.Open();
        var tables = new[] { "Users", "Permissions", "Preferences", "AccessSchedules", "ImageInfos" }.ToDictionary(table => table, table => {
            using var command = connection.CreateCommand(); command.CommandText = $"SELECT * FROM {table} ORDER BY Id"; using var reader = command.ExecuteReader(); var rows = new List<Dictionary<string, object?>>();
            while (reader.Read()) rows.Add(Enumerable.Range(0, reader.FieldCount).ToDictionary(i => reader.GetName(i), i => reader.IsDBNull(i) ? null : reader.GetValue(i)));
            return rows;
        });
        object? disk = null, networkDisk = null;
        try { disk = Settings((ServerConfiguration)new MyXmlSerializer().DeserializeFromFile(typeof(ServerConfiguration), Paths.SystemConfigurationFilePath)); } catch { }
        try { var value = (NetworkConfiguration)new MyXmlSerializer().DeserializeFromFile(typeof(NetworkConfiguration), Path.Combine(Paths.ConfigurationDirectoryPath, "network.xml")); networkDisk = new { value.EnableRemoteAccess, value.BaseUrl }; } catch { }
        return new { tables, live = Settings(Configuration.Configuration), disk, networkLive = new { Configuration.GetNetworkConfiguration().EnableRemoteAccess, Configuration.GetNetworkConfiguration().BaseUrl }, networkDisk };
    }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? m, object?[]? a) => Handler(m!, a);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> h) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = h; return value; }
    public static T Empty<T>() where T : class => Make<T>((m, a) => Default(m.ReturnType));
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo m, object?[]? a) { try { return m.Invoke(target, a); } catch (TargetInvocationException e) { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(e.InnerException!).Throw(); throw; } }
}
public class OnlyStartupController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var controller in feature.Controllers.Where(t => t.AsType() != typeof(StartupController)).ToArray()) feature.Controllers.Remove(controller);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = Capture.Text(capture.Sample, "identity") ?? "anonymous";
        if (identity == "anonymous") return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim> { new(ClaimTypes.Role, identity is "admin" or "api" ? UserRoles.Administrator : UserRoles.User) };
        if (identity == "api") claims.Add(new(InternalClaimTypes.IsApiKey, "True"));
        else claims.Add(new(InternalClaimTypes.UserId, Capture.Id(1).ToString("N")));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name)), Scheme.Name)));
    }
}
