using System.Net;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using Emby.Server.Implementations.Cryptography;
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
using MediaBrowser.Common;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Net;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Devices;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.QuickConnect;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Cryptography;
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
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

SQLitePCL.Batteries_V2.Init();
var bytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(bytes).RootElement;
var capture = new Capture(Path.Combine(Path.GetDirectoryName(args[1])!, "states"));
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton(capture); builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton(capture.Configuration); builder.Services.AddSingleton(capture.UserProxy); builder.Services.AddSingleton(capture.Network);
builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>("fixture", _ => { })
    .AddScheme<AuthenticationSchemeOptions, FixtureAuthentication>(Jellyfin.Api.Constants.AuthenticationSchemes.CustomAuthentication, _ => { });
builder.Services.AddAuthorization(options => {
    options.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement()).Build();
    options.AddPolicy(Policies.RequiresElevation, new AuthorizationPolicyBuilder("fixture").RequireClaim(ClaimTypes.Role, UserRoles.Administrator).Build());
    options.AddPolicy(Policies.IgnoreParentalControl, new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement(false)).Build());
});
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(manager => manager.FeatureProviders.Add(new OnlyResetControllers()));
builder.Services.Replace(ServiceDescriptor.Transient<UserController>(_ => new UserController(capture.UserProxy, Stub.Empty<ISessionManager>(), capture.Network,
    Stub.Empty<IDeviceManager>(), Stub.Empty<IAuthorizationContext>(), capture.Configuration, NullLogger<UserController>.Instance,
    Stub.Empty<IQuickConnect>(), Stub.Empty<IPlaylistManager>())));
builder.Services.Replace(ServiceDescriptor.Transient<SessionController>(_ => new SessionController(Stub.Empty<ISessionManager>(), capture.UserProxy)));
var app = builder.Build();
app.Use(async (context, next) => {
    if (Capture.Flag(capture.Sample, "remote")) context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.9");
    if (Capture.Flag(capture.Sample, "sameAddress")) context.Connection.LocalIpAddress = context.Connection.RemoteIpAddress;
    await next();
});
app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var results = new List<object>(); using var client = new HttpClient();
try {
    foreach (var sample in input.EnumerateArray()) {
        capture.Reset(sample, results.Count); var before = capture.Snapshot(); var beforeFiles = capture.Files(); var observations = new List<object>();
        var steps = Capture.Text(sample, "mode") == "snapshot" ? Array.Empty<JsonElement>() : sample.TryGetProperty("steps", out var sequence) ? sequence.EnumerateArray().ToArray() : new[] { sample };
        if (Capture.Text(sample, "mode") == "snapshot") {
            var started = DateTime.UtcNow; var status = 200;
            try { await capture.SaveSnapshot(); } catch { status = 500; }
            observations.Add(new { status, body = status == 200 ? "" : "Error processing request.", json = (object?)null,
                contentType = (string?)null, allow = "", hasJson = false, started, finished = DateTime.UtcNow, files = capture.Files() });
        }
        foreach (var step in steps) {
            var started = DateTime.UtcNow;
            string Expand(string text) => !text.Contains("$pin", StringComparison.Ordinal) ? text : text.Replace("$pinCompact", capture.GeneratedPin()?.Replace("-", "")).Replace("$pin", capture.GeneratedPin());
            using var request = new HttpRequestMessage(new HttpMethod(Capture.Text(step, "method") ?? "POST"), address + Capture.Text(step, "path"));
            request.Headers.TryAddWithoutValidation("Accept", "application/json");
            if (step.TryGetProperty("body", out var payload)) {
                request.Content = new StringContent(Expand(payload.GetString()!)); request.Content.Headers.ContentType = new(Capture.Text(step, "contentType") ?? "application/json");
            }
            using var response = await client.SendAsync(request); var body = await response.Content.ReadAsStringAsync();
            JsonElement? json = null; var hasJson = false; try { json = JsonSerializer.Deserialize<JsonElement>(body); hasJson = true; } catch (JsonException) { }
            observations.Add(new { status = (int)response.StatusCode, body, json, contentType = response.Content.Headers.ContentType?.ToString(),
                allow = string.Join(", ", response.Content.Headers.Allow), hasJson, started, finished = DateTime.UtcNow, files = capture.Files() });
        }
        results.Add(new { name = Capture.Text(sample, "name"), capture.ProgramData, capture.DatabaseFile, before, beforeFiles, after = capture.Snapshot(), observations,
            events = capture.Events.ToArray(), calls = capture.Calls.ToArray(), passwordChecks = capture.PasswordChecks(),
            catalogs = new { authentication = capture.Manager.GetAuthenticationProviders(), reset = capture.Manager.GetPasswordResetProviders() } });
    }
} finally { capture.Manager?.Dispose(); await app.StopAsync(); await app.DisposeAsync(); }
var assemblies = new[] { typeof(DefaultPasswordResetProvider).Assembly, typeof(UserManager).Assembly, typeof(CryptographyProvider).Assembly,
    typeof(UserController).Assembly, typeof(JellyfinDbContext).Assembly, typeof(SqliteDatabaseProvider).Assembly, typeof(PasswordHash).Assembly,
    typeof(SqliteConnection).Assembly, typeof(SQLitePCL.Batteries_V2).Assembly }.Distinct().Select(a =>
    new { name = a.GetName().Name, filename = a.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(a.Location))) }).OrderBy(a => a.name).ToArray();
var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqliteFile = Path.Combine(AppContext.BaseDirectory, sqliteName);
var sqliteNative = new { filename = sqliteFile, name = sqliteName, runtimeIdentifier = System.Runtime.InteropServices.RuntimeInformation.RuntimeIdentifier,
    sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(sqliteFile))) };
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), actualExecution = true, actualController = true, actualBinding = true,
    actualUserManager = true, actualDefaultProvider = true, actualEfSqlite = true, actualCrypto = true, eventsControlled = true, networkControlled = true,
    actualNativeInstance = false, assemblies, sqliteNative, results }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Capture {
    public static Guid Id(int index) => Guid.Parse($"ce200000-0000-0000-0000-{index:000000000000}");
    public static string? Text(JsonElement value, string key) => value.TryGetProperty(key, out var v) ? v.GetString() : null;
    public static bool Flag(JsonElement value, string key) => value.TryGetProperty(key, out var v) && v.GetBoolean();
    public string Root, ProgramData = "", DatabaseFile = ""; public JsonElement Sample;
    public List<object> Events = new(); public List<string> Calls = new(); public List<string> Passwords = new();
    public Dictionary<Guid, string?> OriginalPasswords = new(); public UserManager Manager = null!;
    public IServerConfigurationManager Configuration; public INetworkManager Network; public IUserManager UserProxy;
    public CryptographyProvider Crypto = new();
    private readonly string[] _initialPasswordHashes;
    public Capture(string root) {
        Root = root;
        // Each process independently prepares real hashes for its controlled initial rows.
        // Case databases remain independent; provider changes and every verification stay real.
        _initialPasswordHashes = Enumerable.Range(0, 2)
            .Select(_ => Crypto.CreatePasswordHash("initial password").ToString()).ToArray();
        var paths = Stub.Make<IServerApplicationPaths>((m, a) => m.Name == "get_ProgramDataPath" ? ProgramData : Stub.Default(m.ReturnType));
        Configuration = Stub.Make<IServerConfigurationManager>((m, a) => m.Name is "get_Configuration" or "get_CommonConfiguration" ? new ServerConfiguration() : m.Name == "get_ApplicationPaths" ? paths : Stub.Default(m.ReturnType));
        Network = Stub.Make<INetworkManager>((m, a) => m.Name == "IsInLocalNetwork" ? !Flag(Sample, "remote") : Stub.Default(m.ReturnType));
        UserProxy = Stub.Make<IUserManager>((m, a) => {
            if (m.Name is "StartForgotPasswordProcess" or "RedeemPasswordResetPin") Calls.Add(m.Name);
            if (m.Name == "RedeemPasswordResetPin") Passwords.Add((string)a![0]!);
            return Stub.Forward(Manager, m, a);
        });
    }
    public void Reset(JsonElement sample, int index) {
        Manager?.Dispose(); Sample = sample; Events.Clear(); Calls.Clear(); Passwords.Clear(); OriginalPasswords.Clear();
        var root = Path.Combine(Root, index.ToString()); Directory.CreateDirectory(root); ProgramData = Path.Combine(root, "program");
        if (!Flag(sample, "missingRoot")) Directory.CreateDirectory(ProgramData);
        DatabaseFile = Path.Combine(root, "native.db"); var factory = new SqlFactory(DatabaseFile);
        var appHost = Stub.Make<IApplicationHost>((m, a) => m.Name == "Resolve" && m.IsGenericMethod && m.GetGenericArguments()[0] == typeof(IUserManager) ? Manager : Stub.Default(m.ReturnType));
        var provider = new DefaultPasswordResetProvider(Configuration, appHost);
        var events = Stub.Make<IEventManager>((m, a) => {
            if (m.Name == "PublishAsync" && a![0]!.GetType().Name == "UserPasswordChangedEventArgs") {
                var user = (User)a[0]!.GetType().GetProperty("Argument")!.GetValue(a[0])!; Events.Add(new { name = "UserPasswordChanged", userId = user.Id.ToString("N") });
                if (Text(Sample, "fail") == "password-event") return Task.FromException(new IOException("Controlled event failure"));
            }
            return Stub.Default(m.ReturnType);
        });
        Manager = new UserManager(factory, events, Network, appHost, Stub.Empty<IImageProcessor>(), NullLogger<UserManager>.Instance, Configuration,
            new[] { provider }, new IAuthenticationProvider[] { new DefaultAuthenticationProvider(NullLogger<DefaultAuthenticationProvider>.Instance, Crypto), new InvalidAuthProvider() });
        using (var db = factory.CreateDbContext()) {
            db.Database.EnsureCreated();
            foreach (var number in new[] { 1, 2 }) {
                var user = new User(number == 1 ? Text(sample, "username") ?? "Alpha" : "Beta", typeof(DefaultAuthenticationProvider).FullName!, typeof(DefaultPasswordResetProvider).FullName!) {
                    Id = Id(number), InternalId = number, InvalidLoginAttemptCount = 3, LastLoginDate = DateTime.UnixEpoch,
                    Password = _initialPasswordHashes[number - 1] };
                if (number == 1) {
                    if (sample.TryGetProperty("authProvider", out var auth)) user.AuthenticationProviderId = auth.GetString()!;
                    if (sample.TryGetProperty("resetProvider", out var reset)) user.PasswordResetProviderId = reset.GetString()!;
                    if (Flag(sample, "schedules")) { user.AccessSchedules.Add(new(DynamicDayOfWeek.Everyday, 1, 2, user.Id)); user.AccessSchedules.Add(new(DynamicDayOfWeek.Sunday, 3, 4, user.Id)); }
                    user.Preferences.Add(new(PreferenceKind.AllowedTags, "kept-中文"));
                    user.ProfileImage = new("%AppDataPath%/avatar.png") { LastModified = DateTime.UnixEpoch };
                }
                user.Permissions.Add(new(PermissionKind.IsAdministrator, false)); user.Permissions.Add(new(PermissionKind.EnableRemoteAccess, true));
                OriginalPasswords[user.Id] = user.Password; db.Users.Add(user);
            }
            db.SaveChanges();
            if (Text(sample, "fail") == "save-user") db.Database.ExecuteSqlRaw("CREATE TRIGGER fail_reset_user BEFORE DELETE ON AccessSchedules BEGIN SELECT RAISE(ABORT, 'Controlled user save failure'); END");
            if (Text(sample, "fail") == "change-password") db.Database.ExecuteSqlRaw("CREATE TRIGGER fail_reset_password BEFORE UPDATE OF Password ON Users BEGIN SELECT RAISE(ABORT, 'Controlled password failure'); END");
            if (Text(sample, "fail") == "snapshot") db.Database.ExecuteSqlRaw("CREATE TRIGGER fail_snapshot BEFORE UPDATE ON Users BEGIN SELECT RAISE(ABORT, 'Controlled snapshot failure'); END");
        }
        if (sample.TryGetProperty("files", out var files)) foreach (var file in files.EnumerateArray()) {
            var filename = Path.Combine(ProgramData, Text(file, "name")!);
            if (Flag(file, "directory")) { Directory.CreateDirectory(filename); continue; }
            File.WriteAllText(filename, Text(file, "text")!);
            if (Flag(file, "readOnly")) File.SetAttributes(filename, File.GetAttributes(filename) | FileAttributes.ReadOnly);
        }
        if (Flag(sample, "targetDirectory")) Directory.CreateDirectory(Path.Combine(ProgramData, "passwordreset" + "ALPHA".GetMD5().ToString("N") + ".json"));
    }
    public async Task SaveSnapshot() {
        var source = Manager.GetUserById(Id(1))!;
        if (Flag(Sample, "freshChange")) {
            using var db = new SqlFactory(DatabaseFile).CreateDbContext();
            db.Database.ExecuteSqlRaw("UPDATE Users SET Username='Outside', NormalizedUsername='OUTSIDE', RowVersion=9 WHERE Username='Alpha'");
            db.Database.ExecuteSqlRaw("UPDATE Permissions SET Value=0, RowVersion=5 WHERE UserId='CE200000-0000-0000-0000-000000000001' AND Kind=4");
            db.Database.ExecuteSqlRaw("UPDATE Preferences SET Value='outside', RowVersion=7");
            db.Database.ExecuteSqlRaw("UPDATE ImageInfos SET Path='outside-avatar.png'");
        }
        if (Flag(Sample, "sourceFields")) {
            source.Username = "Renamed"; source.NormalizedUsername = "RENAMED"; source.EnableAutoLogin = true;
            source.LastLoginDate = new DateTime(2020, 2, 3, 4, 5, 6, DateTimeKind.Utc).AddTicks(1234567);
            source.Permissions.Clear(); source.Permissions.Add(new((PermissionKind)83, true)); source.Permissions.Add(new((PermissionKind)83, false));
            source.Preferences.Clear(); source.Preferences.Add(new((PreferenceKind)42, "future-中文")); source.ProfileImage = null;
        }
        if (Flag(Sample, "sourceImage")) source.ProfileImage = new("%MetadataPath%/new.png") { LastModified = new DateTime(2021, 1, 1, 0, 0, 0, DateTimeKind.Utc) };
        Calls.Add("UpdateUserAsync"); await Manager.UpdateUserAsync(source);
    }
    public string? GeneratedPin() {
        foreach (var file in Files()) {
            if (!file.TryGetValue("text", out var raw)) continue;
            try { var value = JsonDocument.Parse((string)raw!).RootElement; if (value.TryGetProperty("Pin", out var pin)) return pin.GetString(); } catch (JsonException) { }
        }
        return null;
    }
    public object Snapshot() {
        using var connection = new SqliteConnection($"Data Source={DatabaseFile};Pooling=False"); connection.Open();
        return new[] { "Users", "Permissions", "Preferences", "AccessSchedules", "ImageInfos" }.ToDictionary(table => table, table => {
            using var command = connection.CreateCommand(); command.CommandText = $"SELECT * FROM {table} ORDER BY Id"; using var reader = command.ExecuteReader(); var rows = new List<Dictionary<string, object?>>();
            while (reader.Read()) rows.Add(Enumerable.Range(0, reader.FieldCount).ToDictionary(i => reader.GetName(i), i => reader.IsDBNull(i) ? null : reader.GetValue(i)));
            return rows;
        });
    }
    public Dictionary<string, object?>[] Files() => !Directory.Exists(ProgramData) ? [] : Directory.EnumerateFileSystemEntries(ProgramData).Select(filename => {
        var result = new Dictionary<string, object?> { ["name"] = Path.GetFileName(filename), ["directory"] = Directory.Exists(filename) };
        if (!Directory.Exists(filename)) { result["text"] = File.ReadAllText(filename); result["bytesBase64"] = Convert.ToBase64String(File.ReadAllBytes(filename));
            result["readOnly"] = (File.GetAttributes(filename) & FileAttributes.ReadOnly) != 0; }
        return result;
    }).ToArray();
    public object[] PasswordChecks() {
        using var connection = new SqliteConnection($"Data Source={DatabaseFile};Pooling=False"); connection.Open();
        using var command = connection.CreateCommand(); command.CommandText = "SELECT Id, Password FROM Users ORDER BY Id";
        using var reader = command.ExecuteReader(); var results = new List<object>();
        while (reader.Read()) {
            var id = Guid.Parse(reader.GetString(0)); var password = reader.IsDBNull(1) ? null : reader.GetString(1);
            results.Add(new { id = id.ToString("N"), changed = password != OriginalPasswords[id],
                initialMatches = password != null && Crypto.Verify(PasswordHash.Parse(password), "initial password"),
                pinMatches = Passwords.Distinct().Where(pin => password != null && Crypto.Verify(PasswordHash.Parse(password), pin)).ToArray() });
        }
        return results.ToArray();
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
public class OnlyResetControllers : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var controller in feature.Controllers.Where(t => t.AsType() != typeof(UserController) && t.AsType() != typeof(SessionController)).ToArray()) feature.Controllers.Remove(controller);
    }
}
public class FixtureAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, Capture capture)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() => Task.FromResult(Capture.Flag(capture.Sample, "anonymous") ? AuthenticateResult.NoResult() : AuthenticateResult.Success(
        new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(InternalClaimTypes.IsApiKey, "True"), new Claim(ClaimTypes.Role, UserRoles.Administrator) }, Scheme.Name)), Scheme.Name)));
}
