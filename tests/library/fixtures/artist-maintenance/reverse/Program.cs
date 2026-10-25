using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Library.Validators;
using Emby.Server.Implementations.Localization;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
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
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Entities;

SQLitePCL.Batteries_V2.Init();
BaseItem.MediaSourceManager=Stub.Make<IMediaSourceManager>((method,values)=>method.Name switch {
 "GetPathProtocol"=>MediaProtocol.File,"GetMediaStreams"=>Array.Empty<MediaStream>(),"GetStaticMediaSources"=>Array.Empty<MediaSourceInfo>(),_=>Stub.Default(method.ReturnType)});
Video.RecordingsManager=Stub.Make<IRecordingsManager>((method,values)=>Stub.Default(method.ReturnType));
var input=File.ReadAllBytes(args[0]);
var samples=JsonSerializer.Deserialize<Sample[]>(input,new JsonSerializerOptions {PropertyNameCaseInsensitive=true})!;
var results=new List<object>();
foreach(var kind in new[] {"MusicArtist"}) foreach(var sample in samples) {
 var root=Path.GetFullPath(Path.Combine(args[1],kind,results.Count.ToString()));Directory.CreateDirectory(root);
 var metadata=Path.Combine(root,"metadata");var settings=new ServerConfiguration {CacheSize=64,EnableNormalizedItemByNameIds=true};
 var paths=Stub.Make<IServerApplicationPaths>((method,values)=>method.Name switch {
  "get_ProgramDataPath"=>root,"get_InternalMetadataPath"=>metadata,"get_DataPath"=>Path.Combine(root,"data"),
  "get_ArtistsPath"=>Path.Combine(metadata,"artists"),"get_TrickplayPath"=>Path.Combine(root,"data","trickplay"),"get_GenrePath"=>Path.Combine(metadata,"Genre"),
  "get_StudioPath"=>Path.Combine(metadata,"Studio"),"get_MusicGenrePath"=>Path.Combine(metadata,"MusicGenre"),_=>Stub.Default(method.ReturnType)});
 var config=Stub.Make<IServerConfigurationManager>((method,values)=>method.Name switch {
  "get_Configuration"=>settings,"get_ApplicationPaths"=>paths,"GetConfiguration"=>new MetadataConfiguration(),_=>Stub.Default(method.ReturnType)});
 BaseItem.ConfigurationManager=config;BaseItem.Logger=NullLogger<BaseItem>.Instance;
 BaseItem.LocalizationManager=new LocalizationManager(config,NullLogger<LocalizationManager>.Instance);
 BaseItem.FileSystem=new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance,paths,[]);
 var appHost=Stub.Make<IServerApplicationHost>((method,values)=>method.Name switch {
  "ReverseVirtualPath"=>((string?)values![0])?.Replace(metadata,"%MetadataPath%",StringComparison.Ordinal),
  "ExpandVirtualPath"=>((string?)values![0])?.Replace("%MetadataPath%",metadata,StringComparison.Ordinal),_=>Stub.Default(method.ReturnType)});
 var factory=new SqlFactory(Path.Combine(root,"native.sqlite"));using(var db=factory.CreateDbContext()) db.Database.EnsureCreated();
 var repository=new BaseItemRepository(factory,appHost,new ItemTypeLookup(),config,NullLogger<BaseItemRepository>.Instance);BaseItem.ItemRepository=repository;
 var persistence=new ItemPersistenceService(factory,appHost,NullLogger<ItemPersistenceService>.Instance);
 var calls=new List<object>();var lookupDirectories=new List<object>();var active=false;
 var forwarding=Stub.Make<IItemPersistenceService>((method,values)=> {
  if(active&&method.Name=="DeleteItem") calls.Add(new {action="persist",ids=((IEnumerable<Guid>)values![0]!).ToArray()});
  return Stub.Forward(persistence,method,values);
 });
 var manager=(LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
 Field(manager,"_configurationManager",config);Field(manager,"_logger",NullLogger<LibraryManager>.Instance);
 Field(manager,"_cache",Activator.CreateInstance(typeof(LibraryManager).GetField("_cache",BindingFlags.Instance|BindingFlags.NonPublic)!.FieldType,[64])!);
 Field(manager,"_linkedChildrenService",new LinkedChildrenService(factory,new ItemTypeLookup(),repository));
 Field(manager,"_itemRepository",repository);Field(manager,"_persistenceService",forwarding);Field(manager,"_userRootFolder",new UserRootFolder {Children=[]});
 var pathManager=new PathManager(NullLogger<PathManager>.Instance,config,paths);Field(manager,"_pathManager",pathManager);
 var external=new ExternalDataManager(null!,null!,pathManager,null!,null!,NullLogger<ExternalDataManager>.Instance);
 Field(manager,"_externalDataManagerFactory",new Lazy<IExternalDataManager>(()=>Stub.Make<IExternalDataManager>((method,values)=> {
  if(active&&method.Name=="DeleteExternalItemFiles") {
   var item=(BaseItem)values![0]!;calls.Add(new {action="external",id=item.Id,name=item.Name});
   if(sample.FailExternal&&item.Name=="DeadSecond") throw new IOException("Controlled external failure");
  }
  return Stub.Forward(external,method,values);
 })));
 BaseItem.LibraryManager=Stub.Make<ILibraryManager>((method,arguments)=>method.Name switch {
 "GetCollectionFolders"=>new List<Folder>(),"GetLibraryOptions"=>new LibraryOptions(),_=>Stub.Forward(manager,method,arguments)});
 var sourceRows=new List<BaseItem>();var values=new List<ItemValue>();var maps=new List<ItemValueMap>();
 void Add(int number,string name,string clean,Type type,bool mapped=true,int? valueType=null) {
  BaseItem item=type==typeof(Audio)?new Audio():type==typeof(AudioBook)?new AudioBook():type==typeof(MusicVideo)?new MusicVideo():type==typeof(MusicAlbum)?new MusicAlbum():type==typeof(MusicArtist)?new MusicArtist():new Movie();
  item.Id=Id(number);item.Name=name+" source";sourceRows.Add(item);
  var valueId=Id(number+1000);values.Add(new ItemValue {ItemValueId=valueId,Type=(ItemValueType)(valueType??0),Value=name,CleanValue=clean});
  if(mapped) maps.Add(new ItemValueMap {ItemId=item.Id,ItemValueId=valueId,Item=null!,ItemValue=null!});
 }
 for(var i=0;i<sample.Names.Length;i++) Add(i+1,sample.Names[i],"group-"+i.ToString("D4"),typeof(Movie));
 if(sample.SourceKinds) {
  Add(10,"Audio","audio",typeof(Audio));Add(11,"Book","book",typeof(AudioBook));Add(12,"MusicVideo","video",typeof(MusicVideo));
  Add(13,"Album","album",typeof(MusicAlbum));Add(14,"Artist","artist",typeof(MusicArtist));Add(15,"Unmapped","unmapped",typeof(Movie),false);
  Add(16,"Z lower","same",typeof(Movie));Add(17,"A upper","same",typeof(Movie));Add(18,"Tag","tag",typeof(Movie),true,4);Add(19,"AlbumArtist","album-artist",typeof(Movie),true,1);
 }
 Guid ArtistId(string name)=>(Guid)typeof(LibraryManager).GetMethod("GetItemByNameId",BindingFlags.Instance|BindingFlags.NonPublic)!
  .MakeGenericMethod(typeof(MusicArtist)).Invoke(manager,[MusicArtist.GetPath(name)])!;
 var byNames=new List<BaseItem>();
 BaseItem ByName(int number,string? name,string type,bool locked=false) {
  BaseItem item=new MusicArtist();
  item.Id=Id(number);item.Name=name!;item.Path=Path.Combine(metadata,"artists","Initial"+number);
  item.DateLastRefreshed=sample.NeverRefreshed?default:new DateTime(2026,10,1,0,0,0,DateTimeKind.Utc);
  item.IsLocked=locked;item.Overview="Curated " + name;byNames.Add(item);return item;
 }
 for(var i=0;i<sample.Existing.Length;i++) ByName(100+i,sample.Existing[i],kind);
 if(sample.InitialLookup is not null) {
  var item=ByName(106,sample.InitialName,kind);
  item.Id=ArtistId(sample.InitialLookup!);
  if(sample.InitialOwner||sample.InitialAlternate) {
   sourceRows.Add(new Folder {Id=Id(901),Name="Initial identity anchor"});
   if(sample.InitialOwner) item.OwnerId=Id(901);
  }

 }
 if(sample.Physical) {
  sourceRows.Add(new Folder {Id=Id(905),Name="Physical parent",Path=Path.Combine(root,"physical")});
  var physical=ByName(150,"Rock",kind);physical.ParentId=Id(905);physical.Path=Path.Combine(root,"physical","Rock");physical.ForcedSortName="zz physical";
  if(sample.PhysicalTwin) {var twin=ByName(149,"Rock",kind);twin.ParentId=Id(905);twin.Path=Path.Combine(root,"physical","Rock Twin");twin.ForcedSortName="aa physical";}
 }
 if(sample.NullInitialName) ByName(105,null,kind);
 if(sample.Dead) {ByName(200,"DeadFirst",kind);ByName(201,"DeadSecond",kind);if(kind=="Genre") ByName(202,"DeadMusic","MusicGenre");}
 if(sample.Locked) ByName(203,"DeadLocked",kind,true);
 if(sample.DeadNullPath) byNames.Single(item=>item.Id==Id(201)).Path=null;
 if(sample.Unmapped) values.Add(new ItemValue {ItemValueId=Id(2001),Type=(ItemValueType)0,Value="DeadFirst",CleanValue="unrelated"});
 if(sample.SeparateSeeds) {
   persistence.SaveItems(sourceRows.ToArray(),CancellationToken.None);
   foreach(var item in sample.ReverseSeeds?byNames.AsEnumerable().Reverse():byNames) persistence.SaveItems([item],CancellationToken.None);
  } else persistence.SaveItems((sample.ReverseBatch?sourceRows.Concat(byNames).Reverse():sourceRows.Concat(byNames)).ToArray(),CancellationToken.None);
 using(var db=factory.CreateDbContext()) {
  if(sample.InitialAlternate) {
   var initialId=ArtistId(sample.InitialLookup!);
   db.BaseItems.Single(row=>row.Id==initialId).PrimaryVersionId=Id(901);
  }
  db.ItemValues.AddRange(values);db.ItemValuesMap.AddRange(maps);db.SaveChanges();
 }
 foreach(var item in byNames) {
  if(item.Path is not null) {Directory.CreateDirectory(item.Path);File.WriteAllText(Path.Combine(item.Path,"poster.jpg"),"source");}
  Directory.CreateDirectory(item.GetInternalMetadataPath());File.WriteAllText(Path.Combine(item.GetInternalMetadataPath(),"internal.jpg"),"internal");
  foreach(var location in pathManager.GetExtractedDataPaths(item)) {Directory.CreateDirectory(location);File.WriteAllText(Path.Combine(location,"data.bin"),"external");}
 }
 var tokenSource=new CancellationTokenSource();if(sample.CancelInitial) tokenSource.Cancel();
 var library=Stub.Make<ILibraryManager>((method,arguments)=> {
  if(method.Name=="GetCollectionFolders") return new List<Folder>();if(method.Name=="GetLibraryOptions") return new LibraryOptions();
  if(method.Name=="GetArtist") {var name=(string)arguments![0]!;if(active) calls.Add(new {action="lookup",name});
   if(sample.CancelLookup==name) throw new OperationCanceledException("Controlled lookup cancellation");
   if(sample.FailLookup.Contains(name)) throw new IOException("Controlled lookup failure");}
  if(method.Name=="GetArtist"&&sample.NullLookup==(string)arguments![0]!) return null;
  var result=Stub.Forward(manager,method,arguments);
  if(active&&method.Name=="GetArtist"&&result is BaseItem returned&&Directory.Exists(returned.Path))
   lookupDirectories.Add(new {returned.Id,returned.Path,created=Directory.GetCreationTimeUtc(returned.Path),modified=Directory.GetLastWriteTimeUtc(returned.Path)});
  return result;
 });BaseItem.LibraryManager=library;
 BaseItem.ProviderManager=Stub.Make<IProviderManager>((method,arguments)=> {
  if(method.Name!="RefreshSingleItem") return Stub.Default(method.ReturnType);
  var item=(BaseItem)arguments![0]!;var options=(MetadataRefreshOptions)arguments[1]!;var token=(CancellationToken)arguments[2]!;
  calls.Add(new {action="refresh",id=item.Id,name=item.Name,metadataMode=(int)options.MetadataRefreshMode,imageMode=(int)options.ImageRefreshMode,
   options.IsAutomated,options.ForceSave,options.ReplaceAllMetadata,options.ReplaceAllImages,options.RemoveOldMetadata});
  if(sample.CancelRefresh==item.Name) tokenSource.Cancel();token.ThrowIfCancellationRequested();
  if(sample.FailRefresh.Contains(item.Name)) throw new IOException("Controlled refresh failure");return Task.FromResult(ItemUpdateType.None);
 });
 manager.ItemAdded+=(_,change)=> {if(active) calls.Add(new {action="added",id=change.Item.Id,name=change.Item.Name});};
 manager.ItemRemoved+=(_,change)=> {if(active) calls.Add(new {action="removed",id=change.Item.Id,name=change.Item.Name,parent=change.Parent?.Id});};
 var names=repository.GetAllArtistNames();
 var selections=manager.GetArtists(names).ToDictionary(entry=>entry.Key,entry=>entry.Value.Select(item=>new {item.Id,item.Name,item.ParentId,item.DateLastRefreshed,item.IsAccessedByName}).ToArray());
 object Snapshot() {
  using var db=factory.CreateDbContext();var entity=db.Model.FindEntityType(typeof(BaseItemEntity))!;var table=StoreObjectIdentifier.Table(entity.GetTableName()!,entity.GetSchema());
  var rows=db.BaseItems.AsNoTracking().OrderBy(row=>row.Id).ToArray();
  var insertionOrder=new List<Guid>();db.Database.OpenConnection();
  using(var command=db.Database.GetDbConnection().CreateCommand()) {
   command.CommandText="SELECT Id FROM BaseItems ORDER BY rowid";
   using(var reader=command.ExecuteReader()) while(reader.Read()) insertionOrder.Add(Guid.Parse(reader.GetString(0)));
  }
  return new {insertionOrder,rows=rows.Select(row=>entity.GetProperties().ToDictionary(property=>property.GetColumnName(table)!,property=>property.PropertyInfo!.GetValue(row))).ToArray(),
   values=db.ItemValues.AsNoTracking().OrderBy(value=>value.ItemValueId).Select(value=>new {value.ItemValueId,type=(int)value.Type,value.Value,value.CleanValue}).ToArray(),
   maps=db.ItemValuesMap.AsNoTracking().OrderBy(map=>map.ItemId).ThenBy(map=>map.ItemValueId).Select(map=>new {map.ItemId,map.ItemValueId}).ToArray(),
   directories=rows.Where(row=>row.Type==typeof(MusicArtist).FullName).Where(row=>row.Path is not null)
    .Select(row=>new {row.Id,path=row.Path!.Replace("%MetadataPath%",metadata,StringComparison.Ordinal)})
    .Where(row=>Directory.Exists(row.path)).Select(row=>new {row.Id,row.path,created=Directory.GetCreationTimeUtc(row.path),modified=Directory.GetLastWriteTimeUtc(row.path)}).ToArray(),
   tree=new[] {metadata,Path.Combine(root,"data")}.Where(Directory.Exists).SelectMany(folder=>Directory.EnumerateFileSystemEntries(folder,"*",SearchOption.AllDirectories))
    .OrderBy(path=>path,StringComparer.Ordinal).Select(path=>new {path=Path.GetRelativePath(root,path).Replace('\\','/'),directory=Directory.Exists(path),
      sha256=File.Exists(path)?Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant():null}).ToArray()};
 }
 var before=Snapshot();if(sample.FailDatabase) using(var db=factory.CreateDbContext()) db.Database.ExecuteSqlRaw("CREATE TRIGGER controlled_failure BEFORE DELETE ON BaseItems BEGIN SELECT RAISE(ABORT, 'Controlled database failure'); END;");
 var logs=new List<object>();var progress=new List<double>();active=true;Exception? failure=null;
 try {ILibraryPostScanTask task=new ArtistsPostScanTask(library,new RecorderLogger<ArtistsValidator>(logs),repository);
  await task.Run(new ProgressSink(value=>progress.Add(value)),tokenSource.Token);
 }catch(Exception error) {failure=error;}
 results.Add(new {kind,sample,root,names,selections,before,after=Snapshot(),calls,lookupDirectories,progress,logs,failure=failure is null?null:new {type=failure.GetType().Name,failure.Message}});
}
var registrationTypes=typeof(GenresPostScanTask).Assembly.GetTypes()
 .Where(type=>!type.IsAbstract&&typeof(ILibraryPostScanTask).IsAssignableFrom(type)).Select(type=>type.Name).ToArray();
var sqliteRuntime=new {name="e_sqlite3.dll",sha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory,"e_sqlite3.dll")))).ToLowerInvariant()};
var assemblies=AppDomain.CurrentDomain.GetAssemblies().Where(assembly=>!assembly.IsDynamic&&!string.IsNullOrEmpty(assembly.Location)).OrderBy(assembly=>assembly.GetName().Name)
 .Select(assembly=>new {name=assembly.GetName().Name,sha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()}).ToArray();
File.WriteAllText(args[2],JsonSerializer.Serialize(new {inputSha256=Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant(),actualPostScanTasks=true,actualValidators=true,
 actualLibraryManager=true,actualRepository=true,actualSqlitePersistence=true,actualUnsafeFastFiles=true,metadataProviderControlled=true,mediaOpened=false,portOpened=false,results,assemblies,registrationTypes,sqliteRuntime},new JsonSerializerOptions {WriteIndented=true})+"\n");
Console.WriteLine(JsonSerializer.Serialize(new {cases=results.Count}));
Guid Id(int index)=>Guid.Parse("ba380000-0000-0000-0000-"+index.ToString("D12"));
void Field(object owner,string name,object value)=>owner.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(owner,value);
public sealed class Sample {
 public string Name {get;set;}="";public string[] Names {get;set;}=[];public string[] Existing {get;set;}=[];
 public string[] FailLookup {get;set;}=[];public string[] FailRefresh {get;set;}=[];
 public bool ReverseBatch {get;set;}
 public bool SeparateSeeds {get;set;}public bool ReverseSeeds {get;set;}
 public bool Physical {get;set;}public bool PhysicalTwin {get;set;}public bool NeverRefreshed {get;set;}public string? NullLookup {get;set;}
 public bool CancelInitial {get;set;}public string? CancelLookup {get;set;}public string? CancelRefresh {get;set;}public bool SourceKinds {get;set;}
 public bool Dead {get;set;}public bool Locked {get;set;}public bool Unmapped {get;set;}public bool DeadNullPath {get;set;}
 public bool FailExternal {get;set;}public bool FailDatabase {get;set;}public bool NullInitialName {get;set;}
 public string? InitialLookup {get;set;}public string? InitialName {get;set;}public bool InitialOwner {get;set;}public bool InitialAlternate {get;set;}
}
public sealed class ProgressSink(Action<double> callback):IProgress<double> {public void Report(double value)=>callback(value);}
public class Stub:DispatchProxy {
 public Func<MethodInfo,object?[]?,object?> Handler=null!;protected override object? Invoke(MethodInfo? method,object?[]? values)=>Handler(method!,values);
 public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T:class {var proxy=Create<T,Stub>();((Stub)(object)proxy).Handler=handler;return proxy;}
 public static object? Default(Type type)=>type==typeof(void)?null:type==typeof(Task)?Task.CompletedTask:type.IsValueType?Activator.CreateInstance(type):null;
 public static object? Forward(object target,MethodInfo method,object?[]? values) {try{return method.Invoke(target,values);}catch(TargetInvocationException error){ExceptionDispatchInfo.Capture(error.InnerException!).Throw();throw;}}
}
public class SqlFactory(string filename):IDbContextFactory<JellyfinDbContext> {
 public JellyfinDbContext CreateDbContext()=>new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
  NullLogger<JellyfinDbContext>.Instance,new SqliteDatabaseProvider(null!,NullLogger<SqliteDatabaseProvider>.Instance),new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}

public sealed class RecorderLogger<T>(List<object> entries):ILogger<T> {
 public bool IsEnabled(LogLevel level)=>true;
 public IDisposable? BeginScope<TState>(TState state) where TState:notnull=>null;
 public void Log<TState>(LogLevel level,EventId eventId,TState state,Exception? error,Func<TState,Exception?,string> formatter)=>
  entries.Add(new {level=level.ToString(),message=formatter(state,error),error=error is null?null:new {type=error.GetType().Name,error.Message}});
}
