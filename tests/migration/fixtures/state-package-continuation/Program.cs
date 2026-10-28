using System.Globalization;
using System.Text.Json;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
var filename = Path.GetFullPath(args[0]);
using var input = JsonDocument.Parse(File.ReadAllBytes(args[1]));
var root = input.RootElement;
var ids = root.GetProperty("ids");
var retainedId = Id("retained");
var deletedId = Id("deleted");
var nodeAddedId = Id("nodeAdded");
var nativeAddedId = Id("nativeAdded");
var image5Id = Id("image5");
var markerId = root.GetProperty("markerId").GetInt32();
var deletedMarkerId = root.GetProperty("deletedMarkerId").GetInt32();
var userId = Guid.Parse(root.GetProperty("userId").GetString()!);
var before = Read();
int addedActivityId;
using (var db = Context())
{
    var item = db.BaseItems.Single(value => value.Id == retainedId);
    item.Name = "Native continued after recovered package";
    db.BaseItems.Remove(db.BaseItems.Single(value => value.Id == nodeAddedId));
    db.BaseItems.Add(new BaseItemEntity { Id = nativeAddedId, Name = "Added by Native after recovered package",
        Type = "MediaBrowser.Controller.Entities.Movies.Movie", Data = item.Data, MediaType = "Video" });
    db.BaseItemImageInfos.Remove(db.BaseItemImageInfos.Single(value => value.Id == image5Id));
    var userData = db.UserData.Single(value => value.ItemId == retainedId && value.UserId == userId);
    userData.PlaybackPositionTicks += 7;
    userData.PlayCount++;
    var marker = db.ActivityLogs.Single(value => value.Id == markerId);
    marker.Name = "Native continued after recovered package";
    var activity = new ActivityLog("Added by Native after recovered package", "System", userId)
    {
        DateCreated = new DateTime(2026, 10, 20, 12, 34, 56, DateTimeKind.Utc).AddTicks(1234567),
        Overview = "Actual EF continuation after interrupted state package recovery."
    };
    db.ActivityLogs.Add(activity);
    db.SaveChanges();
    addedActivityId = activity.Id;
}
var after = Read();
File.WriteAllText(args[2], JsonSerializer.Serialize(new { before, after, addedActivityId },
    new JsonSerializerOptions { WriteIndented = true }) + "\n");

Guid Id(string key) => Guid.Parse(ids.GetProperty(key).GetString()!);

object Read()
{
    using var db = Context();
    var item = db.BaseItems.AsNoTracking().AsSplitQuery().Include(value => value.Images)
        .Single(value => value.Id == retainedId);
    var userData = db.UserData.AsNoTracking().Single(value => value.ItemId == retainedId && value.UserId == userId);
    var marker = db.ActivityLogs.AsNoTracking().Single(value => value.Id == markerId);
    return new
    {
        name = item.Name,
        data = item.Data,
        images = item.Images!.Select(value => value.Id.ToString("D")).ToArray(),
        playbackPositionTicks = userData.PlaybackPositionTicks.ToString(CultureInfo.InvariantCulture),
        lastPlayedDate = userData.LastPlayedDate?.ToString("O", CultureInfo.InvariantCulture),
        likes = userData.Likes,
        playCount = userData.PlayCount,
        favorite = userData.IsFavorite,
        deletedItemPresent = db.BaseItems.Any(value => value.Id == deletedId),
        nodeAddedItemPresent = db.BaseItems.Any(value => value.Id == nodeAddedId),
        nativeAddedItemPresent = db.BaseItems.Any(value => value.Id == nativeAddedId),
        deletedActivityPresent = db.ActivityLogs.Any(value => value.Id == deletedMarkerId),
        activityName = marker.Name,
        activityRowVersion = marker.RowVersion
    };
}

JellyfinDbContext Context() => new(
    new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
    NullLogger<JellyfinDbContext>.Instance,
    new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance),
    new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
