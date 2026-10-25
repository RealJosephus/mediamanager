using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Library.Validators;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var input=File.ReadAllBytes(args[0]);
var samples=JsonSerializer.Deserialize<Sample[]>(input)!;var results=new List<object>();
foreach(var sample in samples) {
 var root=Path.GetFullPath(Path.Combine(args[1],results.Count.ToString()));Directory.CreateDirectory(root);
 var paths=Stub.Make<IServerApplicationPaths>((method,values)=>method.Name switch {
  "get_ProgramDataPath"=>root,"get_InternalMetadataPath"=>Path.Combine(root,"metadata"),"get_DataPath"=>Path.Combine(root,"data"),_=>Stub.Default(method.ReturnType)});
 var config=Stub.Make<IServerConfigurationManager>((method,values)=>method.Name switch {
  "get_Configuration"=>new ServerConfiguration(),"get_ApplicationPaths"=>paths,_=>Stub.Default(method.ReturnType)});
 BaseItem.ConfigurationManager=config;BaseItem.Logger=NullLogger<BaseItem>.Instance;
 BaseItem.FileSystem=new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance,paths,[]);
 var children=new List<BaseItem>();
 foreach(var (definition,index) in sample.Items.Select((value,index)=>(value,index))) {
  BaseItem child=definition.Kind switch {"Folder"=>new Folder(),"UserView"=>new UserView(),"Movie"=>new Movie(),_=>new CollectionFolder()};
  child.Id=Id(definition.SameIdentity?0:index);child.Name=definition.Name!;child.Path=Path.Combine(root,"library-"+index);
  child.ImageInfos=definition.Images.Select(type=>new ItemImageInfo {Type=Enum.Parse<ImageType>(type),
   Path=definition.NullImagePath?null!:definition.EmptyImagePath?"":definition.OutsideImagePath?"Z:\\outside\\poster.jpg":Path.Combine(child.Path,type+".jpg")}).ToArray();
  children.Add(child);
 }
 var userRoot=new UserRootFolder {Id=Id(999),Name="User root",Children=children};
 var calls=new List<object>();var logs=new List<object>();var progress=new List<double>();var tokenSource=new CancellationTokenSource();
 if(sample.CancelInitial)tokenSource.Cancel();
 BaseItem.LibraryManager=Stub.Make<ILibraryManager>((method,values)=>method.Name switch {
  "GetUserRootFolder"=>sample.FailRoot?throw new IOException("Controlled root failure"):userRoot,
  "GetCollectionFolders"=>new List<Folder>(),"GetLibraryOptions"=>new LibraryOptions(),_=>Stub.Default(method.ReturnType)});
 BaseItem.ProviderManager=Stub.Make<IProviderManager>((method,values)=> {
  if(method.Name!="RefreshSingleItem")return Stub.Default(method.ReturnType);
  var item=(BaseItem)values![0]!;var options=(MetadataRefreshOptions)values[1]!;var token=(CancellationToken)values[2]!;
  calls.Add(new {action="refresh",item.Id,item.Name,path=item.Path,metadataMode=(int)options.MetadataRefreshMode,imageMode=(int)options.ImageRefreshMode,
   options.IsAutomated,options.ForceSave,options.ReplaceAllMetadata,options.ReplaceAllImages,options.RemoveOldMetadata,
   images=item.ImageInfos.Select(image=>new {type=image.Type.ToString(),image.Path}).ToArray()});
  if(sample.CancelRefresh is not null && sample.CancelRefresh==item.Name)tokenSource.Cancel();token.ThrowIfCancellationRequested();
  if(sample.FailRefresh is not null && sample.FailRefresh==item.Name)throw new IOException("Controlled refresh failure");
  if(sample.AddChild)children.Add(new CollectionFolder {Id=Id(888),Name="New after snapshot"});
  if(sample.RemoveSibling&&children.Count>1)children.RemoveAt(1);
  if(sample.AddSiblingImage&&children.Count>1)children[1].ImageInfos=[new ItemImageInfo {Type=ImageType.Primary,Path="created after snapshot"}];
  if(sample.RenameSibling&&children.Count>1)children[1].Name="Renamed after snapshot";
  return Task.FromResult(ItemUpdateType.None);
 });
 object Snapshot()=>children.Select(item=>new {item.Id,item.Name,type=item.GetType().Name,path=item.Path,
  images=item.ImageInfos.Select(image=>new {type=image.Type.ToString(),image.Path}).ToArray()}).ToArray();
 var before=Snapshot();Exception? failure=null;
 try {await new CollectionPosterVerifyPostScanTask(BaseItem.LibraryManager,new RecorderLogger<CollectionPosterVerifyPostScanTask>(logs))
  .Run(new ProgressSink(value=> {progress.Add(value);if(sample.FailProgress)throw new IOException("Controlled progress failure");}),tokenSource.Token);}
 catch(Exception error){failure=error;}
 results.Add(new {sample,root,before,after=Snapshot(),calls,logs,progress,failure=failure is null?null:new {type=failure.GetType().Name,failure.Message}});
}
File.WriteAllText(args[2],JsonSerializer.Serialize(new {inputSha256=Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant(),
 actualPostScanTask=true,actualBaseItemRefresh=true,rootChildrenControlled=true,metadataProviderControlled=true,
 mediaOpened=false,portOpened=false,results},new JsonSerializerOptions {WriteIndented=true})+"\n");
Console.WriteLine(JsonSerializer.Serialize(new {cases=results.Count}));
Guid Id(int index)=>Guid.Parse("ba400000-0000-0000-0000-"+index.ToString("D12"));
public sealed class Sample {
 public string Name {get;set;}="";public Definition[] Items {get;set;}=[];
 public bool CancelInitial {get;set;}public string? CancelRefresh {get;set;}public string? FailRefresh {get;set;}
 public bool FailRoot {get;set;}public bool AddChild {get;set;}public bool RemoveSibling {get;set;}
 public bool AddSiblingImage {get;set;}public bool RenameSibling {get;set;}public bool FailProgress {get;set;}
}
public sealed class Definition {
 public string? Name {get;set;}public string Kind {get;set;}="CollectionFolder";public string[] Images {get;set;}=[];
 public bool EmptyImagePath {get;set;}public bool NullImagePath {get;set;}public bool OutsideImagePath {get;set;}public bool SameIdentity {get;set;}
}
public sealed class ProgressSink(Action<double> callback):IProgress<double> {public void Report(double value)=>callback(value);}
public class Stub:DispatchProxy {
 public Func<MethodInfo,object?[]?,object?> Handler=null!;protected override object? Invoke(MethodInfo? method,object?[]? values)=>Handler(method!,values);
 public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T:class {var proxy=Create<T,Stub>();((Stub)(object)proxy).Handler=handler;return proxy;}
 public static object? Default(Type type)=>type==typeof(void)?null:type==typeof(Task)?Task.CompletedTask:type.IsValueType?Activator.CreateInstance(type):null;
}
public sealed class RecorderLogger<T>(List<object> entries):ILogger<T> {
 public bool IsEnabled(LogLevel level)=>true;public IDisposable? BeginScope<TState>(TState state) where TState:notnull=>null;
 public void Log<TState>(LogLevel level,EventId eventId,TState state,Exception? error,Func<TState,Exception?,string> formatter)=>entries.Add(new {level=level.ToString(),message=formatter(state,error)});
}
