using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
var input=File.ReadAllBytes(args[1]);var samples=JsonSerializer.Deserialize<Sample[]>(input)!;var results=new List<object>();
foreach(var sample in samples) {
 var root=Path.Combine(args[0],"cases",sample.Name);Directory.CreateDirectory(root);
 var metadata=Path.Combine(root,"metadata");
 var configuration=new ServerConfiguration {CacheSize=64,EnableCaseSensitiveItemIds=false,EnableNormalizedItemByNameIds=true};
 var paths=Stub.Make<IServerApplicationPaths>((method,values)=>method.Name switch {
  "get_ProgramDataPath"=>root,"get_InternalMetadataPath"=>metadata,"get_DataPath"=>Path.Combine(root,"data"),_=>Stub.Default(method.ReturnType)});
 var config=Stub.Make<IServerConfigurationManager>((method,values)=>method.Name switch {
  "get_Configuration"=>configuration,"get_ApplicationPaths"=>paths,"GetConfiguration"=>new MetadataConfiguration(),_=>Stub.Default(method.ReturnType)});
 BaseItem.ConfigurationManager=config;BaseItem.Logger=NullLogger<BaseItem>.Instance;
 BaseItem.LocalizationManager=new LocalizationManager(config,NullLogger<LocalizationManager>.Instance);
 BaseItem.FileSystem=new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance,paths,[]);
 var appHost=Stub.Make<IServerApplicationHost>((method,values)=>method.Name is "ReverseVirtualPath" or "ExpandVirtualPath"?values![0]:Stub.Default(method.ReturnType));
 var factory=new SqlFactory(Path.Combine(root,"native.db"));using(var initial=factory.CreateDbContext())initial.Database.EnsureCreated();
 var repository=new BaseItemRepository(factory,appHost,new ItemTypeLookup(),config,NullLogger<BaseItemRepository>.Instance);BaseItem.ItemRepository=repository;
 Guid Id(int number)=>Guid.Parse("ba460000-0000-0000-0000-"+number.ToString("D12"));
 using(var context=factory.CreateDbContext()) {
  foreach(var definition in sample.Items) {
   var type=definition.Kind=="Series"?typeof(Series):definition.Kind=="Audio"?typeof(Audio):typeof(Movie);
   context.BaseItems.Add(new BaseItemEntity {Id=Id(definition.Number),Type=type.FullName!,Name="Item "+definition.Number,SortName=definition.Number.ToString("D6"),
    Data="{}",Path="Z:\\Splashscreen\\"+definition.Number,IsFolder=definition.Kind=="Series",InheritedParentalRatingValue=definition.Rating,
    InheritedParentalRatingSubValue=definition.SubRating,PresentationUniqueKey=definition.PresentationKey,
    OwnerId=definition.Owner.HasValue?Id(definition.Owner.Value):null,PrimaryVersionId=definition.Primary.HasValue?Id(definition.Primary.Value):null});
  }
  context.SaveChanges();
  foreach(var definition in sample.Items)foreach(var (image,index) in definition.Images.Select((image,index)=>(image,index))) {
   context.BaseItemImageInfos.Add(new BaseItemImageInfo {Id=Guid.Parse("ba461000-0000-0000-0000-"+(definition.Number*100+(sample.ReverseImageIds?99-index:index)).ToString("D12")),
    ItemId=Id(definition.Number),Item=null!,ImageType=(ImageInfoImageType)image.Type,Path=image.Path,Width=240,Height=360,DateModified=null});
   context.SaveChanges();
  }
  foreach(var (link,position) in sample.Links.Select((link,position)=>(link,position)))context.LinkedChildren.Add(new LinkedChildEntity {ParentId=Id(link.Parent),ChildId=Id(link.Child),SortOrder=position,ChildType=(Jellyfin.Database.Implementations.Entities.LinkedChildType)link.Type});
  context.SaveChanges();
 }
 var calls=new List<object>();var logs=new List<object>();var progress=new List<double>();
 var proxy=Stub.Make<IItemRepository>((method,values)=> {
  if(method.Name!="GetItemList")return Stub.Forward(repository,method,values);
  var query=(InternalItemsQuery)values![0]!;var items=repository.GetItemList(query);
  var complete=repository.GetItemList(new InternalItemsQuery {CollapseBoxSetItems=false,Recursive=true,DtoOptions=new DtoOptions(false),
   ImageTypes=query.ImageTypes,MaxParentalRating=query.MaxParentalRating,IncludeItemTypes=query.IncludeItemTypes,
   OrderBy=[(ItemSortBy.SortName,SortOrder.Ascending)]});
  var type=query.ImageTypes[0];
  calls.Add(new {action="query",imageType=type.ToString(),query.Limit,ids=items.Select(item=>item.Id).ToArray(),
   paths=items.Select(item=>item.GetImages(type).FirstOrDefault()?.Path).Where(path=>!string.IsNullOrEmpty(path)).ToArray(),
   eligible=complete.Select(item=>new {item.Id,images=item.GetImages(type).Select(image=>image.Path).ToArray()}).ToArray()});
  return items;
 });
 var encoder=Stub.Make<IImageEncoder>((method,values)=> {if(method.Name=="CreateSplashscreen")calls.Add(new {action="splashscreen",posters=values![0],backdrops=values[1]});return Stub.Default(method.ReturnType);});
 Exception? failure=null;
 try {await new SplashscreenPostScanTask(proxy,encoder,new RecorderLogger<SplashscreenPostScanTask>(logs)).Run(new ProgressSink(value=>progress.Add(value)),CancellationToken.None);}
 catch(Exception error){failure=error;}
 using var final=factory.CreateDbContext();
 object[] Snapshot<T>(IEnumerable<T> rows)where T:class {
  var model=final.Model.FindEntityType(typeof(T))!;var table=StoreObjectIdentifier.Table(model.GetTableName()!,model.GetSchema());
  return rows.Select(row=>(object)model.GetProperties().ToDictionary(property=>property.GetColumnName(table)!,property=>property.PropertyInfo!.GetValue(row))).ToArray();
 }
 results.Add(new {sample,rows=Snapshot(final.BaseItems.AsNoTracking().OrderBy(item=>item.Id).ToArray()),
  imageRows=Snapshot(final.BaseItemImageInfos.AsNoTracking().ToArray()),links=Snapshot(final.LinkedChildren.AsNoTracking().ToArray()),
  calls,logs,progress,failure=failure is null?null:new {type=failure.GetType().Name,failure.Message}});
}
var assemblies=AppDomain.CurrentDomain.GetAssemblies().Where(value=>!value.IsDynamic&&!string.IsNullOrEmpty(value.Location)).OrderBy(value=>value.GetName().Name)
 .Select(value=>new {name=value.GetName().Name,sha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(value.Location))).ToLowerInvariant()}).ToArray();
File.WriteAllText(args[2],JsonSerializer.Serialize(new {actualPostScanTask=true,actualRepository=true,actualSqlite=true,imageEncoderControlled=true,
 mediaOpened=false,portOpened=false,inputSha256=Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant(),results,assemblies},new JsonSerializerOptions{WriteIndented=true})+"\n");
Console.WriteLine(JsonSerializer.Serialize(new {cases=results.Count}));
public sealed class Sample {public string Name{get;set;}="";public ItemSpec[] Items{get;set;}=[];public LinkSpec[] Links{get;set;}=[];public bool ReverseImageIds{get;set;}=true;}
public sealed class ItemSpec {
 public int Number{get;set;}public string Kind{get;set;}="Movie";public int? Rating{get;set;}public int? SubRating{get;set;}
 public int? Owner{get;set;}public int? Primary{get;set;}public string? PresentationKey{get;set;}public ImageSpec[] Images{get;set;}=[];
}
public sealed class ImageSpec {public int Type{get;set;}public string Path{get;set;}="";}
public sealed class LinkSpec {public int Parent{get;set;}public int Child{get;set;}public int Type{get;set;}}
public class Stub:DispatchProxy {
 public Func<MethodInfo,object?[]?,object?> Handler=null!;protected override object? Invoke(MethodInfo? method,object?[]? values)=>Handler(method!,values);
 public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler)where T:class {var value=Create<T,Stub>();((Stub)(object)value).Handler=handler;return value;}
 public static object? Default(Type type)=>type==typeof(void)?null:type==typeof(Task)?Task.CompletedTask:type.IsValueType?Activator.CreateInstance(type):null;
 public static object? Forward(object target,MethodInfo method,object?[]? values) {try{return method.Invoke(target,values);}catch(TargetInvocationException error){ExceptionDispatchInfo.Capture(error.InnerException!).Throw();throw;}}
}
public class SqlFactory(string filename):IDbContextFactory<JellyfinDbContext> {
 public JellyfinDbContext CreateDbContext()=>new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
  NullLogger<JellyfinDbContext>.Instance,new SqliteDatabaseProvider(null!,NullLogger<SqliteDatabaseProvider>.Instance),new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
public sealed class ProgressSink(Action<double> callback):IProgress<double> {public void Report(double value)=>callback(value);}
public sealed class RecorderLogger<T>(List<object> entries):ILogger<T> {
 public bool IsEnabled(LogLevel level)=>true;public IDisposable? BeginScope<TState>(TState state)where TState:notnull=>null;
 public void Log<TState>(LogLevel level,EventId eventId,TState state,Exception? error,Func<TState,Exception?,string> formatter)=>entries.Add(new {level=level.ToString(),message=formatter(state,error)});
}
