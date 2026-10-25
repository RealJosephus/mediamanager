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
using Microsoft.Extensions.Logging.Abstractions;
Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
if (args.Length != 3) throw new ArgumentException("Expected manifest, new asset directory and output JSON.");
var inputBytes = File.ReadAllBytes(args[0]);
using var document = JsonDocument.Parse(inputBytes);
var manifest = document.RootElement;
var requested = manifest.GetProperty("timeZone").GetString()!;
if (Environment.GetEnvironmentVariable("TZ") != requested) throw new IOException("The declared time zone must be bound to the native process.");
var instant = manifest.GetProperty("timeZoneInstant").GetString()!;
var utc = DateTime.Parse(instant, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
var offsetMinutes = TimeZoneInfo.Local.GetUtcOffset(utc).TotalMinutes;
if (offsetMinutes != manifest.GetProperty("timeZoneOffsetMinutes").GetInt32()) throw new IOException("The actual native time zone offset differs from its declared input.");
var timeZoneControl = new { requested, effective = TimeZoneInfo.Local.Id, instant, offsetMinutes };
var assetRoot = Path.GetFullPath(args[1]);
if (Directory.Exists(assetRoot)) throw new IOException("The native case directory must be new.");
Directory.CreateDirectory(assetRoot);
var sourceRoot = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[0]))!, "assets");
var groups = new Dictionary<string, object>();
foreach (var group in manifest.GetProperty("groups").EnumerateObject())
{
    var assets = Path.Combine(assetRoot, group.Name);
    Directory.CreateDirectory(assets);
    foreach (var entry in group.Value.GetProperty("assets").EnumerateArray())
    {
        var relative = SafeRelative(entry.GetProperty("path").GetString()!);
        var stored = SafeRelative(entry.GetProperty("storedPath").GetString()!);
        var bytes = File.ReadAllBytes(Path.Combine(sourceRoot, group.Name, stored));
        if (bytes.LongLength != entry.GetProperty("bytes").GetInt64() || Hash(bytes) != entry.GetProperty("sha256").GetString())
            throw new IOException("The stored asset changed: " + stored);
        if (entry.GetProperty("compression").ValueKind != JsonValueKind.Null)
        {
            if (entry.GetProperty("compression").GetString() != "gzip") throw new IOException("Unknown asset compression.");
            using var compressed = new MemoryStream(bytes);
            using var gzip = new GZipStream(compressed, CompressionMode.Decompress);
            using var expanded = new MemoryStream();
            gzip.CopyTo(expanded); bytes = expanded.ToArray();
        }
        if (bytes.LongLength != entry.GetProperty("expandedBytes").GetInt64() || Hash(bytes) != entry.GetProperty("expandedSha256").GetString())
            throw new IOException("The expanded asset changed: " + relative);
        var filename = Path.Combine(assets, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(filename)!);
        File.WriteAllBytes(filename, bytes);
    }
    foreach (var relative in group.Value.GetProperty("directories").EnumerateArray())
        Directory.CreateDirectory(Path.Combine(assets, SafeRelative(relative.GetString()!)));
    var input = group.Value.GetProperty("input");
    groups.Add(group.Name, group.Name == "resources" ? ObserveResources(input, assets) : await Observe(input, assets));
}
var assemblies = new[] { typeof(OpfProvider).Assembly, typeof(Book).Assembly, typeof(ManagedFileSystem).Assembly, Assembly.Load("jellyfin") }
    .Select(value => new { name = value.GetName().Name, value.FullName, sha256 = Hash(File.ReadAllBytes(value.Location)) });
File.WriteAllText(args[2], JsonSerializer.Serialize(new { actualExecution = true, groups, assemblies, timeZoneControl,
    inputSha256 = Hash(inputBytes), scope = manifest.GetProperty("scope").GetString() }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static string SafeRelative(string value)
{
    if (Path.IsPathRooted(value) || value.Contains('\\') || value.Contains(':') || value.Split('/').Any(part => part is "" or "." or ".."))
        throw new IOException("Invalid declared asset path.");
    return value;
}
static object[] AssetFiles(string assets) => Directory.EnumerateFiles(assets, "*", SearchOption.AllDirectories)
    .OrderBy(value => value, StringComparer.Ordinal).Select(value => (object)new { path = Path.GetRelativePath(assets, value).Replace('\\', '/'),
        bytes = new FileInfo(value).Length, sha256 = Hash(File.ReadAllBytes(value)) }).ToArray();
static object ObserveResources(JsonElement input, string assets)
{
    var results = new List<object>();
foreach(var sample in input.GetProperty("cases").EnumerateArray()){
 string? error=null,sha=null;int? length=null;string? message=null;
 try{var doc=new XmlDocument();using var stream=File.OpenRead(Path.Combine(assets,sample.GetProperty("file").GetString()!));doc.Load(stream);
  var result=new OpfReader<OpfProvider>(doc,NullLogger<OpfProvider>.Instance).ReadOpfData(CancellationToken.None);length=result.Item.Name.Length;sha=Hash(Encoding.UTF8.GetBytes(result.Item.Name));}
 catch(Exception ex){error=ex.GetType().Name;message=ex.Message;}
 results.Add(new{name=sample.GetProperty("name").GetString(),error,length,sha,message});
}
return new { results, assetFiles = AssetFiles(assets) };
}
static async Task<object> Observe(JsonElement input, string assets)
{
var paths=Stub.Make<IApplicationPaths>((method,_)=>method.Name=="get_TempDirectory"?Path.Combine(assets,"temp"):Stub.Default(method.ReturnType));
var fileSystem=new ManagedFileSystem(new CaptureLogger<ManagedFileSystem>(),paths,Array.Empty<IShortcutHandler>());
var readerResults=new List<object>();
foreach(var sample in input.GetProperty("readers").EnumerateArray()){
 var logger=new CaptureLogger<OpfProvider>();object? result=null;string? error=null;
 try{var doc=new XmlDocument();using var stream=File.OpenRead(Path.Combine(assets,sample.GetProperty("file").GetString()!));doc.Load(stream);
  result=Project(new OpfReader<OpfProvider>(doc,logger).ReadOpfData(Token(sample)));}catch(Exception ex){error=ex.GetType().Name;}
 readerResults.Add(new{name=sample.GetProperty("name").GetString(),result,error,logs=logger.Errors});
}
var providerResults=new List<object>();var saved=new DateTime(2026,10,1,1,2,3,DateTimeKind.Utc);
foreach(var sample in input.GetProperty("opf").EnumerateArray()){
 var logger=new CaptureLogger<OpfProvider>();var provider=new OpfProvider(fileSystem,logger);var itemPath=Path.Combine(assets,sample.GetProperty("path").GetString()!);var item=new Book{Path=itemPath,DateLastSaved=saved};
 var parent=fileSystem.GetFileSystemInfo(itemPath).IsDirectory?itemPath:Path.GetDirectoryName(itemPath)!;var candidates=new[]{Path.Combine(parent,Path.GetFileNameWithoutExtension(itemPath)+".opf"),Path.Combine(parent,"content.opf"),Path.Combine(parent,"metadata.opf")};
 var requestedModifiedTicks=saved.AddTicks(sample.GetProperty("deltaTicks").GetInt64()).Ticks.ToString();
 foreach(var candidate in candidates.Where(File.Exists))File.SetLastWriteTimeUtc(candidate,new DateTime(long.Parse(requestedModifiedTicks),DateTimeKind.Utc));
 Stream? locked=null;if(sample.GetProperty("locked").GetBoolean())locked=File.Open(candidates.First(File.Exists),FileMode.Open,FileAccess.Read,FileShare.None);
 object? result=null;string? error=null;bool? changed=null;
 try{changed=provider.HasChanged(item,null!);result=Project(await provider.GetMetadata(new ItemInfo(item),null!,Token(sample)));}catch(Exception ex){error=ex.GetType().Name;}finally{locked?.Dispose();}
 var selected=candidates.FirstOrDefault(File.Exists);providerResults.Add(new{name=sample.GetProperty("name").GetString(),result,error,changed,selected=selected==null?null:Path.GetFileName(selected),modifiedTicks=selected==null?null:File.GetLastWriteTimeUtc(selected).Ticks.ToString(),requestedModifiedTicks,fileTimes=candidates.Where(File.Exists).Select(value=>new{path=Path.GetRelativePath(assets,value).Replace('\\','/'),ticks=File.GetLastWriteTimeUtc(value).Ticks.ToString()}),logs=logger.Errors});
}
var epubResults=new List<object>();
foreach(var sample in input.GetProperty("epubs").EnumerateArray()){
 var path=Path.Combine(assets,sample.GetProperty("path").GetString()!);var logger=new CaptureLogger<EpubProvider>();object? result=null;string? error=null,coverError=null,coverSha=null,coverFormat=null,contentPath=null,coverPath=null;bool? hasCover=null;
 try{result=Project(await new EpubProvider(fileSystem,logger).GetMetadata(new ItemInfo(new Book{Path=path}),null!,Token(sample)));}catch(Exception ex){error=ex.GetType().Name;}
 try{var response=await new EpubImageProvider(new CaptureLogger<EpubImageProvider>()).GetImage(new Book{Path=path},ImageType.Primary,Token(sample));hasCover=response.HasImage;if(response.HasImage){using var stream=response.Stream;using var bytes=new MemoryStream();await stream.CopyToAsync(bytes);coverSha=Hash(bytes.ToArray());coverFormat=response.Format.ToString();}}catch(Exception ex){coverError=ex.GetType().Name;}
 try{using var zip=ZipFile.OpenRead(path);contentPath=EpubUtils.ReadContentFilePath(zip);if(contentPath!=null&&zip.GetEntry(contentPath) is {} entry){using var stream=entry.Open();var doc=new XmlDocument();doc.Load(stream);coverPath=new OpfReader<EpubProvider>(doc,logger).ReadCoverPath(Path.GetDirectoryName(contentPath)??"")?.Path;}}catch{}
 epubResults.Add(new{name=sample.GetProperty("name").GetString(),result,error,hasCover,coverError,coverSha,coverFormat,contentPath,coverPath,logs=logger.Errors});
}
var archiveResults=new List<object>();
foreach(var sample in input.GetProperty("archives").EnumerateArray()){
 using var zip=ZipFile.OpenRead(Path.Combine(assets,sample.GetProperty("file").GetString()!));var queries=new List<object>();foreach(var query in sample.GetProperty("queries").EnumerateArray()){var key=query.GetString()!;var entry=zip.GetEntry(key);string? sha=null,error=null;if(entry!=null)try{using var stream=entry.Open();using var bytes=new MemoryStream();stream.CopyTo(bytes);sha=Hash(bytes.ToArray());}catch(Exception ex){error=ex.GetType().Name;}queries.Add(new{key,found=entry!=null,sha,error});}archiveResults.Add(new{name=sample.GetProperty("name").GetString(),entries=zip.Entries.Select(entry=>new{entry.FullName,entry.Length}),queries});
}
return new { readerResults, providerResults, epubResults, archiveResults, assetFiles = AssetFiles(assets) };
}
static object Project(MetadataResult<Book> result)=>new{result.HasMetadata,result.ResultLanguage,item=result.Item==null?null:new{result.Item.Name,result.Item.ForcedSortName,result.Item.Overview,result.Item.Studios,result.Item.ProviderIds,result.Item.Genres,result.Item.IndexNumber,result.Item.CommunityRating,communityRatingDouble=(double?)result.Item.CommunityRating,communityRatingBits=result.Item.CommunityRating.HasValue?BitConverter.SingleToInt32Bits(result.Item.CommunityRating.Value):(int?)null,result.Item.SeriesName,result.Item.ProductionYear,premiereDate=result.Item.PremiereDate?.ToString("o"),premiereTicks=result.Item.PremiereDate?.Ticks.ToString(),premiereKind=result.Item.PremiereDate?.Kind.ToString()},people=result.People?.Select(person=>new{person.Name,type=person.Type.ToString(),person.Role,person.ProviderIds})};
static CancellationToken Token(JsonElement sample)=>sample.TryGetProperty("cancelled",out var value)&&value.GetBoolean()?new CancellationToken(true):CancellationToken.None;
static string Hash(byte[] bytes)=>Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
public class Stub:DispatchProxy{public Func<MethodInfo,object?[]?,object?> Handler=null!;protected override object? Invoke(MethodInfo? method,object?[]? values)=>Handler(method!,values);public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler)where T:class{var value=Create<T,Stub>();((Stub)(object)value).Handler=handler;return value;}public static object? Default(Type type)=>type==typeof(void)?null:type.IsValueType?Activator.CreateInstance(type):null;}
public class CaptureLogger<T>:ILogger<T>{public List<string> Errors=new();public IDisposable? BeginScope<TState>(TState state)where TState:notnull=>null;public bool IsEnabled(LogLevel level)=>true;public void Log<TState>(LogLevel level,EventId id,TState state,Exception? exception,Func<TState,Exception?,string> formatter){if(level>=LogLevel.Error)Errors.Add(exception?.GetType().Name??"no-exception");}}
