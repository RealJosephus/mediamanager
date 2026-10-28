using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
var mode = args[0];
var filename = Path.GetFullPath(args[1]);
using var document = JsonDocument.Parse(File.ReadAllBytes(args[2]));
var input = document.RootElement;
var count = input.GetProperty("items").GetInt32();
if (count != 100000) throw new InvalidOperationException("The declared catalog cardinality changed.");
var parentId = Guid.Parse(input.GetProperty("parentId").GetString()!);
var prefix = input.GetProperty("idPrefix").GetString()!;
var userId = Guid.Parse(input.GetProperty("userId").GetString()!);
var mediaRoot = Path.GetFullPath(input.GetProperty("mediaRoot").GetString()!);
var data = input.GetProperty("data").GetString()!;
var ticksBase = long.Parse(input.GetProperty("ticksBase").GetString()!, CultureInfo.InvariantCulture);
var retainedId = Id(input.GetProperty("retained").GetInt32());
var deletedId = Id(input.GetProperty("deletedByNode").GetInt32());
var nodeAddedId = Id(input.GetProperty("addedByNode").GetInt32());
var nativeOrdinal = input.GetProperty("addedByNative").GetInt32();
var nativeAddedId = Id(nativeOrdinal);
var queryInput = input.GetProperty("query");

object result;
if (mode == "seed")
{
    Seed();
    result = new { mode, processId = Environment.ProcessId, observation = await Read() };
}
else if (mode == "continue")
{
    var before = await Read();
    using (var db = Context())
    {
        if (db.BaseItems.Any(item => item.Id == deletedId)) throw new InvalidOperationException("Node deletion was not preserved.");
        var retained = db.BaseItems.Single(item => item.Id == retainedId);
        if (retained.Name != "Edited by Node at production cardinality" || retained.Data != data)
            throw new InvalidOperationException("Node metadata or opaque Data was not preserved.");
        retained.Name = "Native continued at production cardinality";
        retained.RunTimeTicks += 7;
        var userData = db.UserData.Single(value => value.ItemId == retainedId && value.UserId == userId);
        userData.PlaybackPositionTicks += 7;
        userData.PlayCount++;
        db.BaseItems.Remove(db.BaseItems.Single(item => item.Id == nodeAddedId));
        var added = new BaseItemEntity { Id = nativeAddedId, Type = "MediaBrowser.Controller.Entities.Movies.Movie",
            Name = $"Large catalog {nativeOrdinal:D7}", SortName = $"large catalog {nativeOrdinal:D7}",
            CleanName = $"large catalog {nativeOrdinal:D7}", Data = data, MediaType = "Video", IsMovie = true,
            Path = Path.Combine(mediaRoot, $"{nativeOrdinal:D7}.mkv"), ParentId = parentId, TopParentId = parentId,
            PresentationUniqueKey = nativeAddedId.ToString("D").ToUpperInvariant(),
            ProductionYear = 1980 + nativeOrdinal % 50, RunTimeTicks = ticksBase + nativeOrdinal + 10000,
            DateCreated = new DateTime(2026, 10, 20, 12, 34, 56, DateTimeKind.Utc).AddTicks(1234567) };
        db.BaseItems.Add(added);
        db.AncestorIds.Add(new AncestorId { ItemId = added.Id, ParentItemId = parentId, Item = added, ParentItem = null! });
        db.UserData.Add(new UserData { ItemId = added.Id, UserId = userId, Item = added, User = null!,
            CustomDataKey = added.Id.ToString("D").ToUpperInvariant(), PlaybackPositionTicks = ticksBase + nativeOrdinal,
            PlayCount = 1, IsFavorite = false, Played = false });
        db.SaveChanges();
    }
    result = new { mode, processId = Environment.ProcessId, before, after = await Read() };
}
else throw new InvalidOperationException("Unknown catalog operation.");
File.WriteAllText(args[3], JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }) + "\n");

Guid Id(int ordinal) => Guid.Parse(prefix + ordinal.ToString("D12", CultureInfo.InvariantCulture));
string Q(string value) => "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";

void Seed()
{
    using var db = Context();
    var templateId = Id(0);
    if (db.BaseItems.Any(item => item.Id == parentId || item.Id == templateId))
        throw new InvalidOperationException("The generated catalog requires a fresh current Native database.");
    using var transaction = db.Database.BeginTransaction();
    var parent = new BaseItemEntity { Id = parentId, Type = "MediaBrowser.Controller.Entities.Folder",
        Name = "CI large catalog", SortName = "ci large catalog", IsFolder = true, MediaType = "Unknown", Path = mediaRoot, Data = "{}" };
    var template = new BaseItemEntity { Id = templateId, Type = "MediaBrowser.Controller.Entities.Movies.Movie",
        Name = "Catalog template", SortName = "catalog template", Data = data, MediaType = "Video", IsMovie = true,
        ParentId = parentId, TopParentId = parentId, Path = Path.Combine(mediaRoot, "template.mkv"),
        DateCreated = new DateTime(2026, 10, 20, 12, 34, 56, DateTimeKind.Utc).AddTicks(1234567) };
    db.BaseItems.AddRange(parent, template);
    db.UserData.Add(new UserData { ItemId = template.Id, Item = template, UserId = userId, User = null!,
        CustomDataKey = template.Id.ToString("D").ToUpperInvariant(), PlaybackPositionTicks = ticksBase, PlayCount = 1,
        LastPlayedDate = new DateTime(2026, 10, 20, 12, 34, 56, DateTimeKind.Utc).AddTicks(1234567) });
    db.SaveChanges();
    var itemType = db.Model.FindEntityType(typeof(BaseItemEntity))!;
    var itemTable = StoreObjectIdentifier.Table(itemType.GetTableName()!, itemType.GetSchema());
    var itemColumns = itemType.GetProperties().Select(property => property.GetColumnName(itemTable)!).ToArray();
    var replacements = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["Id"] = "@prefix || printf('%012d', n)",
        ["Name"] = "printf('Large catalog %07d', n)",
        ["SortName"] = "printf('large catalog %07d', n)",
        ["CleanName"] = "printf('large catalog %07d', n)",
        ["Path"] = "@pathPrefix || printf('%07d.mkv', n)",
        ["PresentationUniqueKey"] = "@prefix || printf('%012d', n)",
        ["ProductionYear"] = "1980 + (n % 50)",
        ["RunTimeTicks"] = "@ticksBase + n + 10000"
    };
    var expressions = itemColumns.Select(column => replacements.TryGetValue(column, out var expression)
        ? expression : "template." + Q(column));
    var inserted = db.Database.ExecuteSqlRaw("WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < @count) "
        + $"INSERT INTO \"BaseItems\" ({string.Join(',', itemColumns.Select(Q))}) SELECT {string.Join(',', expressions)} "
        + "FROM \"BaseItems\" template CROSS JOIN numbers WHERE template.\"Id\" = @templateId",
        new SqliteParameter("@count", count), new SqliteParameter("@prefix", prefix),
        new SqliteParameter("@pathPrefix", mediaRoot + Path.DirectorySeparatorChar), new SqliteParameter("@ticksBase", ticksBase),
        new SqliteParameter("@templateId", template.Id.ToString("D").ToUpperInvariant()));
    if (inserted != count) throw new InvalidOperationException("Native SQLite did not insert the complete catalog.");
    var ancestors = db.Database.ExecuteSqlRaw("INSERT INTO \"AncestorIds\" (\"ItemId\", \"ParentItemId\") "
        + "SELECT \"Id\", @parent FROM \"BaseItems\" WHERE \"ParentId\" = @parent AND \"Id\" <> @templateId",
        new SqliteParameter("@parent", parentId.ToString("D").ToUpperInvariant()),
        new SqliteParameter("@templateId", template.Id.ToString("D").ToUpperInvariant()));
    if (ancestors != count) throw new InvalidOperationException("The complete catalog ancestry was not generated.");
    var userType = db.Model.FindEntityType(typeof(UserData))!;
    var userTable = StoreObjectIdentifier.Table(userType.GetTableName()!, userType.GetSchema());
    var userColumns = userType.GetProperties().Select(property => property.GetColumnName(userTable)!).ToArray();
    var ordinal = "CAST(substr(item.\"Id\", -12) AS INTEGER)";
    var userReplacements = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["ItemId"] = "item.\"Id\"", ["CustomDataKey"] = "item.\"Id\"",
        ["IsFavorite"] = $"CASE WHEN {ordinal} % 3 = 0 THEN 1 ELSE 0 END",
        ["Played"] = $"CASE WHEN {ordinal} % 5 = 0 THEN 1 ELSE 0 END",
        ["PlaybackPositionTicks"] = "@ticksBase + " + ordinal
    };
    var userExpressions = userColumns.Select(column => userReplacements.TryGetValue(column, out var expression)
        ? expression : "template." + Q(column));
    var users = db.Database.ExecuteSqlRaw($"INSERT INTO \"UserData\" ({string.Join(',', userColumns.Select(Q))}) "
        + $"SELECT {string.Join(',', userExpressions)} FROM \"UserData\" template JOIN \"BaseItems\" item "
        + "ON item.\"ParentId\" = @parent AND item.\"Id\" <> @templateId WHERE template.\"ItemId\" = @templateId",
        new SqliteParameter("@ticksBase", ticksBase), new SqliteParameter("@parent", parentId.ToString("D").ToUpperInvariant()),
        new SqliteParameter("@templateId", template.Id.ToString("D").ToUpperInvariant()));
    if (users != count) throw new InvalidOperationException("The complete catalog user state was not generated.");
    db.BaseItems.Remove(template); db.SaveChanges(); transaction.Commit();
}

async Task<object> Read()
{
    using var db = Context();
    var query = db.BaseItems.AsNoTracking().Where(item => item.ParentId == parentId);
    long rows = 0, ordinalSum = 0;
    using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
    await foreach (var item in query.OrderBy(item => item.Id).AsAsyncEnumerable())
    {
        if (item.Data != data || item.Type != "MediaBrowser.Controller.Entities.Movies.Movie" || item.MediaType != "Video")
            throw new InvalidOperationException("A generated item lost opaque metadata or media type in the actual Native reader.");
        rows++; ordinalSum += long.Parse(item.Id.ToString("N")[20..], CultureInfo.InvariantCulture);
        hash.AppendData(Encoding.UTF8.GetBytes(item.Data));
    }
    var year = queryInput.GetProperty("year").GetInt32();
    var filtered = query.Where(item => item.ProductionYear == year
        && item.UserData!.Any(value => value.UserId == userId && value.IsFavorite));
    var page = filtered.OrderBy(item => item.SortName).ThenBy(item => item.Id)
        .Skip(queryInput.GetProperty("startIndex").GetInt32()).Take(queryInput.GetProperty("limit").GetInt32())
        .Select(item => new { item.Id, item.Name, item.SortName, item.ProductionYear, item.RunTimeTicks }).ToArray();
    var retained = query.Single(item => item.Id == retainedId);
    var state = db.UserData.AsNoTracking().Single(value => value.ItemId == retainedId && value.UserId == userId);
    return new { rows, ordinalSum = ordinalSum.ToString(CultureInfo.InvariantCulture), dataSha256 = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant(),
        filteredCount = filtered.LongCount(), page = page.Select(item => new { id = item.Id.ToString("D").ToUpperInvariant(), item.Name,
            item.SortName, item.ProductionYear, runTimeTicks = item.RunTimeTicks?.ToString(CultureInfo.InvariantCulture) }),
        userStateRows = db.UserData.LongCount(value => value.UserId == userId && value.Item!.ParentId == parentId),
        retained = new { retained.Name, retained.Data, runTimeTicks = retained.RunTimeTicks?.ToString(CultureInfo.InvariantCulture),
            playbackPositionTicks = state.PlaybackPositionTicks.ToString(CultureInfo.InvariantCulture), state.PlayCount,
            lastPlayedDate = state.LastPlayedDate?.ToString("O", CultureInfo.InvariantCulture) },
        deletedItemPresent = query.Any(item => item.Id == deletedId), nodeAddedItemPresent = query.Any(item => item.Id == nodeAddedId),
        nativeAddedItemPresent = query.Any(item => item.Id == nativeAddedId) };
}

JellyfinDbContext Context()
{
    var db = new JellyfinDbContext(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Foreign Keys=True;Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance),
        new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
    db.Database.SetCommandTimeout(30);
    return db;
}
