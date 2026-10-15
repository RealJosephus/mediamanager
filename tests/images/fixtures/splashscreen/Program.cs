using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Drawing.Skia;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using SkiaSharp;

var root = Path.GetFullPath(args[0]);
var input = File.ReadAllBytes(args[1]);
var samples = JsonSerializer.Deserialize<Sample[]>(input)!;
var assets = Path.Combine(root, "assets"); Directory.CreateDirectory(assets);
void Asset(string name, int width, int height, bool alpha = false) {
 using var bitmap = new SKBitmap(width, height);
 for (int y=0; y<height; y++) for(int x=0; x<width; x++) {
  bitmap.SetPixel(x,y,new SKColor((byte)(x*17+y*3),(byte)(x*5+y*11),(byte)(x*7+y*19), alpha?(byte)(30+(x+y)%226):(byte)255));
 }
 using var stream=File.Create(Path.Combine(assets,name)); bitmap.Encode(stream,SKEncodedImageFormat.Png,100);
}
Asset("portrait.png",240,360);Asset("landscape.png",480,360);
Asset("small.png",16,24);Asset("large.png",960,1440);Asset("alpha.png",240,360,true);
Asset("tall.png",1,1440);
File.WriteAllBytes(Path.Combine(assets,"static.gif"),Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"));
File.WriteAllText(Path.Combine(assets,"vector.svg"),"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"2\" height=\"3\"><rect width=\"2\" height=\"3\" fill=\"red\"/></svg>");
File.WriteAllText(Path.Combine(assets,"broken.png"),"Not an image");File.WriteAllBytes(Path.Combine(assets,"empty.png"),[]);
Directory.CreateDirectory(Path.Combine(assets,"directory.png"));
File.Copy(Path.Combine(assets,"portrait.png"),Path.Combine(assets,"content.dat"));
File.Copy(Path.Combine(assets,"alpha.png"),Path.Combine(assets,"alpha.dat"));
using(var source=SKBitmap.Decode(Path.Combine(assets,"portrait.png"))) {
 using var stream=File.Create(Path.Combine(assets,"portrait.jpg"));source.Encode(stream,SKEncodedImageFormat.Jpeg,90);
 using var webp=File.Create(Path.Combine(assets,"portrait.webp"));source.Encode(webp,SKEncodedImageFormat.Webp,90);
}
var results=new List<object>();
foreach(var sample in samples) {
 var directory=Path.Combine(root,"cases",sample.Name);var data=Path.Combine(directory,"data");
 Directory.CreateDirectory(directory);if(!sample.MissingDataDirectory)Directory.CreateDirectory(data);
 var filename=Path.Combine(data,"splashscreen.png");
 if(sample.Existing)File.Copy(Path.Combine(assets,"portrait.png"),filename);
 if(sample.DirectoryOutput)Directory.CreateDirectory(filename);
 if(sample.ReadOnlyOutput)File.SetAttributes(filename,FileAttributes.ReadOnly);
 var logs=new List<object>();
 var appPaths=Stub.Make<IApplicationPaths>((method,values)=>method.Name switch {
  "get_DataPath"=>data,"get_CachePath"=>Path.Combine(directory,"cache"),"get_TempDirectory"=>Path.Combine(directory,"temp"),
  _=>Stub.Default(method.ReturnType)});
 var encoder=new SkiaEncoder(new RecorderLogger<SkiaEncoder>(logs),appPaths);
 var before=Snapshot(filename);Exception? failure=null;
 string Resolve(string name)=>Path.Combine(assets,name);
 try {encoder.CreateSplashscreen(sample.Posters.Select(Resolve).ToArray(),sample.Backdrops.Select(Resolve).ToArray());}
 catch(Exception error){failure=error;}
 object? wall=null;
 if(failure is null&&sample.Posters.Length>0&&sample.Backdrops.Length>0&&!sample.Repeat) {
  var builder=new SplashscreenBuilder(encoder,NullLogger<SplashscreenBuilder>.Instance);
  using var collage=(SKBitmap)typeof(SplashscreenBuilder).GetMethod("GenerateCollage",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(builder,[sample.Posters.Select(Resolve).ToArray(),sample.Backdrops.Select(Resolve).ToArray()])!;
  var wallFile=Path.Combine(directory,"wall.png");using(var output=File.Create(wallFile))collage.Encode(output,SKEncodedImageFormat.Png,100);
  wall=new {collage.Width,collage.Height,pixelHash=Pixels(collage),file=Snapshot(wallFile)};
 }
 var firstFile=filename;
 if(sample.Repeat){firstFile=Path.Combine(directory,"first-splashscreen.png");File.Copy(filename,firstFile);}
 var after=Snapshot(firstFile);object? repeated=null;
 if(sample.Repeat){encoder.CreateSplashscreen(sample.Posters.Select(Resolve).ToArray(),sample.Backdrops.Select(Resolve).ToArray());repeated=Snapshot(filename);}
 results.Add(new {sample,before,after,wall,repeated,logs,failure=Describe(failure)});
}

var transformDirectory=Path.Combine(root,"transforms");Directory.CreateDirectory(transformDirectory);
var transforms=new List<object>();
foreach(var name in new[]{"gradient","alpha","solid","coordinates"}) {
 using var wall=new SKBitmap(5760,2160);
 for(int y=0;y<wall.Height;y++) for(int x=0;x<wall.Width;x++) {
  var index=y*wall.Width+x;
  var color=name=="coordinates"?new SKColor((byte)index,(byte)(index>>8),(byte)(index>>16)):name=="solid"?new SKColor(43,119,211):new SKColor((byte)(x*17+y*3),(byte)(x*5+y*11),(byte)(x*7+y*19),name=="alpha"?(byte)(30+(x+y)%226):(byte)255);
  wall.SetPixel(x,y,color);
 }
 var wallPath=Path.Combine(transformDirectory,name+"-wall.png");
 using(var output=File.Create(wallPath))wall.Encode(output,SKEncodedImageFormat.Png,100);
 var logs=new List<object>();
 var paths=Stub.Make<IApplicationPaths>((method,values)=>Stub.Default(method.ReturnType));
 var builder=new SplashscreenBuilder(new SkiaEncoder(new RecorderLogger<SkiaEncoder>(logs),paths),new RecorderLogger<SplashscreenBuilder>(logs));
 using var decodedWall=SKBitmap.Decode(wallPath);
 using var transformed=(SKBitmap)typeof(SplashscreenBuilder).GetMethod("Transform3D",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(builder,[decodedWall])!;
 var target=Path.Combine(transformDirectory,name+".png");using(var output=File.Create(target))transformed.Encode(output,SKEncodedImageFormat.Png,90);
 transforms.Add(new {name,input=Snapshot(wallPath),output=Snapshot(target),logs});
}
var helper=new List<object>();
foreach(var definition in new[]{new HelperSample(["missing.png","broken.png","portrait.png"],0),
 new HelperSample(["missing.png","broken.png","portrait.png"],3),new HelperSample(["missing.png","broken.png"],1),
 new HelperSample([],4),new HelperSample(["directory.png","portrait.png"],0),new HelperSample(["content.dat"],0),
 new HelperSample(["alpha.png"],0),new HelperSample(["alpha.dat"],0),new HelperSample(["portrait.jpg"],0),new HelperSample(["portrait.webp"],0)}) {
 var logs=new List<object>();var paths=Stub.Make<IApplicationPaths>((method,values)=>Stub.Default(method.ReturnType));
 var encoder=new SkiaEncoder(new RecorderLogger<SkiaEncoder>(logs),paths);Exception? failure=null;int index=-1;object? bitmap=null;
 try {using var result=SkiaHelper.GetNextValidImage(encoder,definition.Paths.Select(name=>Path.Combine(assets,name)).ToArray(),definition.Start,out index);
  if(result is not null)bitmap=new {result.Width,result.Height,pixelHash=Pixels(result)};}
 catch(Exception error){failure=error;}
 helper.Add(new {definition,index,bitmap,logs,failure=Describe(failure)});
}
var assemblies=AppDomain.CurrentDomain.GetAssemblies().Where(value=>!value.IsDynamic&&!string.IsNullOrEmpty(value.Location)).OrderBy(value=>value.GetName().Name)
 .Select(value=>new {name=value.GetName().Name,sha256=Hash(File.ReadAllBytes(value.Location))}).ToArray();
var assetFiles=Directory.GetFiles(assets).Select(filename=>new {name=Path.GetFileName(filename),snapshot=Snapshot(filename)}).ToArray();
File.WriteAllText(args[2],JsonSerializer.Serialize(new {actualSkiaEncoder=true,actualSplashscreenBuilder=true,actualSkiaHelper=true,
 actualTransform=true,mediaOpened=false,portOpened=false,inputSha256=Hash(input),assets=assetFiles,results,transforms,helper,assemblies},new JsonSerializerOptions{WriteIndented=true})+"\n");
Console.WriteLine(JsonSerializer.Serialize(new {cases=results.Count,transforms=transforms.Count,helpers=helper.Count}));

object? Describe(Exception? error)=>error is null?null:new {type=error.GetType().Name,error.Message};
string Hash(byte[] bytes)=>Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
object? Snapshot(string filename) {
 if(!File.Exists(filename))return null;var bytes=File.ReadAllBytes(filename);SKBitmap? bitmap=null;Exception? decodeFailure=null;
 try {bitmap=SKBitmap.Decode(bytes);} catch(Exception error){decodeFailure=error;}
 using(bitmap) return new {path=filename,bytes=bytes.Length,sha256=Hash(bytes),Width=bitmap?.Width,Height=bitmap?.Height,
  pixelHash=bitmap is null?null:Pixels(bitmap),decodeFailure=Describe(decodeFailure)};
}
string Pixels(SKBitmap bitmap) {
 var pixels=new byte[bitmap.ByteCount];Marshal.Copy(bitmap.GetPixels(),pixels,0,pixels.Length);
 if(bitmap.ColorType==SKColorType.Bgra8888)for(int i=0;i<pixels.Length;i+=4)(pixels[i],pixels[i+2])=(pixels[i+2],pixels[i]);
 if(bitmap.ColorType!=SKColorType.Rgba8888&&bitmap.ColorType!=SKColorType.Bgra8888)throw new Exception("Unexpected pixel format "+bitmap.ColorType);
 return Hash(pixels);
}
public sealed class Sample {
 public string Name{get;set;}="";public string[] Posters{get;set;}=[];public string[] Backdrops{get;set;}=[];
 public bool Existing{get;set;}public bool MissingDataDirectory{get;set;}public bool Repeat{get;set;}
 public bool DirectoryOutput{get;set;}public bool ReadOnlyOutput{get;set;}
}
public sealed record HelperSample(string[] Paths,int Start);
public class Stub:DispatchProxy {
 public Func<MethodInfo,object?[]?,object?> Handler=null!;protected override object? Invoke(MethodInfo? method,object?[]? values)=>Handler(method!,values);
 public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler)where T:class {var value=Create<T,Stub>();((Stub)(object)value).Handler=handler;return value;}
 public static object? Default(Type type)=>type==typeof(void)?null:type.IsValueType?Activator.CreateInstance(type):null;
}
public sealed class RecorderLogger<T>(List<object> entries):ILogger<T> {
 public bool IsEnabled(LogLevel level)=>true;public IDisposable? BeginScope<TState>(TState state)where TState:notnull=>null;
 public void Log<TState>(LogLevel level,EventId eventId,TState state,Exception? error,Func<TState,Exception?,string> formatter)=>entries.Add(new {level=level.ToString(),message=formatter(state,error)});
}
