using System.Text.Json;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
var filename = Path.GetFullPath(args[0]);
var output = Path.GetFullPath(args[1]);
if (File.Exists(filename) || File.Exists(output)) throw new InvalidOperationException("Oracle outputs must be new files.");
Directory.CreateDirectory(Path.GetDirectoryName(filename)!);
var itemId = Guid.Parse("84000000-0000-0000-0000-000000000001");
var results = new List<object>();
using (var db = Context())
{
    db.Database.EnsureCreated();
    db.BaseItems.Add(new BaseItemEntity { Id = itemId, Type = "MediaBrowser.Controller.Entities.Movies.Movie", Name = "Order probe" });
    db.SaveChanges();
}
foreach (var mode in new[] { "batch", "individual" })
{
    using (var db = Context())
    {
        db.BaseItemImageInfos.ExecuteDelete();
        db.BaseItemTrailerTypes.ExecuteDelete();
        var item = db.BaseItems.Single(value => value.Id == itemId);
        foreach (var (number, type) in new[] { (9, 3), (7, 0), (5, 3), (3, 0) })
        {
            db.BaseItemImageInfos.Add(new BaseItemImageInfo {
                Id = Guid.Parse($"84000000-0000-0000-0000-{number:D12}"),
                ItemId = itemId, Item = item, Path = $"{number}.jpg", ImageType = (ImageInfoImageType)type
            });
            if (mode == "individual") db.SaveChanges();
        }
        db.SaveChanges();
        foreach (var number in new[] { 5, 2, 4 })
        {
            db.BaseItemTrailerTypes.Add(new BaseItemTrailerType { Id = number, ItemId = itemId, Item = item });
            if (mode == "individual") db.SaveChanges();
        }
        db.SaveChanges();
    }
    var saved = Read();
    using (var db = Context())
    {
        db.BaseItemImageInfos.Where(value => value.Path == "9.jpg")
            .ExecuteUpdate(setters => setters.SetProperty(value => value.ImageType, (ImageInfoImageType)0));
        db.BaseItemTrailerTypes.Add(new BaseItemTrailerType { Id = 3, ItemId = itemId, Item = db.BaseItems.Single(value => value.Id == itemId) });
        db.SaveChanges();
    }
    results.Add(new { mode, saved, updated = Read() });
}
File.WriteAllText(output, JsonSerializer.Serialize(results, new JsonSerializerOptions { WriteIndented = true }) + "\n");

object Read()
{
    using var db = Context();
    var included = db.BaseItems.AsNoTracking().AsSplitQuery().Include(value => value.Images)
        .Single(value => value.Id == itemId).Images!.Select(value => value.Path).ToArray();
    var direct = db.BaseItemImageInfos.AsNoTracking().Where(value => value.ItemId == itemId)
        .Select(value => value.Path).ToArray();
    var trailers = db.BaseItems.AsNoTracking().AsSplitQuery().Include(value => value.TrailerTypes)
        .Single(value => value.Id == itemId).TrailerTypes!.Select(value => value.Id).ToArray();
    var directTrailers = db.BaseItemTrailerTypes.AsNoTracking().Where(value => value.ItemId == itemId)
        .Select(value => value.Id).ToArray();
    return new { included, direct, trailers, directTrailers };
}

JellyfinDbContext Context() => new(
    new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
    NullLogger<JellyfinDbContext>.Instance,
    new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance),
    new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
