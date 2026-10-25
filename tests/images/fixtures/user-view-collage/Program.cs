using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Drawing.Skia;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Drawing;
using Microsoft.Extensions.Logging.Abstractions;
using SkiaSharp;

var root = Path.GetFullPath(args[0]);
var assets = Path.Combine(root, "assets"); Directory.CreateDirectory(assets);
string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
string Pixels(SKBitmap bitmap) {
 var pixels = new byte[bitmap.ByteCount]; Marshal.Copy(bitmap.GetPixels(), pixels, 0, pixels.Length);
 if (bitmap.ColorType == SKColorType.Bgra8888) for (int i=0;i<pixels.Length;i+=4) (pixels[i],pixels[i+2])=(pixels[i+2],pixels[i]);
 return Hash(pixels);
}
foreach (var (name, width, height, alpha) in new[]{("same",960,540,false),("small",160,90,false),("large",1920,1080,false),
 ("portrait",240,360,false),("wide",960,120,false),("alpha",960,540,true)}) {
 using var bitmap = new SKBitmap(width,height);
 for(int y=0;y<height;y++) for(int x=0;x<width;x++) bitmap.SetPixel(x,y,new SKColor((byte)(x*17+y*3),(byte)(x*5+y*11),(byte)(x*7+y*19),alpha?(byte)(30+(x+y)%226):(byte)255));
 using var stream=File.Create(Path.Combine(assets,name+".png")); bitmap.Encode(stream,SKEncodedImageFormat.Png,90);
}
File.WriteAllText(Path.Combine(assets,"broken.png"),"Not an image");
File.WriteAllText(Path.Combine(assets,"vector.svg"),"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"960\" height=\"540\"><rect width=\"960\" height=\"540\" fill=\"red\"/></svg>");
File.WriteAllBytes(Path.Combine(assets,"static.gif"),Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"));
Directory.CreateDirectory(Path.Combine(assets,"directory.png"));
var paths=Stub.Make<IApplicationPaths>((method,values)=>method.Name switch {
 "get_DataPath"=>root,"get_CachePath"=>Path.Combine(root,"cache"),"get_TempDirectory"=>Path.Combine(root,"temp"),_=>Stub.Default(method.ReturnType)});
var encoder=new SkiaEncoder(NullLogger<SkiaEncoder>.Instance,paths);
var samples=new List<Sample>();
foreach(var name in new[]{"same","small","large","portrait","wide","alpha"}) samples.Add(new(name,[name+".png"],""));
samples.Add(new("skip",["missing.png","broken.png","vector.svg","same.png"],""));
samples.Add(new("empty",[],"Movies")); samples.Add(new("invalid",["missing.png","broken.png","vector.svg"],"Movies"));
samples.Add(new("directory",["directory.png","same.png"],"Movies")); samples.Add(new("gif",["static.gif"],"Movies"));
foreach(var name in new[]{"Movies","AVATAR","A very long library name for movies and documentaries","电影","電影庫","Movies 电影","العربية","עברית","Հայերեն","😀 Movies"}) samples.Add(new("text-"+samples.Count,["same.png"],name));
var results=new List<object>();
foreach(var sample in samples) {
 var filename=Path.Combine(root,sample.Name+".png"); Exception? failure=null;
 try {encoder.CreateImageCollage(new ImageCollageOptions {Width=960,Height=540,InputPaths=sample.Paths.Select(value=>Path.Combine(assets,value)).ToArray(),OutputPath=filename},sample.Text);}
 catch(Exception error){failure=error;}
 using var bitmap=File.Exists(filename)?SKBitmap.Decode(filename):null;
 results.Add(new {sample,error=failure is null?null:new {type=failure.GetType().Name,failure.Message},output=bitmap is null?null:new {bitmap.Width,bitmap.Height,pixelHash=Pixels(bitmap),sha256=Hash(File.ReadAllBytes(filename))}});
}
var font=SkiaEncoder.DefaultTypeFace!;
using var textFont=new SKFont(font,112);
var fontInfo=new {font.FamilyName,font.FontWeight,font.FontWidth,font.FontSlant,metrics=textFont.Metrics.XHeight,
 measure=textFont.MeasureText("Movies"),typefaces=((SKTypeface?[])typeof(SkiaEncoder).GetField("_typefaces",BindingFlags.Static|BindingFlags.NonPublic)!.GetValue(null)!).Select(value=>value?.FamilyName).ToArray()};
File.WriteAllText(Path.Combine(root,"native.json"),JsonSerializer.Serialize(new {actualSkiaEncoder=true,actualStripCollageBuilder=true,fontInfo,results},new JsonSerializerOptions{WriteIndented=true})+"\n");
Console.WriteLine(JsonSerializer.Serialize(new {cases=results.Count,fontInfo}));
public sealed record Sample(string Name,string[] Paths,string Text);
public class Stub:DispatchProxy {
 public Func<MethodInfo,object?[]?,object?> Handler=null!;
 protected override object? Invoke(MethodInfo? method,object?[]? values)=>Handler(method!,values);
 public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler)where T:class {var value=Create<T,Stub>();((Stub)(object)value).Handler=handler;return value;}
 public static object? Default(Type type)=>type==typeof(void)?null:type.IsValueType?Activator.CreateInstance(type):null;
}
