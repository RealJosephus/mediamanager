using System.Globalization;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using Emby.Server.Implementations.IO;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.Books.OpenPackagingFormat;
using Microsoft.Extensions.Logging;
Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
var input=JsonDocument.Parse(File.ReadAllText(args[0]));var assets=Path.GetFullPath(args[1]);
var paths=Stub.Make<IApplicationPaths>((method,_)=>method.Name=="get_TempDirectory"?Path.Combine(assets,"temp"):Stub.Default(method.ReturnType));
var fileSystem=new ManagedFileSystem(new CaptureLogger<ManagedFileSystem>(),paths,Array.Empty<IShortcutHandler>());
var readerResults=new List<object>();
foreach(var sample in input.RootElement.GetProperty("readers").EnumerateArray()){
 var logger=new CaptureLogger<OpfProvider>();object? result=null;string? error=null;
 try{var doc=new XmlDocument();using var stream=File.OpenRead(Path.Combine(assets,sample.GetProperty("file").GetString()!));doc.Load(stream);
  result=Project(new OpfReader<OpfProvider>(doc,logger).ReadOpfData(Token(sample)));}catch(Exception ex){error=ex.GetType().Name;}
 readerResults.Add(new{name=sample.GetProperty("name").GetString(),result,error,logs=logger.Errors});
}
var providerResults=new List<object>();var saved=new DateTime(2026,10,1,1,2,3,DateTimeKind.Utc);
foreach(var sample in input.RootElement.GetProperty("opf").EnumerateArray()){
 var logger=new CaptureLogger<OpfProvider>();var provider=new OpfProvider(fileSystem,logger);var itemPath=Path.Combine(assets,sample.GetProperty("path").GetString()!);var item=new Book{Path=itemPath,DateLastSaved=saved};
 var parent=fileSystem.GetFileSystemInfo(itemPath).IsDirectory?itemPath:Path.GetDirectoryName(itemPath)!;var candidates=new[]{Path.Combine(parent,Path.GetFileNameWithoutExtension(itemPath)+".opf"),Path.Combine(parent,"content.opf"),Path.Combine(parent,"metadata.opf")};
 foreach(var candidate in candidates.Where(File.Exists))File.SetLastWriteTimeUtc(candidate,saved.AddTicks(sample.GetProperty("deltaTicks").GetInt64()));
 Stream? locked=null;if(sample.GetProperty("locked").GetBoolean())locked=File.Open(candidates.First(File.Exists),FileMode.Open,FileAccess.Read,FileShare.None);
 object? result=null;string? error=null;bool? changed=null;
 try{changed=provider.HasChanged(item,null!);result=Project(await provider.GetMetadata(new ItemInfo(item),null!,Token(sample)));}catch(Exception ex){error=ex.GetType().Name;}finally{locked?.Dispose();}
 var selected=candidates.FirstOrDefault(File.Exists);providerResults.Add(new{name=sample.GetProperty("name").GetString(),result,error,changed,selected=selected==null?null:Path.GetFileName(selected),modifiedTicks=selected==null?null:File.GetLastWriteTimeUtc(selected).Ticks.ToString(),logs=logger.Errors});
}
var epubResults=new List<object>();
foreach(var sample in input.RootElement.GetProperty("epubs").EnumerateArray()){
 var path=Path.Combine(assets,sample.GetProperty("path").GetString()!);var logger=new CaptureLogger<EpubProvider>();object? result=null;string? error=null,coverError=null,coverSha=null,coverFormat=null,contentPath=null,coverPath=null;bool? hasCover=null;
 try{result=Project(await new EpubProvider(fileSystem,logger).GetMetadata(new ItemInfo(new Book{Path=path}),null!,Token(sample)));}catch(Exception ex){error=ex.GetType().Name;}
 try{var response=await new EpubImageProvider(new CaptureLogger<EpubImageProvider>()).GetImage(new Book{Path=path},ImageType.Primary,Token(sample));hasCover=response.HasImage;if(response.HasImage){using var stream=response.Stream;using var bytes=new MemoryStream();await stream.CopyToAsync(bytes);coverSha=Hash(bytes.ToArray());coverFormat=response.Format.ToString();}}catch(Exception ex){coverError=ex.GetType().Name;}
 try{using var zip=ZipFile.OpenRead(path);contentPath=EpubUtils.ReadContentFilePath(zip);if(contentPath!=null&&zip.GetEntry(contentPath) is {} entry){using var stream=entry.Open();var doc=new XmlDocument();doc.Load(stream);coverPath=new OpfReader<EpubProvider>(doc,logger).ReadCoverPath(Path.GetDirectoryName(contentPath)??"")?.Path;}}catch{}
 epubResults.Add(new{name=sample.GetProperty("name").GetString(),result,error,hasCover,coverError,coverSha,coverFormat,contentPath,coverPath,logs=logger.Errors});
}
var archiveResults=new List<object>();
foreach(var sample in input.RootElement.GetProperty("archives").EnumerateArray()){
 using var zip=ZipFile.OpenRead(Path.Combine(assets,sample.GetProperty("file").GetString()!));var queries=new List<object>();foreach(var query in sample.GetProperty("queries").EnumerateArray()){var key=query.GetString()!;var entry=zip.GetEntry(key);string? sha=null,error=null;if(entry!=null)try{using var stream=entry.Open();using var bytes=new MemoryStream();stream.CopyTo(bytes);sha=Hash(bytes.ToArray());}catch(Exception ex){error=ex.GetType().Name;}queries.Add(new{key,found=entry!=null,sha,error});}archiveResults.Add(new{name=sample.GetProperty("name").GetString(),entries=zip.Entries.Select(entry=>new{entry.FullName,entry.Length}),queries});
}
var assemblies=new[]{typeof(OpfProvider).Assembly,typeof(Book).Assembly,typeof(ManagedFileSystem).Assembly}.Select(value=>new{name=value.GetName().Name,sha256=Hash(File.ReadAllBytes(value.Location))});
File.WriteAllText(args[2],JsonSerializer.Serialize(new{readerResults,providerResults,epubResults,archiveResults,assemblies,assetFiles=Directory.EnumerateFiles(assets,"*",SearchOption.AllDirectories).OrderBy(value=>value,StringComparer.Ordinal).Select(value=>new{path=Path.GetRelativePath(assets,value).Replace('\\','/'),sha256=Hash(File.ReadAllBytes(value))}),inputSha256=Hash(File.ReadAllBytes(args[0])),localUtcOffset=TimeZoneInfo.Local.BaseUtcOffset.ToString(),localTimeZone=TimeZoneInfo.Local.Id,scope="Actual OPF reader/provider, EPUB metadata/cover and .NET ZipArchive over bound physical XML/ZIP files; actual ManagedFileSystem lookup/mtime; controlled logger and IApplicationPaths temp only. No generic metadata host, SQL, HTTP or release acceptance."},new JsonSerializerOptions{WriteIndented=true})+"\n");
static object Project(MetadataResult<Book> result)=>new{result.HasMetadata,result.ResultLanguage,item=result.Item==null?null:new{result.Item.Name,result.Item.ForcedSortName,result.Item.Overview,result.Item.Studios,result.Item.ProviderIds,result.Item.Genres,result.Item.IndexNumber,result.Item.CommunityRating,communityRatingDouble=(double?)result.Item.CommunityRating,communityRatingBits=result.Item.CommunityRating.HasValue?BitConverter.SingleToInt32Bits(result.Item.CommunityRating.Value):(int?)null,result.Item.SeriesName,result.Item.ProductionYear,premiereDate=result.Item.PremiereDate?.ToString("o"),premiereTicks=result.Item.PremiereDate?.Ticks.ToString(),premiereKind=result.Item.PremiereDate?.Kind.ToString()},people=result.People?.Select(person=>new{person.Name,type=person.Type.ToString(),person.Role,person.ProviderIds})};
static CancellationToken Token(JsonElement sample)=>sample.TryGetProperty("cancelled",out var value)&&value.GetBoolean()?new CancellationToken(true):CancellationToken.None;
static string Hash(byte[] bytes)=>Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
public class Stub:DispatchProxy{public Func<MethodInfo,object?[]?,object?> Handler=null!;protected override object? Invoke(MethodInfo? method,object?[]? values)=>Handler(method!,values);public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler)where T:class{var value=Create<T,Stub>();((Stub)(object)value).Handler=handler;return value;}public static object? Default(Type type)=>type==typeof(void)?null:type.IsValueType?Activator.CreateInstance(type):null;}
public class CaptureLogger<T>:ILogger<T>{public List<string> Errors=new();public IDisposable? BeginScope<TState>(TState state)where TState:notnull=>null;public bool IsEnabled(LogLevel level)=>true;public void Log<TState>(LogLevel level,EventId id,TState state,Exception? exception,Func<TState,Exception?,string> formatter){if(level>=LogLevel.Error)Errors.Add(exception?.GetType().Name??"no-exception");}}
