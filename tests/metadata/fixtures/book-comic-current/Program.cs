using System.Formats.Tar;
using System.Globalization;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.Books;
using MediaBrowser.Providers.Books.ComicBookInfo;
using MediaBrowser.Providers.Books.ComicInfo;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using SharpCompress.Archives;
using SharpCompress.Common;
using SharpCompress.Factories;
using SharpCompress.Writers;
using SharpCompress.Writers.SevenZip;

var inputBytes=File.ReadAllBytes(args[1]);using var input=JsonDocument.Parse(inputBytes);var declaration=input.RootElement;
CultureInfo.CurrentCulture=CultureInfo.GetCultureInfo(declaration.GetProperty("culture").GetString()!);
var output=Path.GetFullPath(args[0]);Directory.CreateDirectory(output);
var stamp=new DateTime(2026,10,1,0,0,0,DateTimeKind.Utc);
var assets=new List<object>();var results=new List<object>();var covers=new List<object>();
bool Flag(JsonElement value,string key)=>value.TryGetProperty(key,out var found)&&found.ValueKind==JsonValueKind.True;
string Text(JsonElement value,string key,string fallback="")=>value.TryGetProperty(key,out var found)&&found.ValueKind!=JsonValueKind.Null?found.GetString()!:fallback;
byte[] XmlBytes(JsonElement sample,string key){if(key=="xml"&&sample.TryGetProperty("xmlBase64",out var encoded))return Convert.FromBase64String(encoded.GetString()!);var xml=Text(sample,key);var encoding=Text(sample,"encoding");return encoding=="utf16le"?[..Encoding.Unicode.GetPreamble(),..Encoding.Unicode.GetBytes(xml)]:encoding=="latin1"?Encoding.Latin1.GetBytes(xml):Encoding.UTF8.GetBytes(xml);}
byte[] EntryBytes(JsonElement entry)=>entry.TryGetProperty("asset",out var asset)?File.ReadAllBytes(asset.GetString()=="poster"?args[2]:args[3]):entry.TryGetProperty("base64",out var data)?Convert.FromBase64String(data.GetString()!):Encoding.UTF8.GetBytes(Text(entry,"text"));
void Bind(string filename,string scope){var bytes=File.ReadAllBytes(filename);assets.Add(new{scope,path=filename,bytes=bytes.Length,sha256=Hash(bytes)});}
var paths=Stub.Make<IServerApplicationPaths>((method,values)=>method.Name switch{"get_ProgramDataPath"=>output,"get_InternalMetadataPath"=>Path.Combine(output,"metadata"),"get_TempDirectory"=>Path.Combine(output,"temp"),_=>Stub.Default(method.ReturnType)});
var config=Stub.Make<IServerConfigurationManager>((method,values)=>method.Name switch{"get_Configuration"=>new ServerConfiguration(),"get_ApplicationPaths"=>paths,_=>Stub.Default(method.ReturnType)});
BaseItem.ConfigurationManager=config;BaseItem.Logger=NullLogger<BaseItem>.Instance;
var actualFs=new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance,paths,[]);

foreach(var sample in declaration.GetProperty("metadataCases").EnumerateArray()){
 var name=Text(sample,"name");var root=Path.Combine(output,"metadata-cases",name);Directory.CreateDirectory(root);
 var filename=Path.Combine(root,"book"+Text(sample,"extension",".cbz"));
 if(Flag(sample,"directory"))Directory.CreateDirectory(filename);
 else if(!Flag(sample,"missing")){
  using(var stream=File.Create(filename))using(var archive=new System.IO.Compression.ZipArchive(stream,ZipArchiveMode.Create)){
   if(sample.TryGetProperty("comment",out var comment)&&comment.ValueKind!=JsonValueKind.Null)archive.Comment=comment.GetString();
   if(sample.TryGetProperty("internalXml",out _)||sample.TryGetProperty("xml",out _)||sample.TryGetProperty("xmlBase64",out _)){
    var key=Text(sample,"internalKey","ComicInfo.xml");var entry=archive.CreateEntry(key);entry.LastWriteTime=stamp;using var target=entry.Open();target.Write(XmlBytes(sample,sample.TryGetProperty("internalXml",out _)?"internalXml":"xml"));
   }
  }
  File.SetLastWriteTimeUtc(filename,stamp);Bind(filename,name);
 }
 var sidecarRoot=Flag(sample,"directory")?filename:root;
 if(sample.TryGetProperty("xml",out _)||sample.TryGetProperty("xmlBase64",out _)){var sidecar=Path.Combine(sidecarRoot,"book.xml");File.WriteAllBytes(sidecar,XmlBytes(sample,"xml"));File.SetLastWriteTimeUtc(sidecar,stamp);Bind(sidecar,name);}
 if(sample.TryGetProperty("genericXml",out _)){var generic=Path.Combine(sidecarRoot,"ComicInfo.xml");File.WriteAllText(generic,Text(sample,"genericXml"));File.SetLastWriteTimeUtc(generic,stamp);Bind(generic,name);}
 var fileSystem=Stub.Make<IFileSystem>((method,values)=>{
  if(Flag(sample,"lookupFailure")&&method.Name=="GetFileSystemInfo")throw new IOException("Injected media lookup failure");
  if(Flag(sample,"sidecarLookupFailure")&&method.Name=="GetFileInfo")throw new IOException("Injected sidecar lookup failure");
  return Stub.Forward(actualFs,method,values);
 });
 BaseItem.FileSystem=fileSystem;
 foreach(var providerName in new[]{"comment","external","internal","combined"}){
  var logs=new List<object>();var trace=new List<string>();
  IComicProvider[] components=[new ComicBookInfoProvider(fileSystem,new CaptureLogger<ComicBookInfoProvider>(logs)),new ExternalComicInfoProvider(fileSystem,new CaptureLogger<ExternalComicInfoProvider>(logs)),new InternalComicInfoProvider(fileSystem,new CaptureLogger<InternalComicInfoProvider>(logs))];
  components=components.Select((provider,index)=>(IComicProvider)new TraceComic(provider,trace,new[]{"comment","external","internal"}[index])).ToArray();
  var book=new Book{Path=filename,Name="Stored",DateLastSaved=stamp.AddTicks(-1)};var info=new ItemInfo(book);
  bool? changed=null;string? changeError=null,error=null;MetadataResult<Book>? result=null;
  try{changed=providerName=="combined"?new ComicProvider(components).HasChanged(book,null!):components[Array.IndexOf(new[]{"comment","external","internal"},providerName)].HasItemChanged(book);}catch(Exception exception){changeError=exception.GetType().Name;}
  trace.Clear();logs.Clear();using var cancel=new CancellationTokenSource();if(Flag(sample,"cancelled"))cancel.Cancel();
  try{result=providerName=="combined"?await new ComicProvider(components).GetMetadata(info,null!,cancel.Token):await components[Array.IndexOf(new[]{"comment","external","internal"},providerName)].ReadMetadata(info,null!,cancel.Token);}catch(Exception exception){error=exception.GetType().Name;}
  var shape=actualFs.GetFileSystemInfo(filename);
  results.Add(new{name,provider=providerName,changed,changeError,error,trace,logs,result=Project(result),source=new{exists=shape.Exists,kind=shape.IsDirectory?"directory":"file",modified=shape.LastWriteTimeUtc.ToString("O"),path=filename}});
 }
}

foreach(var sample in declaration.GetProperty("coverCases").EnumerateArray()){
 var name=Text(sample,"name");var root=Path.Combine(output,"cover-cases",name);Directory.CreateDirectory(root);
 var filename=Path.Combine(root,"book"+Text(sample,"extension",".cbz"));
 var entries=sample.GetProperty("entries").EnumerateArray().ToArray();var format=Text(sample,"format","zip");
 if(!Flag(sample,"missing")){
  if(format=="asset")File.Copy(Path.Combine(args[5],Text(sample,"assetPath")),filename);
  else if(format=="raw")File.WriteAllText(filename,"not an archive");
  else if(format=="tar"){
   using var stream=File.Create(filename);using var writer=new TarWriter(stream,TarEntryFormat.Pax,true);
   foreach(var entry in entries){using var data=new MemoryStream(EntryBytes(entry));writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile,Text(entry,"key")){DataStream=data,ModificationTime=stamp});}
  }else if(format=="7z"){
   using var stream=File.Create(filename);using var writer=WriterFactory.OpenWriter(stream,ArchiveType.SevenZip,new SevenZipWriterOptions());
   foreach(var entry in entries){using var data=new MemoryStream(EntryBytes(entry));writer.Write(Text(entry,"key"),data,stamp);}
  }else if(format=="gzip"){
   using var stream=File.Create(filename);using var writer=WriterFactory.OpenWriter(stream,ArchiveType.GZip,new WriterOptions(CompressionType.GZip));
   foreach(var entry in entries){using var data=new MemoryStream(EntryBytes(entry));writer.Write(Text(entry,"key"),data,stamp);}
  }else if(format=="gzip-no-name"){
   using var stream=File.Create(filename);using var compressed=new GZipStream(stream,CompressionLevel.SmallestSize);compressed.Write(EntryBytes(entries[0]));
  }else if(Flag(sample,"rawZip"))CreateRawZip(filename,sample,entries,EntryBytes);
  else{using var stream=File.Create(filename);using var archive=new System.IO.Compression.ZipArchive(stream,ZipArchiveMode.Create);foreach(var entry in entries){var created=archive.CreateEntry(Text(entry,"key"));created.LastWriteTime=stamp;using var target=created.Open();target.Write(EntryBytes(entry));}}
  Bind(filename,name);
 }
 var logs=new List<object>();var provider=new ComicImageProvider(new CaptureLogger<ComicImageProvider>(logs));var book=new Book{Path=filename};
 CultureInfo.CurrentCulture=CultureInfo.GetCultureInfo(Text(sample,"culture",Text(declaration,"culture","en-US")));
 using var cancel=new CancellationTokenSource();if(Flag(sample,"cancelled"))cancel.Cancel();
 var result=await provider.GetImage(book,Enum.Parse<ImageType>(Text(sample,"imageType","Primary")),cancel.Token);
 byte[]? image=null;string? coverPath=null;if(result.Stream!=null){using(result.Stream){using var target=new MemoryStream();await result.Stream.CopyToAsync(target);image=target.ToArray();coverPath=Path.Combine(root,"selected-cover.bin");File.WriteAllBytes(coverPath,image);Bind(coverPath,name);}}
 var catalog=new List<object>();string? archiveType=null,archiveError=null;
 if(File.Exists(filename))try{using var source=File.OpenRead(filename);await using var archive=await ArchiveFactory.OpenAsyncArchive(source);archiveType=archive.GetType().FullName;var ordinal=0;await foreach(var entry in archive.EntriesAsync){string? entryPath=null,entrySha256=null,readError=null;try{await using var data=await entry.OpenEntryStreamAsync();using var memory=new MemoryStream();await data.CopyToAsync(memory);var raw=memory.ToArray();entryPath=Path.Combine(root,"entry-"+ordinal+".bin");File.WriteAllBytes(entryPath,raw);entrySha256=Hash(raw);Bind(entryPath,name);}catch(Exception error){readError=error.GetType().Name;}catalog.Add(new{key=entry.Key,isDirectory=entry.IsDirectory,size=entry.Size,entryPath,entrySha256,readError});ordinal++;}}catch(Exception error){archiveError=error.GetType().Name;}
 bool unlocked=true;if(File.Exists(filename))try{using var exclusive=File.Open(filename,FileMode.Open,FileAccess.Read,FileShare.None);}catch{unlocked=false;}
 covers.Add(new{name,path=filename,coverPath,culture=CultureInfo.CurrentCulture.Name,hasImage=result.HasImage,format=result.Format.ToString(),bytes=image?.Length,sha256=image==null?null:Hash(image),logs,archiveType,archiveError,entries=catalog,sourceUnlocked=unlocked});
}
var languages=declaration.GetProperty("languages").EnumerateArray().Select(value=>{var text=value.GetString()!;string? constructed=null,cached=null,error=null;try{constructed=new CultureInfo(text).TwoLetterISOLanguageName;}catch(Exception exception){error=exception.GetType().Name;}try{cached=CultureInfo.GetCultureInfo(text).TwoLetterISOLanguageName;}catch{}return new{value=text,constructed,cached,error};}).ToArray();
var factories=Factory.Factories.Select(factory=>new{name=factory.Name,type=factory.GetType().FullName,interfaces=factory.GetType().GetInterfaces().Select(value=>value.Name).Order().ToArray(),extensions=factory.GetSupportedExtensions().ToArray()}).ToArray();
var cultures=CultureInfo.GetCultures(CultureTypes.AllCultures).OrderBy(value=>value.Name,StringComparer.Ordinal).Select(value=>new{value.Name,value.TwoLetterISOLanguageName,value.ThreeLetterISOLanguageName}).ToArray();
File.WriteAllText(args[4],JsonSerializer.Serialize(new{actualProviders=true,actualComicReaders=true,actualArchiveEngines=true,inputSha256=Hash(inputBytes),culture=Text(declaration,"culture"),results,covers,languages,cultures,factories,assets,
 assemblies=AppDomain.CurrentDomain.GetAssemblies().Where(assembly=>!assembly.IsDynamic&&!string.IsNullOrEmpty(assembly.Location)).Select(assembly=>new{name=assembly.GetName().Name,path=assembly.Location,sha256=Hash(File.ReadAllBytes(assembly.Location))})},new JsonSerializerOptions{WriteIndented=true})+"\n");
Console.WriteLine(JsonSerializer.Serialize(new{metadata=results.Count,covers=covers.Count}));
static object? Project(MetadataResult<Book>? result){if(result==null)return null;var item=result.Item;return new{result.HasMetadata,result.ResultLanguage,item=item==null?null:new{item.Name,item.SeriesName,item.IndexNumber,item.Overview,item.ProductionYear,item.OriginalTitle,premiereDate=item.PremiereDate?.ToString("O"),premiereDateTicks=item.PremiereDate?.Ticks.ToString(),premiereDateKind=item.PremiereDate?.Kind.ToString(),item.Genres,item.Studios,item.Tags},people=result.People?.Select(person=>new{person.Name,type=person.Type.ToString(),person.Role,person.SortOrder,person.ImageUrl,person.ProviderIds})};}
static string Hash(byte[] bytes)=>Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
static uint Crc(byte[] bytes){uint value=0xffffffff;foreach(var b in bytes){value^=b;for(int bit=0;bit<8;bit++)value=(value&1)!=0?(value>>1)^0xedb88320:value>>1;}return~value;}
static void CreateRawZip(string filename,JsonElement sample,JsonElement[] entries,Func<JsonElement,byte[]> bytes){
 using var stream=File.Create(filename);using var writer=new BinaryWriter(stream,Encoding.UTF8,true);var records=new List<(byte[] name,byte[] extra,byte[] data,uint crc,uint offset,ushort flags)>();
 foreach(var entry in entries){var name=entry.TryGetProperty("keyBytesBase64",out var raw)?Convert.FromBase64String(raw.GetString()!):Encoding.UTF8.GetBytes(entry.GetProperty("key").GetString()!);var data=bytes(entry);var crc=Crc(data);var flags=(ushort)(entry.TryGetProperty("flags",out var f)?f.GetInt32():0x800);byte[] extra=[];
  if(entry.TryGetProperty("unicodePath",out var unicode)){using var memory=new MemoryStream();using var field=new BinaryWriter(memory);var text=Encoding.UTF8.GetBytes(unicode.GetString()!);field.Write((ushort)0x7075);field.Write((ushort)(5+text.Length));field.Write((byte)(entry.TryGetProperty("unicodeVersion",out var version)?version.GetInt32():1));field.Write(Crc(name)^(entry.TryGetProperty("invalidCrc",out var bad)&&bad.GetBoolean()?1u:0u));field.Write(text);extra=memory.ToArray();}
  var offset=(uint)stream.Position;writer.Write(0x04034b50u);writer.Write((ushort)20);writer.Write(flags);writer.Write((ushort)0);writer.Write(0u);writer.Write(crc);writer.Write((uint)data.Length);writer.Write((uint)data.Length);writer.Write((ushort)name.Length);writer.Write((ushort)extra.Length);writer.Write(name);writer.Write(extra);writer.Write(data);records.Add((name,extra,data,crc,offset,flags));
 }
 var start=(uint)stream.Position;var order=sample.TryGetProperty("centralOrder",out var declared)?declared.EnumerateArray().Select(value=>value.GetInt32()):Enumerable.Range(0,records.Count);
 foreach(var index in order){var r=records[index];writer.Write(0x02014b50u);writer.Write((ushort)20);writer.Write((ushort)20);writer.Write(r.flags);writer.Write((ushort)0);writer.Write(0u);writer.Write(r.crc);writer.Write((uint)r.data.Length);writer.Write((uint)r.data.Length);writer.Write((ushort)r.name.Length);writer.Write((ushort)r.extra.Length);writer.Write((ushort)0);writer.Write((ushort)0);writer.Write((ushort)0);writer.Write(0u);writer.Write(r.offset);writer.Write(r.name);writer.Write(r.extra);}
 var length=(uint)stream.Position-start;writer.Write(0x06054b50u);writer.Write((ushort)0);writer.Write((ushort)0);writer.Write((ushort)records.Count);writer.Write((ushort)records.Count);writer.Write(length);writer.Write(start);writer.Write((ushort)0);
}
public class CaptureLogger<T>(List<object> entries):ILogger<T>{public IDisposable? BeginScope<TState>(TState state)where TState:notnull=>null;public bool IsEnabled(LogLevel level)=>true;public void Log<TState>(LogLevel level,EventId id,TState state,Exception? error,Func<TState,Exception?,string> formatter)=>entries.Add(new{level=level.ToString(),exception=error?.GetType().Name});}
public class TraceComic(IComicProvider actual,List<string> trace,string name):IComicProvider{public ValueTask<MetadataResult<Book>> ReadMetadata(ItemInfo item,IDirectoryService directory,CancellationToken token){trace.Add(name);return actual.ReadMetadata(item,directory,token);}public bool HasItemChanged(BaseItem item){trace.Add(name);return actual.HasItemChanged(item);}}
public class Stub:DispatchProxy{public Func<MethodInfo,object?[]?,object?> Handler=null!;protected override object? Invoke(MethodInfo? method,object?[]? values)=>Handler(method!,values);public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler)where T:class{var value=Create<T,Stub>();((Stub)(object)value).Handler=handler;return value;}public static object? Default(Type type)=>type==typeof(void)?null:type.IsValueType?Activator.CreateInstance(type):null;public static object? Forward(object target,MethodInfo method,object?[]? values){try{return method.Invoke(target,values);}catch(TargetInvocationException error){ExceptionDispatchInfo.Capture(error.InnerException!).Throw();throw;}}}
