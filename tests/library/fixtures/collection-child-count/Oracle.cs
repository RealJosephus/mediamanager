using System.Reflection;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging.Abstractions;
using BaseItem = MediaBrowser.Controller.Entities.BaseItem;
using LinkedChildType = MediaBrowser.Controller.Entities.LinkedChildType;

Guid Id(int number) => Guid.Parse($"99100000-0000-0000-0000-{number:000000000000}");
var config = new ServerConfiguration { EnableGroupingMoviesIntoCollections = false, EnableGroupingShowsIntoCollections = false };
BaseItem.ConfigurationManager = Stub.Make<IServerConfigurationManager>((method, args) => method.Name == "get_Configuration" ? config : Stub.Default(method.ReturnType));
BaseItem.Logger = NullLogger<BaseItem>.Instance;
Video.RecordingsManager = Stub.Make<MediaBrowser.Controller.LiveTv.IRecordingsManager>((method, args) => Stub.Default(method.ReturnType));
var source = new Video { Id = Id(5), Name = "Linked source", PresentationUniqueKey = "shared-video-key" };
var otherSource = new Video { Id = Id(6), Name = "Other linked source", PresentationUniqueKey = "shared-video-key" };
var sources = new[] { source, otherSource };
var calls = new List<string>();
BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, args) => {
    calls.Add(method.Name);
    if (method.Name == "GetItemList") {
        var query = (InternalItemsQuery)args![0]!;
        return sources.Where(item => query.ItemIds.Contains(item.Id)).Cast<BaseItem>().ToArray();
    }
    if (method.Name == "GetItemById") return sources.FirstOrDefault(item => item.Id == (Guid)args![0]!);
    if (method.Name == "GetCollectionFolders") return new List<Folder>();
    return Stub.Default(method.ReturnType);
});
BaseItem.UserDataManager = Stub.Make<IUserDataManager>((method, args) => Stub.Default(method.ReturnType));
var user = new User("SyntheticAudit", "controlled-authentication", "controlled-reset") { Id = Id(99) };
var collection = new CollectionFolder { Id = Id(4), Name = "Collection", PhysicalFolderIds = [],
    LinkedChildren = [new LinkedChild { ItemId = source.Id, Type = LinkedChildType.Manual }] };
var plain = new Folder { Id = Id(8), Name = "Plain", Children = [],
    LinkedChildren = [new LinkedChild { ItemId = source.Id, Type = LinkedChildType.Manual }] };
var duplicate = new CollectionFolder { Id = Id(9), Name = "Collection duplicate link types", PhysicalFolderIds = [],
    LinkedChildren = [new LinkedChild { ItemId = source.Id, Type = (LinkedChildType)0 },
        new LinkedChild { ItemId = source.Id, Type = (LinkedChildType)1 },
        new LinkedChild { ItemId = source.Id, Type = (LinkedChildType)2 }] };
var samePresentation = new CollectionFolder { Id = Id(10), Name = "Different IDs with same presentation key", PhysicalFolderIds = [],
    LinkedChildren = [new LinkedChild { ItemId = source.Id, Type = LinkedChildType.Manual },
        new LinkedChild { ItemId = otherSource.Id, Type = LinkedChildType.Manual }] };
var output = new List<object>();
foreach (var folder in new Folder[] { collection, plain, duplicate, samePresentation }) {
    var withoutLinks = folder.GetChildren(user, false, out var withoutCount);
    var withLinks = folder.GetChildren(user, true, out var withCount);
    var query = new InternalItemsQuery(user) { Recursive = false, Limit = 0, Parent = folder,
        DtoOptions = new DtoOptions(false) { EnableImages = false } };
    var items = folder.GetItems(query);
    var anonymous = folder.GetItems(new InternalItemsQuery { Recursive = false, Limit = 0, Parent = folder,
        DtoOptions = new DtoOptions(false) { EnableImages = false } });
    output.Add(new { Id = folder.Id, type = folder.GetType().FullName, physicalFolderIds = folder is CollectionFolder c ? c.PhysicalFolderIds : null,
        LinkedChildrenLoaded = folder.LinkedChildrenLoaded,
        links = folder.LinkedChildren.Select(link => new { link.ItemId, link.Type }).ToArray(),
        sources = sources.Select(item => new { item.Id, item.Name, item.ParentId, item.Path, item.IsVirtualItem, item.OwnerId, item.PresentationUniqueKey }).ToArray(),
        withoutLinks = withoutLinks.Select(item => item.Id).ToArray(), withoutCount,
        withLinks = withLinks.Select(item => item.Id).ToArray(), withCount,
        itemIds = items.Items.Select(item => item.Id).ToArray(), items.TotalRecordCount,
        cachedChildren = folder.Children.Select(item => item.Id).ToArray(),
        anonymousItemIds = anonymous.Items.Select(item => item.Id).ToArray(), anonymousTotalRecordCount = anonymous.TotalRecordCount,
        childCount = folder.GetChildCount(user) });
}
Console.WriteLine(JsonSerializer.Serialize(new { actualFrozenFolderMethods = true, actualFrozenCollectionFolder = true,
    dependenciesControlled = true, actualFullDtoServiceInvoked = false, databaseOpened = false, output, calls }));
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => Handler(targetMethod!, args);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
