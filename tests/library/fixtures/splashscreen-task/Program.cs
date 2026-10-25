using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

var input=File.ReadAllBytes(args[0]);var samples=JsonSerializer.Deserialize<Sample[]>(input)!;
var results=new List<object>();
foreach(var sample in samples) {
 var calls=new List<object>();var logs=new List<object>();var progress=new List<double>();
 var tokenSource=new CancellationTokenSource();if(sample.CancelInitial)tokenSource.Cancel();
 var repository=Stub.Make<IItemRepository>((method,values)=> {
  if(method.Name!="GetItemList")return Stub.Default(method.ReturnType);
  var query=(InternalItemsQuery)values![0]!;var type=query.ImageTypes[0];
  calls.Add(new {action="query",imageType=type.ToString(),query.CollapseBoxSetItems,query.Recursive,query.Limit,
   query.MaxParentalRating,query.DtoOptions.EnableImages,query.DtoOptions.EnableUserData,
   fields=query.DtoOptions.Fields.Select(field=>field.ToString()).ToArray(),
   kinds=query.IncludeItemTypes.Select(kind=>kind.ToString()).ToArray(),
   order=query.OrderBy.Select(order=>new {name=order.Item1.ToString(),direction=order.Item2.ToString()}).ToArray()});
  if(sample.FailQuery==type.ToString())throw new IOException("Controlled "+type+" query failure");
  var definitions=type==ImageType.Primary?sample.Posters:type==ImageType.Thumb?sample.Thumbs:sample.Backdrops;
  return definitions.Select((paths,index)=> {
   var item=new Movie {Id=Guid.Parse("ba430000-0000-0000-0000-"+(index+1).ToString("D12")),Name="Item "+index};
   item.ImageInfos=paths.Select(path=>new ItemImageInfo {Type=type,Path=path!}).ToArray();return (BaseItem)item;
  }).ToArray();
 });
 var encoder=Stub.Make<IImageEncoder>((method,values)=> {
  if(method.Name!="CreateSplashscreen")return Stub.Default(method.ReturnType);
  calls.Add(new {action="splashscreen",posters=values![0],backdrops=values[1]});
  if(sample.FailEncoder)throw new IOException("Controlled splashscreen failure");return null;
 });
 Exception? failure=null;
 try {await new SplashscreenPostScanTask(repository,encoder,new RecorderLogger<SplashscreenPostScanTask>(logs))
  .Run(new ProgressSink(value=> {progress.Add(value);if(sample.FailProgress)throw new IOException("Controlled progress failure");}),tokenSource.Token);}
 catch(Exception error){failure=error;}
 results.Add(new {sample,calls,logs,progress,failure=failure is null?null:new {type=failure.GetType().Name,failure.Message}});
}
var assemblies=AppDomain.CurrentDomain.GetAssemblies().Where(assembly=>!assembly.IsDynamic&&!string.IsNullOrEmpty(assembly.Location))
 .OrderBy(assembly=>assembly.GetName().Name).Select(assembly=>new {name=assembly.GetName().Name,
  sha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()}).ToArray();
File.WriteAllText(args[1],JsonSerializer.Serialize(new {actualPostScanTask=true,repositoryControlled=true,imageEncoderControlled=true,
 mediaOpened=false,portOpened=false,inputSha256=Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant(),results,assemblies},
 new JsonSerializerOptions {WriteIndented=true})+"\n");
Console.WriteLine(JsonSerializer.Serialize(new {cases=results.Count}));
public sealed class Sample {
 public string Name {get;set;}="";public string?[][] Posters {get;set;}=[];public string?[][] Thumbs {get;set;}=[];public string?[][] Backdrops {get;set;}=[];
 public string? FailQuery {get;set;}public bool FailEncoder {get;set;}public bool FailProgress {get;set;}public bool CancelInitial {get;set;}
}
public class Stub:DispatchProxy {
 public Func<MethodInfo,object?[]?,object?> Handler=null!;
 protected override object? Invoke(MethodInfo? method,object?[]? values)=>Handler(method!,values);
 public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T:class {var proxy=Create<T,Stub>();((Stub)(object)proxy).Handler=handler;return proxy;}
 public static object? Default(Type type)=>type==typeof(void)?null:type==typeof(Task)?Task.CompletedTask:type.IsValueType?Activator.CreateInstance(type):null;
}
public sealed class ProgressSink(Action<double> callback):IProgress<double> {public void Report(double value)=>callback(value);}
public sealed class RecorderLogger<T>(List<object> entries):ILogger<T> {
 public bool IsEnabled(LogLevel level)=>true;public IDisposable? BeginScope<TState>(TState state) where TState:notnull=>null;
 public void Log<TState>(LogLevel level,EventId eventId,TState state,Exception? error,Func<TState,Exception?,string> formatter)=>entries.Add(new {level=level.ToString(),message=formatter(state,error)});
}
