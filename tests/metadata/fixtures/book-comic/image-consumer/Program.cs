using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Drawing;
using Jellyfin.Drawing.Skia;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Drawing;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.Books;
using MediaBrowser.Providers.Manager;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
SQLitePCL.Batteries_V2.Init();
var results=new List<object>();var originalRoot=args[1];
foreach(var archiveName in new[]{"Rar.rar","Rar5.solid.rar","Rar.encrypted_filesOnly.rar"})foreach(var saveLocal in new[]{false,true}){
 var name=archiveName+(saveLocal?"-local":"-internal");var root=Path.GetFullPath(Path.Combine(args[0],name));Directory.CreateDirectory(root);var logs=new List<object>();
 var paths=Stub.Make<IServerApplicationPaths>((method,values)=>method.Name switch{"get_ProgramDataPath"=>root,"get_InternalMetadataPath"=>Path.Combine(root,"metadata"),"get_TempDirectory"=>Path.Combine(root,"temp"),"get_ImageCachePath"=>Path.Combine(root,"cache"),"get_DataPath"=>Path.Combine(root,"data"),_=>Stub.Default(method.ReturnType)});
 var configuration=new ServerConfiguration{ImageSavingConvention=ImageSavingConvention.Compatible,CacheSize=64};
 var config=Stub.Make<IServerConfigurationManager>((method,values)=>method.Name switch{"get_Configuration"=>configuration,"get_ApplicationPaths"=>paths,"GetConfiguration"=>new MetadataConfiguration(),_=>Stub.Default(method.ReturnType)});
 var fileSystem=new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance,paths,[]);
 BaseItem.ConfigurationManager=config;BaseItem.FileSystem=fileSystem;BaseItem.Logger=new CaptureLogger<BaseItem>(logs);
 BaseItem.LocalizationManager=new LocalizationManager(config,NullLogger<LocalizationManager>.Instance);
 BaseItem.MediaSourceManager=Stub.Make<IMediaSourceManager>((method,values)=>method.Name=="GetPathProtocol"?MediaBrowser.Model.MediaInfo.MediaProtocol.File:Stub.Default(method.ReturnType));
 var book=new Book{Id=Guid.Parse("ac810000-0000-0000-0000-000000000001"),Name="Book",Path=Path.Combine(root,"book.cbr")};File.Copy(Path.Combine(originalRoot,archiveName),book.Path);
 var library=Stub.Make<ILibraryManager>((method,values)=>method.Name switch{"GetLibraryOptions"=>new LibraryOptions{SaveLocalMetadata=saveLocal},"GetItemById"=>(Guid)values![0]! ==book.Id?book:null,_=>Stub.Default(method.ReturnType)});BaseItem.LibraryManager=library;
 var appHost=Stub.Make<IServerApplicationHost>((method,values)=>method.Name is"ReverseVirtualPath"or"ExpandVirtualPath"?values![0]:Stub.Default(method.ReturnType));
 var factory=new SqlFactory(Path.Combine(root,"native.db"));using(var db=factory.CreateDbContext()){db.Database.EnsureCreated();db.BaseItems.Add(new BaseItemEntity{Id=book.Id,Type=typeof(Book).FullName!,Name="Book",SortName="book",IsFolder=false,Data="{}",Path=book.Path});db.SaveChanges();}
 var persistence=new ItemPersistenceService(factory,appHost,new CaptureLogger<ItemPersistenceService>(logs));
 var manager=(ProviderManager)RuntimeHelpers.GetUninitializedObject(typeof(ProviderManager));
 void Set(object target,string field,object value)=>target.GetType().GetField(field,BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(target,value);
 Set(manager,"_configurationManager",config);Set(manager,"_fileSystem",fileSystem);Set(manager,"_libraryMonitor",Stub.Make<ILibraryMonitor>((method,values)=>Stub.Default(method.ReturnType)));Set(manager,"_logger",new CaptureLogger<ProviderManager>(logs));
 var saves=new List<object>();var providerManager=Stub.Make<IProviderManager>((method,values)=>{if(method.Name!="SaveImage")return Stub.Default(method.ReturnType);saves.Add(new{mime=values![2],type=values[3]!.ToString(),stream=values[1] is Stream,length=values[1] is Stream data&&data.CanSeek?(long?)data.Length:null});return Stub.Forward(manager,method,values);});
 var imageConsumer=new ItemImageProvider(new CaptureLogger<ItemImageProvider>(logs),providerManager,fileSystem);
 var traced=new TraceImage(new ComicImageProvider(new CaptureLogger<ComicImageProvider>(logs)));
 RefreshResult? refreshed=null;string? refreshError=null,updateError=null;
 try{refreshed=await imageConsumer.RefreshImages(book,new LibraryOptions{SaveLocalMetadata=saveLocal},[traced],new ImageRefreshOptions(null!),CancellationToken.None);}catch(Exception error){refreshError=error.ToString();}
 using var processor=new ImageProcessor(new CaptureLogger<ImageProcessor>(logs),paths,fileSystem,new SkiaEncoder(new CaptureLogger<SkiaEncoder>(logs),paths),config);
 var libraryConsumer=(LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));Set(libraryConsumer,"_fileSystem",fileSystem);Set(libraryConsumer,"_imageProcessor",processor);Set(libraryConsumer,"_persistenceService",persistence);Set(libraryConsumer,"_logger",new CaptureLogger<LibraryManager>(logs));
 try{await libraryConsumer.UpdateImagesAsync(book,true);}catch(Exception error){updateError=error.ToString();}
 using var final=factory.CreateDbContext();var entity=final.Model.FindEntityType(typeof(BaseItemImageInfo))!;var table=StoreObjectIdentifier.Table(entity.GetTableName()!,entity.GetSchema());var rows=final.BaseItemImageInfos.AsNoTracking().ToArray().Select(value=>entity.GetProperties().ToDictionary(property=>property.GetColumnName(table)!,property=>property.PropertyInfo!.GetValue(value))).ToArray();
 var files=Directory.EnumerateFiles(root,"*.jpg",SearchOption.AllDirectories).Select(filename=>new{path=filename,bytes=new FileInfo(filename).Length,sha256=Hash(File.ReadAllBytes(filename))}).ToArray();
 results.Add(new{name,saveLocal,root,actualSource=Path.Combine(originalRoot,archiveName),sourceSha256=Hash(File.ReadAllBytes(book.Path)),selected=traced.Response,refreshError,updateError,refresh=refreshed==null?null:new{update=(int)refreshed.UpdateType,refreshed.Failures,refreshed.ErrorMessage},saves,images=book.ImageInfos.Select(image=>new{image.Path,image.Width,image.Height,image.BlurHash,image.DateModified,image.Type}),files,rows,logs});
}
File.WriteAllText(args[2],JsonSerializer.Serialize(new{actualComicImageProvider=true,actualItemImageProvider=true,actualProviderManagerStreamSave=true,actualImageSaver=true,actualLibraryManagerUpdateImages=true,actualImageProcessorAndSkia=true,actualSqlitePersistence=true,seams="IServerApplicationHost path substitution, configuration, ILibraryManager options and unrelated host services are controlled proxies. Actual ItemImageProvider.RefreshImages -> ProviderManager.SaveImage(Stream) -> ImageSaver; actual LibraryManager.UpdateImagesAsync -> ImageProcessor/Skia -> ItemPersistenceService.SaveImagesAsync. Not a hosted HTTP/full metadata service claim.",results,assemblies=AppDomain.CurrentDomain.GetAssemblies().Where(value=>!value.IsDynamic&&!string.IsNullOrEmpty(value.Location)).Select(value=>new{path=value.Location,sha256=Hash(File.ReadAllBytes(value.Location))})},new JsonSerializerOptions{WriteIndented=true})+"\n");
Console.WriteLine(JsonSerializer.Serialize(new{count=results.Count}));
static string Hash(byte[]bytes)=>Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
public class TraceImage(IDynamicImageProvider actual):IDynamicImageProvider{public string Name=>actual.Name;public object? Response;public bool Supports(BaseItem item)=>actual.Supports(item);public IEnumerable<ImageType> GetSupportedImages(BaseItem item)=>actual.GetSupportedImages(item);public async Task<DynamicImageResponse>GetImage(BaseItem item,ImageType type,CancellationToken token){var response=await actual.GetImage(item,type,token);byte[]? bytes=response.Stream is MemoryStream memory?memory.ToArray():null;Response=new{response.HasImage,format=response.Format.ToString(),bytes=bytes?.Length,sha256=bytes==null?null:Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()};return response;}}
public class CaptureLogger<T>(List<object>entries):ILogger<T>{public IDisposable?BeginScope<TState>(TState state)where TState:notnull=>null;public bool IsEnabled(LogLevel level)=>true;public void Log<TState>(LogLevel level,EventId id,TState state,Exception?error,Func<TState,Exception?,string>formatter)=>entries.Add(new{component=typeof(T).Name,level=level.ToString(),error=error?.GetType().Name,message=formatter(state,error)});}
public class Stub:DispatchProxy{public Func<MethodInfo,object?[]?,object?>Handler=null!;protected override object?Invoke(MethodInfo?method,object?[]?values)=>Handler(method!,values);public static T Make<T>(Func<MethodInfo,object?[]?,object?>handler)where T:class{var value=Create<T,Stub>();((Stub)(object)value).Handler=handler;return value;}public static object?Default(Type type)=>type==typeof(void)?null:type==typeof(Task)?Task.CompletedTask:type.IsValueType?Activator.CreateInstance(type):null;public static object?Forward(object target,MethodInfo method,object?[]?values){try{return method.Invoke(target,values);}catch(TargetInvocationException error){ExceptionDispatchInfo.Capture(error.InnerException!).Throw();throw;}}}
public class SqlFactory(string filename):IDbContextFactory<JellyfinDbContext>{public JellyfinDbContext CreateDbContext()=>new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,NullLogger<JellyfinDbContext>.Instance,new SqliteDatabaseProvider(null!,NullLogger<SqliteDatabaseProvider>.Instance),new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));}
