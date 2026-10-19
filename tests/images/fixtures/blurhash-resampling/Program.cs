using System.Security.Cryptography;
using System.Text.Json;
using BlurHashSharp;
using BlurHashSharp.SkiaSharp;
using SkiaSharp;
var inputs=JsonSerializer.Deserialize<string[]>(File.ReadAllText(args[0]))!;var output=Path.GetFullPath(args[1]);Directory.CreateDirectory(output);var results=new List<object>();
foreach(var input in inputs){
using var codec=SKCodec.Create(input);var original=codec.Info;var scale=ScaleHelper.GetScale(original.Width,original.Height,128,128);var supported=codec.GetScaledDimensions(scale);
var info=new SKImageInfo{Width=supported.Width,Height=supported.Height,ColorType=SKColorType.Rgba8888,AlphaType=SKAlphaType.Unpremul,ColorSpace=SKColorSpace.CreateSrgb()};
using var bitmap=SKBitmap.Decode(codec,info);var(sw,sh)=ScaleHelper.GetScaleDimensions(bitmap.Width,bitmap.Height,scale);using var resized=bitmap.Resize(info.WithSize(sw,sh),SKSamplingOptions.Default);
var name=Path.GetFileName(input);var decoded=bitmap.GetPixelSpan().ToArray();var scaled=resized.GetPixelSpan().ToArray();var decodedPath=Path.Combine(output,name+".decoded.rgba");var scaledPath=Path.Combine(output,name+".scaled.rgba");File.WriteAllBytes(decodedPath,decoded);File.WriteAllBytes(scaledPath,scaled);
float xf=MathF.Sqrt(16f*original.Width/original.Height),yf=xf*original.Height/original.Width;int xc=Math.Min((int)xf+1,9),yc=Math.Min((int)yf+1,9);
using var stream=File.OpenRead(input);var direct=BlurHashEncoder.Encode(xc,yc,stream,128,128);var core=CoreBlurHashEncoder.Encode(xc,yc,resized.Width,resized.Height,scaled,resized.RowBytes,PixelFormat.RGB888x);
results.Add(new{name,input,inputSha256=Hash(File.ReadAllBytes(input)),original=new{original.Width,original.Height},scale,supported=new{supported.Width,supported.Height},decoded=new{bitmap.Width,bitmap.Height,bitmap.RowBytes,path=decodedPath,bytes=decoded.Length,sha256=Hash(decoded)},scaled=new{resized.Width,resized.Height,resized.RowBytes,path=scaledPath,bytes=scaled.Length,sha256=Hash(scaled)},components=new{xc,yc},direct,core});
}
var result=new{actualExecution=true,results,assemblies=AppDomain.CurrentDomain.GetAssemblies().Where(a=>!a.IsDynamic&&!string.IsNullOrEmpty(a.Location)).Select(a=>new{a.FullName,path=a.Location,sha256=Hash(File.ReadAllBytes(a.Location))})};File.WriteAllText(Path.Combine(output,"native.json"),JsonSerializer.Serialize(result,new JsonSerializerOptions{WriteIndented=true}));Console.WriteLine(JsonSerializer.Serialize(new{cases=results.Count}));
static string Hash(byte[]b)=>Convert.ToHexStringLower(SHA256.HashData(b));
