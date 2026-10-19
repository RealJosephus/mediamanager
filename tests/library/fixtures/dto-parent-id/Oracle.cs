using System.Text.Json;
using Jellyfin.Extensions.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using NativeDto = MediaBrowser.Model.Dto.BaseItemDto;

Guid Id(int value) => Guid.Parse($"99000000-0000-0000-0000-{value:000000000000}");
var parent = Id(1); var scope = Id(2); var empty = Guid.Empty;
var cases = new List<Case> {
    new("episode-flat", "Episode", parent, scope, Id(3)),
    new("episode-parent-null", "Episode", null, scope, Id(3)),
    new("episode-season-empty", "Episode", parent, empty, Id(3)),
    new("episode-season-null", "Episode", parent, null, Id(3)),
    new("season-series-different", "Season", parent, null, scope),
    new("season-parent-null", "Season", null, null, scope),
    new("season-series-empty", "Season", parent, null, empty),
    new("season-series-null", "Season", parent, null, null),
    new("view-hidden-display", "UserView", parent, null, null, scope),
    new("view-hidden-empty", "UserView", parent, null, null, empty),
    new("view-parent-null", "UserView", null, null, null, scope),
    new("folder-parent", "Folder", parent),
    new("folder-injected-display", "Folder", parent, DisplayParentId: scope),
    new("folder-empty-injected-display", "Folder", empty, DisplayParentId: scope),
    new("video-injected-display", "Video", parent, DisplayParentId: scope),
    new("video-null-injected-display", "Video", null, DisplayParentId: scope)
};
var result = cases.Select((entry,index) => {
    var type = typeof(BaseItem).Assembly.GetTypes().Single(type => type.Name == entry.Type && typeof(BaseItem).IsAssignableFrom(type));
    // This is only the arbitrary Data.DisplayParentId field. Authoritative
    // persisted GUIDs are assigned through the real mapper, not deserialized.
    var data = JsonSerializer.Serialize(new { entry.DisplayParentId });
    var item = (BaseItem)JsonSerializer.Deserialize(data, type, JsonDefaults.Options)!;
    BaseItemMapper.Map(new BaseItemEntity { Id = Id(index + 10), ParentId = entry.ParentId,
        SeasonId = entry.SeasonId, SeriesId = entry.SeriesId, Type = type.FullName!, Name = entry.Name }, item, null);
    if (item is UserView view) view.DisplayParentId = entry.DisplayParentId.GetValueOrDefault();
    // DtoService accepts BaseItem and reads this virtual getter; UserView's
    // new hidden member does not participate in this BaseItem-typed access.
    var dto = new NativeDto { ParentId = item.DisplayParentId };
    var serialized = JsonSerializer.SerializeToElement(dto, JsonDefaults.Options);
    return new { input = entry, mappedParentId = item.ParentId,
        mappedSeasonId = item is Episode episode ? (Guid?)episode.SeasonId : null,
        mappedSeriesId = item is IHasSeries series ? (Guid?)series.SeriesId : null,
        hiddenViewDisplayParentId = item is UserView mappedView ? (Guid?)mappedView.DisplayParentId : null,
        baseDisplayParentId = item.DisplayParentId, dtoParentId = serialized.GetProperty("ParentId") };
}).ToArray();
Console.WriteLine(JsonSerializer.Serialize(new { actualFrozenBaseItemMapper = true, actualFrozenDisplayParentGetter = true,
    actualFrozenNullableGuidSerializer = true, actualFullDtoServiceInvoked = false, result }));
record Case(string Name, string Type, Guid? ParentId, Guid? SeasonId = null, Guid? SeriesId = null, Guid? DisplayParentId = null);
