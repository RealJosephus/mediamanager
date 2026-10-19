using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Emby.Server.Implementations.EntryPoints;
using Emby.Server.Implementations.Library;
using Jellyfin.Data.Events;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

Guid Id(int index) => Guid.Parse($"d1000000-0000-0000-0000-{index:000000000000}");
var root = new UserRootFolder { Id = Id(1), Path = "D:\\Oracle\\root\\default" };
var aggregate = new AggregateFolder { Id = Id(2), Path = "Z:\\" };
var physical = new Folder { Id = Id(3), ParentId = aggregate.Id, Path = "Z:\\Refresh" };
CollectionFolder Make(int index, Guid parent, string location, Guid[] cache) => new() {
    Id = Id(index), ParentId = parent, Path = $"D:\\Oracle\\root\\default\\{index}",
    PhysicalLocationsList = [location], PhysicalFolderIds = cache };
var pathOnly = Make(4, root.Id, "z:\\refresh", []);
var nested = Make(5, aggregate.Id, physical.Path, []);
var posixPhysical = new Folder { Id = Id(6), ParentId = aggregate.Id, Path = "/Media/Shows" };
var trailing = Make(7, root.Id, "/Media/Shows/", []);
var differentCase = Make(8, root.Id, "/media/shows", [posixPhysical.Id]);
var second = new Folder { Id = Id(11), ParentId = aggregate.Id, Path = "Z:\\Second" };
var cached = Make(9, root.Id, physical.Path, [physical.Id, second.Id]);
cached.PhysicalLocationsList = [physical.Path, second.Path];
var normalized = Make(10, root.Id, "z:/refresh/", [physical.Id]);
const string aliasData = "{\"PhysicalLocations\":[\"Z:\\\\Refresh\"]}";
var ignoredAlias = JsonSerializer.Deserialize<CollectionFolder>(aliasData)!;
ignoredAlias.Id = Id(12); ignoredAlias.ParentId = root.Id; ignoredAlias.Path = "D:\\Oracle\\root\\default\\12";
var folders = new[] { pathOnly, nested, trailing, differentCase, cached, normalized, ignoredAlias };
root.Children = folders.Where(folder => folder.ParentId == root.Id).ToArray();
var items = new BaseItem[] { root, aggregate, physical, posixPhysical, second }.Concat(folders).ToDictionary(item => item.Id);
var real = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
var calls = new List<string>();
var library = Stub.Make<ILibraryManager>((method, args) => {
    calls.Add(method.Name);
    return method.Name switch {
        "GetItemById" => items.GetValueOrDefault((Guid)args![0]!),
        "GetCollectionFolders" => real.GetCollectionFolders((BaseItem)args![0]!, root.Children.OfType<Folder>()),
        "GetUserRootFolder" => root,
        _ => Stub.Default(method.ReturnType)
    };
});
BaseItem.LibraryManager = library;
var active = new Dictionary<Guid,double>();
var provider = Stub.Make<IProviderManager>((method,args) => method.Name == "GetRefreshProgress"
    ? active.TryGetValue((Guid)args![0]!, out var progress) ? (double?)progress : null : Stub.Default(method.ReturnType));
BaseItem.ProviderManager = provider;
var config = Stub.Make<IServerConfigurationManager>((method,args) => method.Name == "get_Configuration"
    ? new ServerConfiguration() : Stub.Default(method.ReturnType));
var users = Stub.Make<IUserManager>((method,args) => Stub.Default(method.ReturnType));
var output = new List<object>();
foreach (var entry in new[] {
    (phase: "first-started", item: physical, progress: 0d, first: (double?)0d, second: (double?)null, own: (double?)null),
    (phase: "first-progress", item: physical, progress: 40d, first: (double?)40d, second: (double?)null, own: (double?)null),
    (phase: "own-active-collection", item: physical, progress: 40d, first: (double?)40d, second: (double?)null, own: (double?)66d),
    (phase: "second-started", item: second, progress: 0d, first: (double?)40d, second: (double?)0d, own: (double?)null),
    (phase: "first-completed", item: physical, progress: 100d, first: (double?)null, second: (double?)0d, own: (double?)null),
    (phase: "second-completed", item: second, progress: 100d, first: (double?)null, second: (double?)null, own: (double?)null)
}) {
    active.Clear(); if (entry.first.HasValue) active[physical.Id] = entry.first.Value;
    if (entry.second.HasValue) active[second.Id] = entry.second.Value;
    if (entry.own.HasValue) active[pathOnly.Id] = entry.own.Value;
    var messages = new List<object>();
    var sessions = Stub.Make<ISessionManager>((method,args) => {
        if (method.Name == "SendMessageToAdminSessions") {
            messages.Add(new { messageType = args![0]!.ToString(), data = new Dictionary<string,string>((Dictionary<string,string>)args[1]!) });
            return Task.CompletedTask;
        }
        return Stub.Default(method.ReturnType);
    });
    using var notifier = new LibraryChangedNotifier(library, config, sessions, users,
        NullLogger<LibraryChangedNotifier>.Instance, provider);
    var onProgress = typeof(LibraryChangedNotifier).GetMethod("OnProviderRefreshProgress", BindingFlags.Instance | BindingFlags.NonPublic)!;
    if (entry.own.HasValue) onProgress.Invoke(notifier,
        [null, new GenericEventArgs<Tuple<BaseItem,double>>(Tuple.Create<BaseItem,double>(pathOnly,entry.own.Value))]);
    var ownProducerMessages = messages.ToArray();
    onProgress.Invoke(notifier, [null, new GenericEventArgs<Tuple<BaseItem,double>>(Tuple.Create<BaseItem,double>(entry.item,entry.progress))]);
    output.Add(new { entry.phase, itemId = entry.item.Id, entry.progress, entry.first, entry.second, entry.own, ownProducerMessages,
        isRoot = entry.item.IsRoot, isTopParent = entry.item.IsTopParent,
        active = active.Select(value => new { id = value.Key, progress = value.Value }).ToArray(),
        getters = folders.Select(folder => new { folder.Id, progress = folder.GetRefreshProgress() }).ToArray(), messages });
}
Console.WriteLine(JsonSerializer.Serialize(new {
    actualFrozenLibraryManagerMembership = true, actualFrozenCollectionRefreshProgress = true,
    actualFrozenNotifier = true, dependenciesControlled = true, actualWebSocketTransportInvoked = false, databaseOpened = false,
    inputs = items.Values.Select(item => new { item.Id, item.ParentId, item.Path, type = item.GetType().Name,
        physicalLocationsList = item is CollectionFolder folder ? folder.PhysicalLocationsList : null,
        physicalFolderIds = item is CollectionFolder collection ? collection.PhysicalFolderIds : null,
        serializedData = item.Id == ignoredAlias.Id ? aliasData : null }).ToArray(),
    rootChildIds = root.Children.Select(item => item.Id).ToArray(),
    windowsCollectionIds = real.GetCollectionFolders(physical, root.Children.OfType<Folder>()).Select(item => item.Id).ToArray(),
    posixCollectionIds = real.GetCollectionFolders(posixPhysical, root.Children.OfType<Folder>()).Select(item => item.Id).ToArray(),
    ignoredAlias = new { ignoredAlias.PhysicalLocationsList, ignoredAlias.PhysicalLocations, ignoredAlias.PhysicalFolderIds },
    output, calls,
    sourceBoundary = "Actual frozen LibraryManager.GetCollectionFolders(item,allUserRootChildren), CollectionFolder.GetRefreshProgress/GetPhysicalFolders(true), and private LibraryChangedNotifier.OnProviderRefreshProgress run unmodified. Explicit root.Children contains only folders whose ParentId is root. Entity lookup, provider active-progress dictionary, configuration, user and session interfaces are controlled via DispatchProxy. Session send captures complete native MessageType/Data; native WebSocket envelopes, SQL query, live provider lifecycle and throttle timing are not invoked. Each progress observation uses a fresh notifier so intermediate values are not suppressed by time. No membership/getter/notification payload result is mocked.",
    phaseAcceptance = false }, new JsonSerializerOptions { WriteIndented = true }));
public class Stub : DispatchProxy {
    public Func<MethodInfo,object?[]?,object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method,object?[]? args) => Handler(method!,args);
    public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T:class {
        var proxy = Create<T,Stub>(); ((Stub)(object)proxy).Handler = handler; return proxy; }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
