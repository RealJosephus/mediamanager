using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Api.Controllers;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Extensions.Json;
using Jellyfin.Server.Implementations.Security;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
var filename = args[0]; var token = args[1];
var originalSha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename)));
var controller = new ApiKeyController(new AuthenticationManager(new Factory(filename)));
async Task<JsonElement> Read() => JsonSerializer.SerializeToElement((await controller.GetKeys()).Value, JsonDefaults.Options);
object Snapshot() {
    using var connection = new SqliteConnection($"Data Source={filename};Pooling=False"); connection.Open();
    using var command = connection.CreateCommand(); command.CommandText = "SELECT * FROM ApiKeys ORDER BY Id";
    using var reader = command.ExecuteReader(); var rows = new List<Dictionary<string, object?>>();
    while (reader.Read()) rows.Add(Enumerable.Range(0, reader.FieldCount).ToDictionary(i => reader.GetName(i), i => reader.IsDBNull(i) ? null : reader.GetValue(i)));
    return rows;
}
var before = await Read(); var beforeRows = Snapshot();
await controller.RevokeKey(token.ToUpperInvariant()); var afterUppercase = await Read();
await controller.RevokeKey(token); await controller.CreateKey("Native consumer\0key");
var after = await Read(); var afterRows = Snapshot();
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location)).Select(a => new {
    name = a.GetName().Name, filename = a.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(a.Location))) }).OrderBy(a => a.name).ToArray();
var nativeLibraries = System.Diagnostics.Process.GetCurrentProcess().Modules.Cast<System.Diagnostics.ProcessModule>().Where(m => m.ModuleName.Equals("e_sqlite3.dll", StringComparison.OrdinalIgnoreCase)).Select(m => new { filename = m.FileName, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(m.FileName))) }).ToArray();
File.WriteAllText(args[2], JsonSerializer.Serialize(new { originalSha256, actualController = true, actualManager = true, actualEfSqlite = true,
    before, beforeRows, afterUppercase, after, afterRows, assemblies, nativeLibraries }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Factory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
