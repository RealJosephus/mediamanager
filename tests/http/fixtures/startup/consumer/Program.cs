using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Cryptography;
using Jellyfin.Api.Controllers;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Users;
using MediaBrowser.Common;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Events;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Cryptography;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
var filename = Path.GetFullPath(args[0]);
var originalSha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename)));
var paths = Stub.Make<IServerApplicationPaths>((m, a) => m.Name == "get_ProgramDataPath" ? Path.GetDirectoryName(filename)! : Stub.Default(m.ReturnType));
var configuration = Stub.Make<IServerConfigurationManager>((m, a) => m.Name is "get_Configuration" or "get_CommonConfiguration" ? new ServerConfiguration()
    : m.Name == "get_ApplicationPaths" ? paths : Stub.Default(m.ReturnType));
var network = Stub.Make<INetworkManager>((m, a) => m.Name == "IsInLocalNetwork" ? true : Stub.Default(m.ReturnType));
var appHost = Stub.Empty<IApplicationHost>(); var crypto = new CryptographyProvider();
using var users = new UserManager(new SqlFactory(filename), Stub.Empty<IEventManager>(), network, appHost, Stub.Empty<IImageProcessor>(),
    NullLogger<UserManager>.Instance, configuration, new[] { new DefaultPasswordResetProvider(configuration, appHost) },
    new IAuthenticationProvider[] { new DefaultAuthenticationProvider(NullLogger<DefaultAuthenticationProvider>.Instance, crypto), new InvalidAuthProvider() });
var controller = new StartupController(configuration, users);
var first = users.GetFirstUser()!; var before = await controller.GetFirstUser(); var beforeOrder = Order();
if (first.Id != Guid.Parse(args[1])) throw new InvalidOperationException("Native first-user identity changed during exchange.");
var nodePasswordMatches = crypto.Verify(PasswordHash.Parse(first.Password!), "Node startup password");
if (!nodePasswordMatches) throw new InvalidOperationException("The native provider did not authenticate the candidate password.");
await users.RenameUser(first.Id, first.Username, "Native first");
await users.ChangePassword(first.Id, "Native startup password");
await users.DeleteUserAsync(Guid.Parse(args[2]));
var appended = await users.CreateUserAsync("Native appended");
var after = await controller.GetFirstUser(); var afterOrder = Order();
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location)).Select(a => new {
    name = a.GetName().Name, filename = a.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(a.Location))) }).OrderBy(a => a.name).ToArray();
File.WriteAllText(args[3], JsonSerializer.Serialize(new { originalSha256, actualController = true, actualUserManager = true, actualEfSqlite = true,
    nodePasswordMatches, before, beforeOrder, after, afterOrder, appendedUserId = appended.Id.ToString("N"), assemblies }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
string[] Order() {
    using var connection = new SqliteConnection($"Data Source={filename};Pooling=False"); connection.Open();
    using var command = connection.CreateCommand(); command.CommandText = "SELECT Id FROM Users ORDER BY rowid";
    using var reader = command.ExecuteReader(); var result = new List<string>(); while (reader.Read()) result.Add(Guid.Parse(reader.GetString(0)).ToString("N")); return result.ToArray();
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? arguments) => Handler(method!, arguments);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static T Empty<T>() where T : class => Make<T>((m, a) => Default(m.ReturnType));
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
