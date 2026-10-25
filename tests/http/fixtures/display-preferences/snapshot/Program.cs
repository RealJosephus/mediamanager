using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Users;
using MediaBrowser.Controller;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
var factory = new Factory(args[0]); var userId = Guid.Parse("df100000-0000-0000-0000-000000000001"); var itemId = Guid.Parse("3ce5b65d-e116-d731-65d1-efc4a30ec35c");
using (var db = factory.CreateDbContext()) { db.Database.EnsureCreated(); var user = new User("Snapshot", "provider", "reset"); typeof(User).GetProperty("Id")!.SetValue(user, userId); db.Users.Add(user); var preferences = new DisplayPreferences(userId, itemId, "emby"); preferences.HomeSections.Add(new HomeSection { Order = 0, Type = HomeSectionType.Resume }); db.DisplayPreferences.Add(preferences); db.SaveChanges(); }
var actual = new DisplayPreferencesManager(factory); var changed = false;
var proxy = DispatchProxy.Create<IDisplayPreferencesManager, Proxy>();
((Proxy)(object)proxy).Handler = (method, arguments) => {
    if (method.Name == "GetItemDisplayPreferences" && !changed) { changed = true; using var db = factory.CreateDbContext(); db.DisplayPreferences.Single().ShowBackdrop = false; db.Set<HomeSection>().Single().Type = HomeSectionType.LatestMedia; db.SaveChanges(); }
    try { return method.Invoke(actual, arguments); } catch (TargetInvocationException error) { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; }
};
var controller = new DisplayPreferencesController(proxy, NullLogger<DisplayPreferencesController>.Instance) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(InternalClaimTypes.UserId, userId.ToString("N")), new Claim(ClaimTypes.Role, UserRoles.Administrator) }, "snapshot")) } } };
var dto = controller.GetDisplayPreferences("usersettings", userId, "emby").Value!;
var result = new { actualController = true, actualManager = true, actualEfSqlite = true, mutationBeforeItemLookup = changed, actual = new { dto.ShowBackdrop, home = dto.CustomPrefs["homesection0"] }, assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location)).Select(a => new { filename = a.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(a.Location))) }).ToArray(), nativeLibraries = System.Diagnostics.Process.GetCurrentProcess().Modules.Cast<System.Diagnostics.ProcessModule>().Where(m => m.ModuleName.Equals("e_sqlite3.dll", StringComparison.OrdinalIgnoreCase)).Select(m => new { filename = m.FileName, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(m.FileName))) }).ToArray() };
File.WriteAllText(args[1], JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }) + "\n");
public class Proxy : DispatchProxy { public Func<MethodInfo, object?[]?, object?> Handler = null!; protected override object? Invoke(MethodInfo? method, object?[]? arguments) => Handler(method!, arguments); }
public class Factory(string filename) : IDbContextFactory<JellyfinDbContext> { public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options, NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance)); }
