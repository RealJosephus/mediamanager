using System.Security.Claims;
using System.Security.Cryptography;
using System.Globalization;
using System.Text.Json;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Users;
using MediaBrowser.Model.Dto;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
var filename = args[0]; var userId = Guid.Parse(args[1]);
var manager = new DisplayPreferencesManager(new Factory(filename));
var controller = new DisplayPreferencesController(manager, NullLogger<DisplayPreferencesController>.Instance) {
    ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(new[] {
        new Claim(InternalClaimTypes.UserId, userId.ToString("N")), new Claim(ClaimTypes.Role, UserRoles.Administrator)
    }, "consumer")) } }
};
object Read() {
    var dto = controller.GetDisplayPreferences("usersettings", userId, "emby").Value!;
    return new { dto.Id, dto.ViewType, dto.SortBy, dto.IndexBy, dto.RememberIndexing, dto.PrimaryImageHeight, dto.PrimaryImageWidth,
        dto.CustomPrefs, ScrollDirection = (int)dto.ScrollDirection, dto.ShowBackdrop, dto.RememberSorting,
        SortOrder = (int)dto.SortOrder, dto.ShowSidebar, dto.Client };
}
object Snapshot() {
    using var connection = new SqliteConnection($"Data Source={filename};Pooling=False"); connection.Open();
    return new[] { "DisplayPreferences", "ItemDisplayPreferences", "CustomItemDisplayPreferences", "HomeSection" }.ToDictionary(table => table, table => {
        using var command = connection.CreateCommand(); command.CommandText = $"SELECT * FROM {table} ORDER BY Id"; using var reader = command.ExecuteReader(); var rows = new List<Dictionary<string, object?>>();
        while (reader.Read()) rows.Add(Enumerable.Range(0, reader.FieldCount).ToDictionary(i => reader.GetName(i), i => reader.IsDBNull(i) ? null : reader.GetValue(i))); return rows;
    });
}
var originalSha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename)));
var before = Read(); var beforeRows = Snapshot();
var historyItemId = Guid.Parse(args[3]);
var historyBefore = manager.ListCustomItemDisplayPreferences(userId, historyItemId, "emby-search-history");
controller.UpdateDisplayPreferences("usersettings", userId, "emby", new DisplayPreferencesDto {
    SortBy = "Name", CustomPrefs = new() { ["foo"] = "native\0write", ["homesection0"] = "LibraryButtons", ["unknown"] = null }
});
var historyEdit = new Dictionary<string, string?>(historyBefore) {
    ["DateLastSearched"] = (long.Parse(historyBefore["DateLastSearched"]!, CultureInfo.InvariantCulture) + 2).ToString(CultureInfo.InvariantCulture),
    ["external"] = "native\0history"
};
manager.SetCustomItemDisplayPreferences(userId, historyItemId, "emby-search-history", historyEdit);
var historyAfter = manager.ListCustomItemDisplayPreferences(userId, historyItemId, "emby-search-history");
var after = Read(); var afterRows = Snapshot();
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location)).Select(a => new {
    name = a.GetName().Name, filename = a.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(a.Location))) }).OrderBy(a => a.name).ToArray();
var nativeLibraries = System.Diagnostics.Process.GetCurrentProcess().Modules.Cast<System.Diagnostics.ProcessModule>().Where(m => m.ModuleName.Equals("e_sqlite3.dll", StringComparison.OrdinalIgnoreCase)).Select(m => new { filename = m.FileName, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(m.FileName))) }).ToArray();
File.WriteAllText(args[2], JsonSerializer.Serialize(new { originalSha256, actualController = true, actualManager = true, actualEfSqlite = true,
    before, beforeRows, after, afterRows, historyBefore, historyAfter, assemblies, nativeLibraries }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Factory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
