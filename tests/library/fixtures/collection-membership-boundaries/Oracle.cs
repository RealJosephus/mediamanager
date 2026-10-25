using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.IO;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Serialization;


var manager=(LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
var results=new List<object>();
void Bind(UserRootFolder root,IEnumerable<BaseItem> entities){
    var proxy=DispatchProxy.Create<ILibraryManager,LibraryProxy>();
    var implementation=(LibraryProxy)(object)proxy;
    implementation.Items=entities.ToDictionary(item=>item.Id);implementation.Root=root;implementation.Real=manager;
    BaseItem.LibraryManager=proxy;
    Video.RecordingsManager=DispatchProxy.Create<IRecordingsManager,RecordingsProxy>();
    CollectionFolder.XmlSerializer=DispatchProxy.Create<IXmlSerializer,XmlProxy>();
}
foreach(var scenario in new[]{"library-changed","library"}){
    var prefix=scenario=="library-changed"?"C2222222-2222-2222-2222-":"A1111111-1111-1111-1111-";
    Guid Id(int index)=>Guid.Parse(prefix+index.ToString("D12"));
    var root=new UserRootFolder{Id=Id(1),Path=null};
    Folder[] collections;
    BaseItem[] entities;
    List<(string name,BaseItem item)> inspect;
    var user=new User("Reader","Auth","Reset"){Id=Id(15)};
    user.SetPermission(PermissionKind.EnableAllFolders,false);
    user.SetPreference(PreferenceKind.BlockedMediaFolders,Array.Empty<Guid>());
    user.SetPreference(PreferenceKind.BlockedTags,Array.Empty<string>());
    user.SetPreference(PreferenceKind.AllowedTags,Array.Empty<string>());
    user.SetPreference(PreferenceKind.BlockUnratedItems,Array.Empty<string>());
    if(scenario=="library-changed"){
        var first=new Folder{Id=Id(3),Path=@"Z:\First"};
        var second=new Folder{Id=Id(5),Path=@"Z:\Second"};
        var hidden=new Folder{Id=Id(7),Path=@"Z:\Hidden"};
        var collection1=new CollectionFolder{Id=Id(2),ParentId=root.Id,Path=null,PhysicalFolderIds=[first.Id]};
        var collection2=new CollectionFolder{Id=Id(4),ParentId=root.Id,Path=null,PhysicalFolderIds=[second.Id]};
        var collectionHidden=new CollectionFolder{Id=Id(6),ParentId=root.Id,Path=null,PhysicalFolderIds=[hidden.Id]};
        var rootChild=new Folder{Id=Id(8),ParentId=root.Id,Path=null};
        var visibleAdded=new Movie{Id=Id(9),ParentId=first.Id,Path=@"Z:\First\added.mkv"};
        var hiddenAdded=new Movie{Id=Id(10),ParentId=hidden.Id,Path=@"Z:\Hidden\added.mkv"};
        var visibleUpdated=new Movie{Id=Id(11),ParentId=first.Id,Path=@"Z:\First\updated.mkv"};
        var hiddenUpdated=new Movie{Id=Id(12),ParentId=hidden.Id,Path=@"Z:\Hidden\updated.mkv"};
        collections=[collection1,collection2,collectionHidden,rootChild];
        entities=[root,..collections,first,second,hidden,visibleAdded,hiddenAdded,visibleUpdated,hiddenUpdated];
        inspect=[("firstFolder",first),("hiddenFolder",hidden),("visibleAdded",visibleAdded),("hiddenAdded",hiddenAdded),("visibleUpdated",visibleUpdated),("hiddenUpdated",hiddenUpdated)];
        user.SetPreference(PreferenceKind.EnabledFolders,new[]{collection1.Id,collection2.Id});
    }else{
        var physical=new Folder{Id=Id(3),Path=@"Z:\Movies"};
        var collection=new CollectionFolder{Id=Id(2),ParentId=root.Id,Path=null,PhysicalFolderIds=[physical.Id]};
        var movie=new Movie{Id=Id(4),ParentId=physical.Id,Path=@"Z:\Movies\Alpha 中文.mkv",Tags=["Family"]};
        collections=[collection];entities=[root,collection,physical,movie];inspect=[("physical",physical),("movie",movie)];
        user.SetPreference(PreferenceKind.EnabledFolders,Array.Empty<Guid>());
    }
    root.Children=collections;Bind(root,entities);
    foreach(var stage in new[]{"original-preparation","physical-locations-only"}){
        if(stage=="physical-locations-only")foreach(var collection in collections.OfType<CollectionFolder>())
            collection.PhysicalLocationsList=collection.PhysicalFolderIds.Select(id=>entities.Single(item=>item.Id==id).Path).ToArray();
        foreach(var (name,item) in inspect)results.Add(new{scenario,stage,name,Id=item.Id,Path=item.Path,ParentId=item.ParentId,
            collectionFolders=manager.GetCollectionFolders(item,root.Children.OfType<Folder>()).Select(folder=>folder.Id).ToArray(),
            visibleStandalone=item.IsVisibleStandalone(user)});
    }
}
var nullable=new List<object>();
var nullableRoot=new UserRootFolder{Id=Guid.Parse("84000000-0000-0000-0000-000000000001")};
var physicalRoot=new Folder{Id=Guid.Parse("84000000-0000-0000-0000-000000000002")};
var nullableCollection=new CollectionFolder{Id=Guid.Parse("84000000-0000-0000-0000-000000000003"),ParentId=nullableRoot.Id,PhysicalFolderIds=[physicalRoot.Id]};
nullableRoot.Children=[nullableCollection];Bind(nullableRoot,new BaseItem[]{nullableRoot,physicalRoot,nullableCollection});
foreach(var rootPath in new string?[]{null,"",@"Z:\Movies"})foreach(var collectionPath in new string?[]{null,"",@"Z:\Library"})
foreach(var locations in new string?[][]{[],[null],[""],[@"Z:\Movies"]}){
    physicalRoot.Path=rootPath;nullableCollection.Path=collectionPath;nullableCollection.PhysicalLocationsList=locations.Select(path=>path!).ToArray();
    nullable.Add(new{rootPath,collectionPath,locations,rootPathReadback=physicalRoot.Path,collectionPathReadback=nullableCollection.Path,locationsReadback=nullableCollection.PhysicalLocations,
        collectionFolders=manager.GetCollectionFolders(physicalRoot,nullableRoot.Children.OfType<Folder>()).Select(folder=>folder.Id).ToArray()});
}
var ignoredAliasJson=JsonSerializer.Serialize(new{PhysicalLocations=new[]{@"Z:\Movies"}});
var ignoredAlias=JsonSerializer.Deserialize<CollectionFolder>(ignoredAliasJson,Jellyfin.Extensions.Json.JsonDefaults.Options)!;
ignoredAlias.Id=Guid.Parse("84000000-0000-0000-0000-000000000004");ignoredAlias.ParentId=nullableRoot.Id;ignoredAlias.Path=@"Z:\Library";
nullableRoot.Children=[ignoredAlias];Bind(nullableRoot,new BaseItem[]{nullableRoot,physicalRoot,ignoredAlias});
var alias=new{json=ignoredAliasJson,physicalLocations=ignoredAlias.PhysicalLocations,physicalLocationsList=ignoredAlias.PhysicalLocationsList,
    collectionFolders=manager.GetCollectionFolders(physicalRoot,nullableRoot.Children.OfType<Folder>()).Select(folder=>folder.Id).ToArray()};
var scopeRoot=new UserRootFolder{Id=Guid.Parse("84000000-0000-0000-0000-000000000011")};
var aggregate=new AggregateFolder{Id=Guid.Parse("84000000-0000-0000-0000-000000000012")};
var scopePhysical=new Folder{Id=Guid.Parse("84000000-0000-0000-0000-000000000013"),ParentId=aggregate.Id,Path=@"Z:\Refresh"};
var ownerCollection=new CollectionFolder{Id=Guid.Parse("84000000-0000-0000-0000-000000000014"),ParentId=scopeRoot.Id,PhysicalLocationsList=[@"z:/refresh/"]};
var nestedCollection=new CollectionFolder{Id=Guid.Parse("84000000-0000-0000-0000-000000000015"),ParentId=aggregate.Id,PhysicalLocationsList=[@"Z:\Refresh"]};
scopeRoot.Children=[ownerCollection];Bind(scopeRoot,new BaseItem[]{scopeRoot,aggregate,scopePhysical,ownerCollection,nestedCollection});
var scope=new{rootChildren=scopeRoot.Children.Select(item=>item.Id).ToArray(),rootChildMembership=manager.GetCollectionFolders(scopePhysical,scopeRoot.Children.OfType<Folder>()).Select(item=>item.Id).ToArray(),
    explicitlyIncludingNested=manager.GetCollectionFolders(scopePhysical,new Folder[]{ownerCollection,nestedCollection}).Select(item=>item.Id).ToArray()};
File.WriteAllText(args[0],JsonSerializer.Serialize(new{phaseAcceptance=false,results,nullable,scope,alias,processId=Environment.ProcessId,runtime=RuntimeInformation.FrameworkDescription,
    assemblies=new[]{typeof(LibraryManager).Assembly,typeof(BaseItem).Assembly,typeof(User).Assembly,typeof(Jellyfin.Extensions.EnumerableExtensions).Assembly,typeof(object).Assembly,typeof(Enumerable).Assembly}.Distinct().Select(assembly=>new{
        name=assembly.GetName().Name,path=assembly.Location,sha256=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()}).ToArray(),
    boundary="Actual frozen GetCollectionFolders/string+span comparer and standalone visibility. Entity lookup and explicit root children are supplied; no membership/visibility result mocked. Library seed inputs copied from current tests, cache IDs untouched; only PhysicalLocationsList intervention. Root child ParentId selection is separately pinned source inference, not an actual repository read."
},new JsonSerializerOptions{WriteIndented=true}));
public class LibraryProxy : DispatchProxy {
    public Dictionary<Guid, BaseItem> Items = null!;
    public UserRootFolder Root = null!;
    public LibraryManager Real = null!;
    public Dictionary<string,int> Calls = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        var name = method!.Name;
        Calls[name] = Calls.GetValueOrDefault(name) + 1;
        return name switch {
            "GetItemById" => Items.GetValueOrDefault((Guid)args![0]!),
            "GetUserRootFolder" => Root,
            "GetCollectionFolders" => Real.GetCollectionFolders((BaseItem)args![0]!, args.Length > 1 ? (IEnumerable<Folder>)args[1]! : Root.Children.OfType<Folder>()),
            "GetLibraryOptions" => new LibraryOptions(),
            _ => throw new NotSupportedException("Unexpected library call: " + name)
        };
    }
}
public class XmlProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "DeserializeFromFile"
        ? new LibraryOptions() : throw new NotSupportedException(method.Name);
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo"
        ? null : throw new NotSupportedException(method.Name);
}
