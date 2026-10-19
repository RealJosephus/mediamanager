using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Logging.Abstractions;
using BaseItemEntity = Jellyfin.Database.Implementations.Entities.BaseItemEntity;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, values) => Stub.Default(method.ReturnType));
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, values) => method.Name switch {
    "GetPathProtocol" => MediaProtocol.File, "GetMediaStreams" => Array.Empty<MediaStream>(),
    "GetStaticMediaSources" => Array.Empty<MediaSourceInfo>(), _ => Stub.Default(method.ReturnType)
});
var observations = new List<object>();
foreach(var sample in new[] { "empty", "sources-kept", "sources-deleted", "later-null-plan", "kept-null-plan", "later-external-failure", "persistence-failure", "sqlite-trigger-failure", "later-internal-readonly", "later-source-readonly", "parent-event", "cached-root-parent", "relational-closure" }) {
 var root=Path.GetFullPath(Path.Combine(args[0],sample));Directory.CreateDirectory(root);
    var metadata = Path.Combine(root, "metadata");
    var configuration = new ServerConfiguration { CacheSize = 64,
        EnableCaseSensitiveItemIds = false, EnableNormalizedItemByNameIds = true };
    var paths = Stub.Make<IServerApplicationPaths>((method, values) => method.Name switch {
        "get_ProgramDataPath" => root, "get_InternalMetadataPath" => metadata,
        "get_DataPath" => Path.Combine(root, "data"), "get_TrickplayPath" => Path.Combine(root, "data", "trickplay"), "get_MusicGenrePath" => Path.Combine(metadata, "MusicGenre"),
        "get_GenrePath" => Path.Combine(metadata, "Genre"), "get_StudioPath" => Path.Combine(metadata, "Studio"),
        _ => Stub.Default(method.ReturnType)
    });
    var config = Stub.Make<IServerConfigurationManager>((method, values) => method.Name switch {
        "get_Configuration" => configuration, "get_ApplicationPaths" => paths,
        "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = config;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => {
        if (method.Name == "ReverseVirtualPath") {
            var value = (string?)values![0];
            return value?.StartsWith(metadata, StringComparison.Ordinal) == true ? "%MetadataPath%" + value[metadata.Length..] : value;
        }
        if (method.Name == "ExpandVirtualPath") {
            var value = (string?)values![0];
            return value?.StartsWith("%MetadataPath%", StringComparison.Ordinal) == true ? metadata + value[14..] : value;
        }
        return Stub.Default(method.ReturnType);
    });
    var factory = new SqlFactory(Path.Combine(root, "native.db"));
    using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var persistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);

 var calls=new List<object>();
 var pathManager=new PathManager(NullLogger<PathManager>.Instance,config,paths);
 var external=new ExternalDataManager(null!,null!,pathManager,null!,null!,NullLogger<ExternalDataManager>.Instance);
 var forwarding=Stub.Make<IItemPersistenceService>((method,values)=>{
  if(method.Name=="DeleteItem") { calls.Add(new {action="persist",ids=((IEnumerable<Guid>)values![0]!).ToArray()}); if(sample=="persistence-failure") throw new IOException("Controlled persistence failure"); }
  return Stub.Forward(persistence,method,values);
 });
 var manager=(LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
 Field(manager,"_configurationManager",config);Field(manager,"_logger",NullLogger<LibraryManager>.Instance);
 Field(manager,"_cache",Activator.CreateInstance(typeof(LibraryManager).GetField("_cache",BindingFlags.Instance|BindingFlags.NonPublic)!.FieldType,[64])!);
 Field(manager,"_itemRepository",repository);Field(manager,"_persistenceService",forwarding);Field(manager,"_pathManager",pathManager);
 Field(manager,"_userRootFolder",new UserRootFolder {Children=[]});
 var externalProxy=Stub.Make<IExternalDataManager>((method,values)=> {
  if(method.Name=="DeleteExternalItemFiles") { var item=(BaseItem)values![0]!;calls.Add(new {action="external",id=item.Id,name=item.Name});
   if(sample=="later-external-failure" && item.Name=="Second") throw new IOException("Controlled external failure"); }
  return Stub.Forward(external,method,values);
 });
 Field(manager,"_externalDataManagerFactory",new Lazy<IExternalDataManager>(()=>externalProxy));
 BaseItem.LibraryManager=Stub.Make<ILibraryManager>((method,values)=>method.Name switch {"GetCollectionFolders"=>new List<Folder>(),"GetLibraryOptions"=>new LibraryOptions(),_=>Stub.Forward(manager,method,values)});
 manager.ItemRemoved+=(_,change)=>calls.Add(new {action="removed",id=change.Item.Id,name=change.Item.Name,parent=change.Parent?.Id});
 var roots=sample=="empty"?new List<BaseItem>():new List<BaseItem> {
  new Genre {Id=Id(10),Name="First",Path=Path.Combine(metadata,"Genre","First")},
  new Studio {Id=Id(20),Name="Second",Path=sample.EndsWith("null-plan",StringComparison.Ordinal)?null:Path.Combine(metadata,"Studio","Second")}
 };
 var allItems=new List<BaseItem>(roots);
 var warmed=new List<Guid>();
 if(sample is "parent-event" or "cached-root-parent" or "relational-closure") {
  var keeper=new Folder {Id=Id(90),Name="Keeper",Path=Path.Combine(metadata,"keeper")};allItems.Insert(0,keeper);
  if(sample=="cached-root-parent") {
   roots=[new Folder {Id=Id(10),Name="First",Path=Path.Combine(metadata,"First"),ParentId=Id(20)},
    new Folder {Id=Id(20),Name="Second",Path=Path.Combine(metadata,"Second"),ParentId=keeper.Id}];
   allItems=new List<BaseItem> {keeper,roots[1],roots[0]};warmed.AddRange([Id(10),Id(20),Id(90)]);
  } else roots[0].ParentId=keeper.Id;
  if(sample=="relational-closure") {
   allItems.AddRange([new Video {Id=Id(31),Name="Child",Path=Path.Combine(metadata,"closure","child.mkv"),ParentId=Id(10),IsInMixedFolder=true},
    new Audio {Id=Id(32),Name="Nested",Path=Path.Combine(metadata,"closure","nested.flac"),ParentId=Id(31)},
    new Book {Id=Id(33),Name="Owned",Path=Path.Combine(metadata,"closure","owned.pdf"),OwnerId=Id(10)},
    new Audio {Id=Id(34),Name="AncestorOne",Path=Path.Combine(metadata,"closure","one.flac"),ParentId=Id(90)},
    new Audio {Id=Id(35),Name="AncestorTwo",Path=Path.Combine(metadata,"closure","two.flac"),ParentId=Id(90)},
    new Audio {Id=Id(36),Name="AncestorThree",Path=Path.Combine(metadata,"closure","three.flac"),ParentId=Id(90)}]);
   warmed.Add(Id(31));
  }
 }
 if(allItems.Count>0) persistence.SaveItems(allItems,CancellationToken.None);
 foreach(var item in allItems) {
  if(item.Path is not null) {
   if(roots.Contains(item)||item.IsFolder) {Directory.CreateDirectory(item.Path);File.WriteAllText(Path.Combine(item.Path,"poster.jpg"),"source");}
   else {Directory.CreateDirectory(Path.GetDirectoryName(item.Path)!);File.WriteAllText(item.Path,"source");}
  }
  Directory.CreateDirectory(item.GetInternalMetadataPath());File.WriteAllText(Path.Combine(item.GetInternalMetadataPath(),"internal.jpg"),"internal");
  foreach(var location in pathManager.GetExtractedDataPaths(item)) {Directory.CreateDirectory(location);File.WriteAllText(Path.Combine(location,"data.bin"),"external");}
 }
 if(sample=="relational-closure") using(var context=factory.CreateDbContext()) {
  var user=new Jellyfin.Database.Implementations.Entities.User("Unsafe User","oracle.auth","oracle.reset") {Id=Id(99),InternalId=1};context.Users.Add(user);
  foreach(var key in new[] {10,20,31}) context.UserData.Add(new Jellyfin.Database.Implementations.Entities.UserData {
   ItemId=Id(key),Item=null!,UserId=user.Id,User=user,CustomDataKey="shared",PlayCount=key,
   LastPlayedDate=new DateTime(2026,10,11,1,2,key,DateTimeKind.Utc),PlaybackPositionTicks=9007199254740993});
  foreach(var pair in new[] {(34,10),(35,34),(36,35)}) context.AncestorIds.Add(new Jellyfin.Database.Implementations.Entities.AncestorId {Item=null!,ParentItem=null!,ItemId=Id(pair.Item1),ParentItemId=Id(pair.Item2)});
  context.LinkedChildren.AddRange(new Jellyfin.Database.Implementations.Entities.LinkedChildEntity {ParentId=Id(90),ChildId=Id(10),SortOrder=0,ChildType=Jellyfin.Database.Implementations.Entities.LinkedChildType.Manual},
    new Jellyfin.Database.Implementations.Entities.LinkedChildEntity {ParentId=Id(10),ChildId=Id(36),SortOrder=0,ChildType=Jellyfin.Database.Implementations.Entities.LinkedChildType.Manual});context.SaveChanges();
 }
 foreach(var key in warmed) _=manager.GetItemById(key);
 if(sample=="later-internal-readonly") File.SetAttributes(Path.Combine(roots[1].GetInternalMetadataPath(),"internal.jpg"),FileAttributes.ReadOnly);
 if(sample=="later-source-readonly") File.SetAttributes(Path.Combine(roots[1].Path!,"poster.jpg"),FileAttributes.ReadOnly);
 object Snapshot() {using var context=factory.CreateDbContext();var entity=context.Model.FindEntityType(typeof(BaseItemEntity))!;var table=StoreObjectIdentifier.Table(entity.GetTableName()!,entity.GetSchema());
 return new {rows=context.BaseItems.AsNoTracking().OrderBy(row=>row.Id).ToArray().Select(row=>entity.GetProperties().ToDictionary(property=>property.GetColumnName(table)!,property=>property.PropertyInfo!.GetValue(row))),
 links=context.LinkedChildren.AsNoTracking().OrderBy(row=>row.ParentId).ThenBy(row=>row.SortOrder).ToArray().Select(row=>Columns(row,context)).ToArray(),
 users=context.Users.AsNoTracking().OrderBy(row=>row.Id).ToArray().Select(row=>Columns(row,context)).ToArray(),
 userData=context.UserData.AsNoTracking().OrderBy(row=>row.ItemId).ThenBy(row=>row.UserId).ThenBy(row=>row.CustomDataKey).ToArray().Select(row=>Columns(row,context)).ToArray(),
 tree=new[] {metadata,Path.Combine(root,"data")}.Where(Directory.Exists).SelectMany(folder=>Directory.EnumerateFileSystemEntries(folder,"*",SearchOption.AllDirectories)).OrderBy(path=>path,StringComparer.Ordinal)
 .Select(path=>new {path=Path.GetRelativePath(root,path).Replace('\\','/'),directory=Directory.Exists(path),sha256=File.Exists(path)?Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant():null}).ToArray()}; }
 var before=Snapshot();
 if(sample=="sqlite-trigger-failure") {using var context=factory.CreateDbContext();context.Database.ExecuteSqlRaw("CREATE TRIGGER controlled_failure BEFORE DELETE ON BaseItems BEGIN SELECT RAISE(ABORT, 'Controlled database failure'); END;");}
 var deleteSource=sample is not "sources-kept" and not "kept-null-plan";
 var started=DateTime.UtcNow;Exception? failure=null;try {manager.DeleteItemsUnsafeFast(roots,deleteSourceFiles:deleteSource);}catch(Exception error){failure=error;}var ended=DateTime.UtcNow;
 observations.Add(new {sample,root,rootIds=roots.Select(item=>item.Id),warmed,deleteSourceFiles=deleteSource,started,ended,before,after=Snapshot(),calls,
  warmedAfter=warmed.Select(key=>new {id=key,exists=manager.GetItemById(key) is not null}).ToArray(),failure=failure is null?null:new {type=failure.GetType().FullName,failure.Message}});
 foreach(var folder in new[] {metadata,Path.Combine(root,"data")}.Where(Directory.Exists)) foreach(var file in Directory.EnumerateFiles(folder,"*",SearchOption.AllDirectories)) File.SetAttributes(file,FileAttributes.Normal);
}
var assemblies=AppDomain.CurrentDomain.GetAssemblies().Where(assembly=>!assembly.IsDynamic&&!string.IsNullOrEmpty(assembly.Location)).OrderBy(assembly=>assembly.GetName().Name)
 .Select(assembly=>new {name=assembly.GetName().Name,sha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()}).ToArray();
File.WriteAllText(args[1],JsonSerializer.Serialize(new {actualLibraryManagerUnsafeFast=true,actualSqlitePersistence=true,actualPathManager=true,actualExternalDataFiles=true,mediaOpened=false,portOpened=false,observations,assemblies},new JsonSerializerOptions {WriteIndented=true})+"\n");
Console.WriteLine(JsonSerializer.Serialize(new {cases=observations.Count}));
Guid Id(int number)=>Guid.Parse("ba360000-0000-0000-0000-"+number.ToString("D12"));
void Field(object owner,string name,object value)=>owner.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(owner,value);
Dictionary<string,object?> Columns(object row,JellyfinDbContext context) {
 var entity=context.Model.FindEntityType(row.GetType())!;var table=StoreObjectIdentifier.Table(entity.GetTableName()!,entity.GetSchema());
 return entity.GetProperties().ToDictionary(property=>property.GetColumnName(table)!,property=>property.PropertyInfo!.GetValue(row));
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var proxy = Create<T, Stub>(); ((Stub)(object)proxy).Handler = handler; return proxy;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values) {
        try { return method.Invoke(target, values); }
        catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; }
    }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
