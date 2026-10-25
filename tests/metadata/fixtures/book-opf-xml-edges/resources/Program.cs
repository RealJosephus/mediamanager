using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using MediaBrowser.Providers.Books.OpenPackagingFormat;
using Microsoft.Extensions.Logging.Abstractions;
Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
var input=JsonDocument.Parse(File.ReadAllText(args[0]));var assets=Path.GetFullPath(args[1]);var results=new List<object>();
foreach(var sample in input.RootElement.GetProperty("cases").EnumerateArray()){
 string? error=null,sha=null;int? length=null;string? message=null;
 try{var doc=new XmlDocument();using var stream=File.OpenRead(Path.Combine(assets,sample.GetProperty("file").GetString()!));doc.Load(stream);
  var result=new OpfReader<OpfProvider>(doc,NullLogger<OpfProvider>.Instance).ReadOpfData(CancellationToken.None);length=result.Item.Name.Length;sha=Hash(Encoding.UTF8.GetBytes(result.Item.Name));}
 catch(Exception ex){error=ex.GetType().Name;message=ex.Message;}
 results.Add(new{name=sample.GetProperty("name").GetString(),error,length,sha,message});
}
var assembly=typeof(OpfProvider).Assembly;
File.WriteAllText(args[2],JsonSerializer.Serialize(new{scope="Actual XmlDocument.Load(Stream) and OpfReader resource-bound observations. Returned metadata is projected only to UTF-16 length and UTF-8 SHA256. No elapsed-time or CLR representation requirement.",results,assembly=new{name=assembly.GetName().Name,sha256=Hash(File.ReadAllBytes(assembly.Location))},assetFiles=Directory.EnumerateFiles(assets).OrderBy(value=>value,StringComparer.Ordinal).Select(value=>new{path=Path.GetFileName(value),sha256=Hash(File.ReadAllBytes(value))}),inputSha256=Hash(File.ReadAllBytes(args[0]))},new JsonSerializerOptions{WriteIndented=true})+"\n");
static string Hash(byte[] bytes)=>Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
