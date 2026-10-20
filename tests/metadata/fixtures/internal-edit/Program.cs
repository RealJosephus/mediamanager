using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Playlists;
using Jellyfin.Api.Controllers;
using Jellyfin.Extensions.Json;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions(JsonDefaults.Options) { PropertyNameCaseInsensitive = true, WriteIndented = true,
    DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never };
var bytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(bytes).RootElement;
var results = new List<object>();
foreach (var type in input.GetProperty("types").EnumerateArray().Select(value => value.GetString()!)) {
    var definitions = input.GetProperty("nodes").EnumerateArray().ToArray();
    var values = definitions.Select((entry, index) => {
        var item = Create(entry.GetProperty("type").GetString() is "$subject" ? type : entry.GetProperty("type").GetString()!);
        item.Id = Guid.Parse($"87000000-0000-0000-0000-{index + 1:000000000000}");
        item.Name = entry.GetProperty("key").GetString()!;
        item.DateCreated = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        return item;
    }).ToArray();
    var byKey = values.ToDictionary(value => value.Name);
    var byId = values.ToDictionary(value => value.Id);
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    var localization = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
    await localization.LoadAll();
    BaseItem.ConfigurationManager = configuration; BaseItem.LocalizationManager = localization;
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var proxy = (LibraryProxy)(object)library; proxy.Items = byId;
    BaseItem.LibraryManager = library;
    for (var index = 0; index < definitions.Length; index++) {
        var entry = definitions[index]; var item = values[index];
        var parent = entry.GetProperty("parent").GetString();
        if (parent is "$children" or "$second") parent = type is "CollectionFolder" ? parent is "$children" ? "physical1" : "physical2" : "subject";
        item.ParentId = parent is null ? Guid.Empty : byKey[parent].Id;
        if (item is CollectionFolder collection) {
            var keys = item == byKey["subject"] ? input.GetProperty("subjectPhysical") : entry.GetProperty("physical");
            collection.PhysicalFolderIds = keys.EnumerateArray().Select(value => byKey.TryGetValue(value.GetString()!, out var folder)
                ? folder.Id : Guid.Parse("87000000-0000-0000-0000-999999999999")).ToArray();
        }
        if (item is Folder folderItem) {
            var links = item == byKey["subject"] ? input.GetProperty("subjectLinked") : entry.TryGetProperty("linked", out var linked) ? linked : default;
            folderItem.LinkedChildren = links.ValueKind == JsonValueKind.Array
                ? links.EnumerateArray().Select(value => LinkedChild.Create(byKey[value.GetString()!])).ToArray() : [];
        }
    }
    foreach (var folder in values.OfType<Folder>().Where(folder => folder is not CollectionFolder && folder is not Playlist))
        folder.Children = values.Where(value => value.ParentId == folder.Id).OrderBy(value => value.SortName, StringComparer.Ordinal).ToArray();
    if (byKey["subject"] is AggregateFolder aggregate) aggregate.VirtualChildren.Add(byKey["virtualChild"]);
    var controller = new ItemUpdateController(null!, library, null!, localization, configuration) {
        ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
    };
    var stages = new List<object>();
    foreach (var request in input.GetProperty("requests").EnumerateArray()) {
        proxy.Saves.Clear();
        var response = await controller.UpdateItem(byKey["subject"].Id, JsonSerializer.Deserialize<BaseItemDto>(request.GetRawText(), json)!);
        stages.Add(new { status = response is NoContentResult ? 204 : throw new NotSupportedException(),
            saves = proxy.Saves.ToArray(), items = values.Select(Project).ToArray() });
    }
    results.Add(new { type, stages });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualExecution = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), results,
    boundary = "Actual ItemUpdateController.UpdateItem, typed Children/GetRecursiveChildren and LinkedChild resolution. Library lookup/save callbacks are controlled; PostgreSQL HTTP consumer separately executes actual savers, repository writes and events. No native HTTP or filesystem save is claimed.",
    assemblies = new[] { typeof(ItemUpdateController).Assembly, typeof(Folder).Assembly, typeof(PlaylistsFolder).Assembly }
        .Select(assembly => new { assembly.FullName, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }) }, json));

static BaseItem Create(string type) => type switch {
    "AggregateFolder" => new AggregateFolder(), "UserRootFolder" => new UserRootFolder(),
    "CollectionFolder" => new CollectionFolder(), "UserView" => new UserView(),
    "PlaylistsFolder" => new PlaylistsFolder(), "Playlist" => new Playlist(),
    "Folder" => new Folder(), "Movie" => new Movie(), "Series" => new Series(), "Season" => new Season(),
    _ => throw new NotSupportedException(type)
};
static object Project(BaseItem item) => new {
    id = item.Id.ToString("D"), type = item.GetType().Name, item.Name, item.ForcedSortName, item.Overview,
    item.IsLocked, item.Genres, item.Tags, item.ProviderIds, item.LockedFields,
    dateCreated = item.DateCreated.ToString("yyyy-MM-dd HH:mm:ss.fffffff"), item.PreferredMetadataLanguage,
    item.OfficialRating, item.CustomRating
};
public class ConfigurationProxy : DispatchProxy {
    public ServerConfiguration Value = new();
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_Configuration" => Value, "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
public class LibraryProxy : DispatchProxy {
    public Dictionary<Guid, BaseItem> Items = []; public List<object> Saves = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "GetItemById") return Items.GetValueOrDefault((Guid)args![0]!);
        if (method.Name == "GetItemList") {
            var ids = ((InternalItemsQuery)args![0]!).ItemIds;
            return ids.Select(id => Items.GetValueOrDefault(id)).Where(item => item is not null).Cast<BaseItem>().ToArray();
        }
        if (method.Name == "UpdatePeople") return null;
        if (method.Name == "GetLocalAlternateVersionIds") return Array.Empty<Guid>();
        if (method.Name == "GetCollectionFolders") return new List<Folder>();
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        if (method.Name == "UpdateItemAsync") {
            var item = (BaseItem)args![0]!;
            Saves.Add(new { id = item.Id.ToString("D"), locked = item.IsLocked, reason = (int)(ItemUpdateType)args[2]! });
            return Task.CompletedTask;
        }
        throw new NotSupportedException(method.Name);
    }
}
