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
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using BaseItemEntity = Jellyfin.Database.Implementations.Entities.BaseItemEntity;
using ItemValueType = Jellyfin.Database.Implementations.Entities.ItemValueType;

SQLitePCL.Batteries_V2.Init();
SynchronizationContext.SetSynchronizationContext(new InlineContext());
Video.RecordingsManager=Stub.Make<IRecordingsManager>((method,values)=>Stub.Default(method.ReturnType));
BaseItem.MediaSegmentManager=Stub.Make<IMediaSegmentManager>((method,values)=>Stub.Default(method.ReturnType));
BaseItem.MediaSourceManager=Stub.Make<IMediaSourceManager>((method,values)=>method.Name switch {
 "GetPathProtocol"=>MediaProtocol.File,"GetMediaStreams"=>Array.Empty<MediaStream>(),
 "GetMediaAttachments"=>Array.Empty<MediaAttachment>(),_=>Stub.Default(method.ReturnType)});
var input=File.ReadAllBytes(args[0]);var samples=JsonSerializer.Deserialize<Sample[]>(input)!;
var results=new List<object>();
foreach(var sample in samples) {
 var root=Path.GetFullPath(Path.Combine(args[1],results.Count.ToString()));Directory.CreateDirectory(root);
 var metadata=Path.Combine(root,"metadata");
 var paths=Stub.Make<IServerApplicationPaths>((method,values)=>method.Name switch {
  "get_ProgramDataPath"=>root,"get_InternalMetadataPath"=>metadata,"get_DataPath"=>Path.Combine(root,"data"),
  "get_TrickplayPath"=>Path.Combine(root,"data","trickplay"),"get_GenrePath"=>Path.Combine(metadata,"Genre"),
  "get_StudioPath"=>Path.Combine(metadata,"Studio"),_=>Stub.Default(method.ReturnType)});
 var config=Stub.Make<IServerConfigurationManager>((method,values)=>method.Name switch {
  "get_Configuration"=>new ServerConfiguration {CacheSize=64},"get_ApplicationPaths"=>paths,
  "GetConfiguration"=>new MetadataConfiguration(),_=>Stub.Default(method.ReturnType)});
 BaseItem.ConfigurationManager=config;BaseItem.Logger=NullLogger<BaseItem>.Instance;
 BaseItem.LocalizationManager=new LocalizationManager(config,NullLogger<LocalizationManager>.Instance);
 var fs=new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance,paths,[]);BaseItem.FileSystem=fs;
 var appHost=Stub.Make<IServerApplicationHost>((method,values)=>method.Name is "ReverseVirtualPath" or "ExpandVirtualPath"?values![0]:Stub.Default(method.ReturnType));
 var factory=new SqlFactory(Path.Combine(root,"native.db"));
 using(var context=factory.CreateDbContext())context.Database.EnsureCreated();
 var repository=new BaseItemRepository(factory,appHost,new ItemTypeLookup(),config,NullLogger<BaseItemRepository>.Instance);
 BaseItem.ItemRepository=repository;
 var realPersistence=new ItemPersistenceService(factory,appHost,NullLogger<ItemPersistenceService>.Instance);
 var calls=new List<object>();var logs=new List<object>();var progress=new List<double>();
 var tokenSource=new CancellationTokenSource();bool active=false;
 var persistence=Stub.Make<IItemPersistenceService>((method,values)=> {
  if(active&&method.Name=="DeleteItem")calls.Add(new {action="persist",ids=((IEnumerable<Guid>)values![0]!).ToArray()});
  return Stub.Forward(realPersistence,method,values);
 });
 var pathManager=new PathManager(NullLogger<PathManager>.Instance,config,paths);
 var pathProxy=Stub.Make<IPathManager>((method,values)=> {
  if(active&&method.Name=="GetExtractedDataPaths") {
   var item=(BaseItem)values![0]!;calls.Add(new {action="extracted",id=item.Id});
   if(sample.FailExtracted)throw new IOException("Controlled extracted path failure");
  }
  return Stub.Forward(pathManager,method,values);
 });
 var external=new ExternalDataManager(null!,null!,pathManager,null!,null!,NullLogger<ExternalDataManager>.Instance);
 var externalProxy=Stub.Make<IExternalDataManager>((method,values)=> {
  if(active&&method.Name=="DeleteExternalItemFiles")calls.Add(new {action="external",id=((BaseItem)values![0]!).Id});
  return Stub.Forward(external,method,values);
 });
 var manager=(LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
 Field(manager,"_configurationManager",config);Field(manager,"_logger",NullLogger<LibraryManager>.Instance);
 Field(manager,"_cache",Activator.CreateInstance(typeof(LibraryManager).GetField("_cache",BindingFlags.Instance|BindingFlags.NonPublic)!.FieldType,[64])!);
 Field(manager,"_itemRepository",repository);Field(manager,"_persistenceService",persistence);Field(manager,"_pathManager",pathManager);
 Field(manager,"_linkedChildrenService",new LinkedChildrenService(factory,new ItemTypeLookup(),repository));
 Field(manager,"_fileSystem",fs);Field(manager,"_userRootFolder",new UserRootFolder {Children=[]});
 Field(manager,"_externalDataManagerFactory",new Lazy<IExternalDataManager>(()=>externalProxy));
 var library=Stub.Make<ILibraryManager>((method,values)=> {
  if(method.Name=="GetCollectionFolders")return new List<Folder>();
  if(method.Name=="GetLibraryOptions")return new LibraryOptions();
  if(active&&method.Name=="GetItemIds") {
   var query=(InternalItemsQuery)values![0]!;calls.Add(new {action="ids",query.HasDeadParentId});
   if(sample.FailSelection)throw new IOException("Controlled selection failure");
  }
  if(active&&method.Name=="GetItemList") {
   var query=(InternalItemsQuery)values![0]!;calls.Add(new {action="playlists",query.Recursive,kinds=query.IncludeItemTypes});
   if(sample.FailPlaylists)throw new IOException("Controlled playlist selection failure");
  }
  if(active&&method.Name=="GetItemById") {
   var id=values![0] is Guid guid?guid:Guid.Parse((string)values[0]!);calls.Add(new {action="lookup",id});
   if(sample.FailLookup)throw new IOException("Controlled lookup failure");
   if(sample.NullLookup)return null;
  }
  if(active&&method.Name=="DeleteItem") {
   var item=(BaseItem)values![0]!;var options=(DeleteOptions)values[1]!;
   calls.Add(new {action="delete",id=item.Id,options.DeleteFileLocation,options.DeleteFromExternalProvider});
   if(sample.FailDelete)throw new IOException("Controlled delete failure");
   var result=Stub.Forward(manager,method,values);
   if(sample.ChangeNextParent&&item.Id==Id(10))using(var context=factory.CreateDbContext()) {
    var nextId=Id(11);var next=context.BaseItems.Single(row=>row.Id==nextId);next.ParentId=Id(900);context.SaveChanges();
   }
   if(sample.CancelAfterDelete)tokenSource.Cancel();
   return result;
  }
  return Stub.Forward(manager,method,values);
 });
 BaseItem.LibraryManager=library;
 manager.ItemRemoved+=(_,change)=>calls.Add(new {action="removed",id=change.Item.Id,parent=change.Parent?.Id});
 var items=new List<BaseItem>();
 var keeper=new Folder {Id=Id(900),Name="Keeper",Path=Path.Combine(root,"media")};
 if(sample.DeadCount>0||sample.Playlists.Length>0)items.Add(keeper);
 for(var index=0;index<sample.DeadCount;index++) {
  BaseItem item=sample.Movie?new Movie {VideoType=VideoType.VideoFile,IsInMixedFolder=true}:index%2==0?new Genre():new Studio();
  item.Id=Id(10+index);item.Name="Dead "+index;item.ParentId=BaseItemRepository.PlaceholderId;
  item.Path=sample.Movie?Path.Combine(root,"media","dead-"+index+".mkv"):Path.Combine(metadata,item.GetType().Name,item.Name);
  items.Add(item);
 }
 foreach(var (kind,index) in sample.Playlists.Select((kind,index)=>(kind,index))) {
  var extension=kind=="xml"?".xml":kind=="no-extension"?"":kind=="trailing-dot"?".":".m3u";
  var item=new Playlist {Id=Id(100+index),Name="Playlist "+index,ParentId=sample.NestedPlaylists&&index>0?Id(100):keeper.Id,
   Path=kind=="null"?null:kind=="empty"?"":Path.Combine(root,"media","playlist-"+index+extension)};
  items.Add(item);
  if(kind=="present")Write(item.Path,"#EXTM3U\n");
  if(kind=="directory")Directory.CreateDirectory(item.Path);
 }
 if(items.Count>0)realPersistence.SaveItems(items,CancellationToken.None);
 foreach(var item in items) {
  Write(Path.Combine(item.GetInternalMetadataPath(),"internal.txt"),"internal");
  foreach(var location in pathManager.GetExtractedDataPaths(item))Write(Path.Combine(location,"data.bin"),"extracted");
  if(item is Movie)Write(item.Path,"original media");
 }
 using(var context=factory.CreateDbContext()) {
  var orphan=new Jellyfin.Database.Implementations.Entities.ItemValue {ItemValueId=Id(800),Type=ItemValueType.Genre,Value="Orphan",CleanValue="orphan"};
  context.ItemValues.Add(orphan);
  if(items.Count>0) {
   var mapped=new Jellyfin.Database.Implementations.Entities.ItemValue {ItemValueId=Id(801),Type=ItemValueType.Genre,Value="Mapped",CleanValue="mapped"};
   context.ItemValues.Add(mapped);context.ItemValuesMap.Add(new Jellyfin.Database.Implementations.Entities.ItemValueMap {Item=null!,ItemValue=mapped,ItemId=items[0].Id,ItemValueId=mapped.ItemValueId});
  }
  context.SaveChanges();
 }
 object Snapshot() {
  using var context=factory.CreateDbContext();
  return new {rows=context.BaseItems.AsNoTracking().OrderBy(row=>row.Id).ToArray().Select(row=>Columns(row,context)).ToArray(),
   values=context.ItemValues.AsNoTracking().OrderBy(row=>row.ItemValueId).ToArray().Select(row=>Columns(row,context)).ToArray(),
   maps=context.ItemValuesMap.AsNoTracking().OrderBy(row=>row.ItemId).ToArray().Select(row=>Columns(row,context)).ToArray(),
   tree=new[] {metadata,Path.Combine(root,"data"),Path.Combine(root,"media")}.Where(Directory.Exists)
    .SelectMany(folder=>Directory.EnumerateFileSystemEntries(folder,"*",SearchOption.AllDirectories)).OrderBy(path=>path,StringComparer.Ordinal)
    .Select(path=>new {path=Path.GetRelativePath(root,path).Replace('\\','/'),directory=Directory.Exists(path),
     sha256=File.Exists(path)?Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant():null}).ToArray()};
 }
 var before=Snapshot();
 if(sample.FailValues)using(var context=factory.CreateDbContext())context.Database.ExecuteSqlRaw("CREATE TRIGGER controlled_values_failure BEFORE DELETE ON ItemValues BEGIN SELECT RAISE(ABORT, 'Controlled values failure'); END;");
 if(sample.CancelInitial)tokenSource.Cancel();
 active=true;Exception? failure=null;
 try {await new CleanDatabaseScheduledTask(library,new RecorderLogger<CleanDatabaseScheduledTask>(logs),factory,pathProxy)
  .Run(new ProgressSink(value=>{progress.Add(value);if(sample.CancelValuesProgress&&value==60)tokenSource.Cancel();}),tokenSource.Token);}
 catch(Exception error){failure=error;if(error is NullReferenceException)Console.Error.WriteLine(sample.Name+": "+error);}
 active=false;
 results.Add(new {sample,root,before,after=Snapshot(),calls,logs,progress,
  failure=failure is null?null:new {type=failure.GetType().Name,failure.Message}});
}
var assemblies=AppDomain.CurrentDomain.GetAssemblies().Where(assembly=>!assembly.IsDynamic&&!string.IsNullOrEmpty(assembly.Location))
 .OrderBy(assembly=>assembly.GetName().Name).Select(assembly=>new {name=assembly.GetName().Name,
  sha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()}).ToArray();
File.WriteAllText(args[2],JsonSerializer.Serialize(new {actualPostScanTask=true,actualRepository=true,actualLibraryManagerDelete=true,
 actualSqlite=true,actualPathManager=true,mediaOpened=false,portOpened=false,inlineProgressContext=true,
 inputSha256=Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant(),results,assemblies},new JsonSerializerOptions {WriteIndented=true})+"\n");
Console.WriteLine(JsonSerializer.Serialize(new {cases=results.Count}));
Guid Id(int number)=>Guid.Parse("ba420000-0000-0000-0000-"+number.ToString("D12"));
void Field(object owner,string name,object value)=>owner.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(owner,value);
void Write(string filename,string text){Directory.CreateDirectory(Path.GetDirectoryName(filename)!);File.WriteAllText(filename,text);}
Dictionary<string,object?> Columns(object row,JellyfinDbContext context) {
 var entity=context.Model.FindEntityType(row.GetType())!;var table=StoreObjectIdentifier.Table(entity.GetTableName()!,entity.GetSchema());
 return entity.GetProperties().ToDictionary(property=>property.GetColumnName(table)!,property=>property.PropertyInfo!.GetValue(row));
}
public sealed class Sample {
 public string Name {get;set;}="";public int DeadCount {get;set;}public bool Movie {get;set;}public string[] Playlists {get;set;}=[];
 public bool CancelInitial {get;set;}public bool CancelAfterDelete {get;set;}public bool FailSelection {get;set;}
 public bool FailLookup {get;set;}public bool NullLookup {get;set;}public bool FailDelete {get;set;}
 public bool FailExtracted {get;set;}public bool FailValues {get;set;}
 public bool NestedPlaylists {get;set;}public bool FailPlaylists {get;set;}public bool CancelValuesProgress {get;set;}public bool ChangeNextParent {get;set;}
}
public sealed class InlineContext:SynchronizationContext {public override void Post(SendOrPostCallback callback,object? state)=>callback(state);}
public sealed class ProgressSink(Action<double> callback):IProgress<double> {public void Report(double value)=>callback(value);}
public class Stub:DispatchProxy {
 public Func<MethodInfo,object?[]?,object?> Handler=null!;
 protected override object? Invoke(MethodInfo? method,object?[]? values)=>Handler(method!,values);
 public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T:class {var proxy=Create<T,Stub>();((Stub)(object)proxy).Handler=handler;return proxy;}
 public static object? Default(Type type)=>type==typeof(void)?null:type==typeof(Task)?Task.CompletedTask:type.IsValueType?Activator.CreateInstance(type):null;
 public static object? Forward(object target,MethodInfo method,object?[]? values){try{return method.Invoke(target,values);}catch(TargetInvocationException error){ExceptionDispatchInfo.Capture(error.InnerException!).Throw();throw;}}
}
public class SqlFactory(string filename):IDbContextFactory<JellyfinDbContext> {
 public JellyfinDbContext CreateDbContext()=>new(new DbContextOptionsBuilder<JellyfinDbContext>()
  .UseSqlite($"Data Source={filename};Pooling=False").Options,NullLogger<JellyfinDbContext>.Instance,
  new SqliteDatabaseProvider(null!,NullLogger<SqliteDatabaseProvider>.Instance),new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
public sealed class RecorderLogger<T>(List<object> entries):ILogger<T> {
 public bool IsEnabled(LogLevel level)=>true;public IDisposable? BeginScope<TState>(TState state) where TState:notnull=>null;
 public void Log<TState>(LogLevel level,EventId eventId,TState state,Exception? error,Func<TState,Exception?,string> formatter)=>entries.Add(new {level=level.ToString(),message=formatter(state,error)});
}
