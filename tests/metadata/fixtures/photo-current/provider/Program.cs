using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Security.Cryptography;
using Emby.Photos;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Drawing;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.MediaInfo;
using Microsoft.Extensions.Logging;
var input=JsonDocument.Parse(File.ReadAllText(args[0]));var assets=Path.GetFullPath(args[1]);
var modified=new DateTime(2026,10,1,1,2,3,DateTimeKind.Utc);
BaseItem.FileSystem=Stub.Make<IFileSystem>((method,values)=>method.Name switch{
 "GetFileInfo"=>new FileSystemMetadata{FullName=(string)values![0]!,Exists=true,LastWriteTimeUtc=modified},
 "GetLastWriteTimeUtc"=>modified,_=>Stub.Default(method.ReturnType)});
BaseItem.MediaSourceManager=Stub.Make<IMediaSourceManager>((method,values)=>method.Name=="GetPathProtocol"?MediaProtocol.File:Stub.Default(method.ReturnType));
var results=new List<object>();
foreach(var sample in input.RootElement.GetProperty("cases").EnumerateArray()){
 string name=sample.GetProperty("name").GetString()!,file=Path.Combine(assets,sample.GetProperty("file").GetString()!);
 var item=new Photo{Name="Stored title",Path=file,Overview="Stored overview",CameraMake="Stored maker",CameraModel="Stored model",Software="Stored software",
  DateCreated=new DateTime(2000,1,2,3,4,5,DateTimeKind.Utc),PremiereDate=new DateTime(2000,1,2),ProductionYear=2000,
  Width=sample.TryGetProperty("width",out var width)?width.GetInt32():0,Height=sample.TryGetProperty("height",out var height)?height.GetInt32():0,
  CommunityRating=9,Genres=["Stored genre"],Tags=["Stored tag"],Orientation=ImageOrientation.BottomRight,ExposureTime=9,FocalLength=99,Aperture=88,ShutterSpeed=77,Latitude=66,Longitude=55,Altitude=44,IsoSpeedRating=123};
 if(sample.TryGetProperty("nameLocked",out var locked)&&locked.GetBoolean())item.LockedFields=[MetadataField.Name];
 if(sample.TryGetProperty("existingPrimary",out var existing)&&existing.GetBoolean())item.SetImage(new ItemImageInfo{Type=ImageType.Primary,Path="old-primary.jpg",Width=40,Height=30,BlurHash="old-blurhash",DateModified=new DateTime(2000,1,1)},0);
 var logger=new CaptureLogger<PhotoProvider>();var fallbackCalls=0;
 var processor=Stub.Make<IImageProcessor>((method,values)=>{
  if(method.Name!="GetImageDimensions")return Stub.Default(method.ReturnType);fallbackCalls++;
  var mode=sample.TryGetProperty("fallback",out var fallback)?fallback.GetString():"size";
  if(mode=="ArgumentException")throw new ArgumentException("Controlled unsupported image.");if(mode=="IOException")throw new IOException("Controlled fallback read failure.");
  return mode=="zero"?new ImageDimensions(0,0):new ImageDimensions(31,17);
 });
 int? update=null;string? exception=null;
 try{update=(int)await new PhotoProvider(logger,processor).FetchAsync(item,new MetadataRefreshOptions((IDirectoryService)null!),
  sample.TryGetProperty("cancelled",out var cancelled)&&cancelled.GetBoolean()?new CancellationToken(true):CancellationToken.None);}
 catch(Exception error){exception=error.GetType().Name;}
 results.Add(new{name,sourceSha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant(),update,exception,errorOccurred=exception is not null,fallbackCalls,errorCount=logger.Errors.Count,isoOverflow=logger.IsoOverflow,errors=logger.Errors,item=new{item.Name,item.Overview,item.CameraMake,item.CameraModel,item.Software,item.Width,item.Height,
  item.CommunityRating,communityRatingBits=item.CommunityRating.HasValue?BitConverter.SingleToInt32Bits(item.CommunityRating.Value):(int?)null,
  communityRatingDouble=(double?)item.CommunityRating,dateCreated=item.DateCreated.ToString("o"),premiereDate=item.PremiereDate?.ToString("o"),dateCreatedTicks=item.DateCreated.Ticks.ToString(),premiereDateTicks=item.PremiereDate?.Ticks.ToString(),
  dateCreatedKind=item.DateCreated.Kind.ToString(),premiereDateKind=item.PremiereDate?.Kind.ToString(),item.ProductionYear,item.Genres,item.Tags,
  orientation=item.Orientation?.ToString(),item.ExposureTime,item.FocalLength,item.Aperture,item.ShutterSpeed,item.Latitude,item.Longitude,item.Altitude,item.IsoSpeedRating,
  images=item.ImageInfos.Select(image=>new{path=Path.GetFileName(image.Path),type=image.Type.ToString(),dateModified=image.DateModified.ToString("o"),image.Width,image.Height,image.BlurHash})}});
}
var changes=new List<object>();
foreach(var deltaTicks in new[]{-10000001L,-10000000L,-1L,0L,1L,10000000L,10000001L})foreach(var exists in new[]{false,true}){
 var photo=new Photo{Path=Path.Combine(assets,"plain.jpg"),DateModified=modified.AddTicks(deltaTicks)};
 var directory=Stub.Make<IDirectoryService>((method,_)=>method.Name=="GetFile"?(exists?new FileSystemMetadata{FullName=photo.Path,Exists=true,LastWriteTimeUtc=modified}:null):Stub.Default(method.ReturnType));
 var changed=new PhotoProvider(new CaptureLogger<PhotoProvider>(),Stub.Make<IImageProcessor>((method,_)=>Stub.Default(method.ReturnType))).HasChanged(photo,directory);
 changes.Add(new{deltaTicks,exists,changed});
}
File.WriteAllText(args[2],JsonSerializer.Serialize(new{results,changes,inputSha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
 assemblies=new[]{typeof(Photo).Assembly,typeof(PhotoProvider).Assembly,typeof(TagLib.File).Assembly,typeof(ImageOrientation).Assembly}.Select(assembly=>new{name=assembly.GetName().Name,sha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()}),
 localTimeZone=TimeZoneInfo.Local.Id,localUtcOffset=TimeZoneInfo.Local.BaseUtcOffset.ToString(),
 scope="Actual PhotoProvider.FetchAsync and TagLib2.3 file reads over bound synthetic static bytes; controlled ImageProcessor dimension fallback and filesystem timestamp only. Actual HasChanged with controlled directory lookup. No SQL, complete metadata host, or HTTP consumer in this oracle."},
 new JsonSerializerOptions{WriteIndented=true,NumberHandling=JsonNumberHandling.AllowNamedFloatingPointLiterals})+"\n");
public class Stub:DispatchProxy{public Func<MethodInfo,object?[]?,object?> Handler=null!;protected override object? Invoke(MethodInfo? method,object?[]? values)=>Handler(method!,values);
 public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler)where T:class{var value=Create<T,Stub>();((Stub)(object)value).Handler=handler;return value;}
 public static object? Default(Type type)=>type==typeof(void)?null:type.IsValueType?Activator.CreateInstance(type):null;}
public class CaptureLogger<T>:ILogger<T>{public List<string> Errors=new();public bool IsoOverflow;public IDisposable? BeginScope<TState>(TState state)where TState:notnull=>null;public bool IsEnabled(LogLevel level)=>true;
 public void Log<TState>(LogLevel level,EventId id,TState state,Exception? exception,Func<TState,Exception?,string> formatter){if(level>=LogLevel.Error){Errors.Add(exception?.GetType().Name??"no-exception");IsoOverflow|=exception is OverflowException;}}}
