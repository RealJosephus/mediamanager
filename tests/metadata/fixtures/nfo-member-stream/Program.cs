using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Model.Configuration;
using MediaBrowser.XbmcMetadata.Configuration;
using MediaBrowser.XbmcMetadata.Savers;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("zh-CN");
var input = JsonDocument.Parse(File.ReadAllBytes(args[0]));
var configuration = Stub.Make<IServerConfigurationManager>((method, values) => method.Name switch {
    "get_Configuration" => new ServerConfiguration(), "GetConfiguration" => new XbmcMetadataOptions(), _ => Stub.Default(method.ReturnType)
});
BaseItem.ConfigurationManager = configuration; BaseItem.Logger = NullLogger<BaseItem>.Instance;
var results = new List<object>();
foreach(var scenario in input.RootElement.EnumerateArray()) {
    var definitions = scenario.GetProperty("items").EnumerateArray().ToArray();
    var items = definitions.ToDictionary(value => value.GetProperty("key").GetString()!, value => {
        BaseItem item = value.GetProperty("type").GetString() switch { "MusicAlbum" => new MusicAlbum(), "MusicArtist" => new MusicArtist(), "Audio" => new Audio(), "AudioBook" => new AudioBook(), _ => new Folder() };
        item.Id = Guid.Parse(value.GetProperty("Id").GetString()!); item.Name = value.GetProperty("Name").GetString();
        if(value.TryGetProperty("Path",out var path))item.Path=path.GetString();
        if(value.TryGetProperty("ForcedSortName",out var sort))item.ForcedSortName=sort.GetString();
        if(value.TryGetProperty("ParentIndexNumber",out var parentIndex))item.ParentIndexNumber=parentIndex.GetInt32();
        if(value.TryGetProperty("IndexNumber",out var index))item.IndexNumber=index.GetInt32();
        if(value.TryGetProperty("RunTimeTicks",out var ticks))item.RunTimeTicks=long.Parse(ticks.GetString()!,CultureInfo.InvariantCulture);
        if(value.TryGetProperty("ProductionYear",out var year))item.ProductionYear=year.GetInt32();
        return item;
    });
    foreach(var definition in definitions) if(definition.TryGetProperty("parent",out var parent)) items[definition.GetProperty("key").GetString()!].ParentId=items[parent.GetString()!].Id;
    foreach(var (key,item) in items) if(item is Folder folder) folder.Children=definitions.Where(value=>value.TryGetProperty("parent",out var parent)&&parent.GetString()==key).Select(value=>items[value.GetProperty("key").GetString()!]).ToArray();
    var target=items[scenario.GetProperty("target").GetString()!];
    object saver=target is MusicAlbum ? new AlbumNfoSaver(null!,configuration,null!,null!,null!,NullLogger<AlbumNfoSaver>.Instance) : new ArtistNfoSaver(null!,configuration,null!,null!,null!,NullLogger<ArtistNfoSaver>.Instance);
    using var stream=new MemoryStream();
    using(var writer=XmlWriter.Create(stream,new XmlWriterSettings{Indent=true,Encoding=new UTF8Encoding(false),OmitXmlDeclaration=true,NewLineChars="\r\n"})) {
        writer.WriteStartElement("custom"); saver.GetType().GetMethod("WriteCustomElements",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(saver,[target,writer]); writer.WriteEndElement();
    }
    var body=Encoding.UTF8.GetString(stream.ToArray()); var document=XDocument.Parse(body,LoadOptions.PreserveWhitespace);
    var members=document.Root!.Elements().Where(value=>value.Name.LocalName is "track" or "album").Select(value=>new { type=value.Name.LocalName,fields=value.Elements().ToDictionary(child=>child.Name.LocalName,child=>child.Value)}).ToArray();
    results.Add(new {name=scenario.GetProperty("name").GetString(),body,members});
}
var assemblies=AppDomain.CurrentDomain.GetAssemblies().Where(value=>!value.IsDynamic&&!string.IsNullOrEmpty(value.Location)).OrderBy(value=>value.GetName().Name).Select(value=>new{name=value.GetName().Name,location=value.Location,sha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(value.Location))).ToLowerInvariant()}).ToArray();
File.WriteAllText(args[1],JsonSerializer.Serialize(new {actualNativeNfoCustomMembers=true,physicalChildrenControlled=true,culture=CultureInfo.CurrentCulture.Name,results,assemblies},new JsonSerializerOptions{WriteIndented=true})+"\n");
public class Stub:DispatchProxy {
 public Func<MethodInfo,object?[]?,object?> Handler=null!;
 protected override object? Invoke(MethodInfo? method,object?[]? values)=>Handler(method!,values);
 public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler)where T:class {var value=Create<T,Stub>();((Stub)(object)value).Handler=handler;return value;}
 public static object? Default(Type type)=>type==typeof(void)?null:type.IsValueType?Activator.CreateInstance(type):null;
}
