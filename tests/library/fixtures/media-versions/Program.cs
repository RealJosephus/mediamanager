using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Common.Configuration;
using Emby.Server.Implementations.IO;
using Microsoft.Extensions.Logging.Abstractions;

var options = new JsonSerializerOptions(JsonDefaults.Options) { PropertyNameCaseInsensitive = true };
var document = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var items = new Dictionary<Guid, BaseItem>();
var streams = new Dictionary<Guid, List<MediaStream>>();
var links = new List<(Guid Parent, Guid Child, int Type)>();
var fs = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, Stub.Make<IApplicationPaths>((m,a) => m.Name == "get_TempDirectory" ? Path.GetTempPath() : null), []);
BaseItem.FileSystem = fs;
Video.RecordingsManager = Stub.Make<MediaBrowser.Controller.LiveTv.IRecordingsManager>((m,a) => null);
BaseItem.LibraryManager = Stub.Make<ILibraryManager>((m,a) => m.Name switch {
    "GetItemById" => items.GetValueOrDefault((Guid)a![0]!),
    "GetLocalAlternateVersionIds" => links.Where(l => l.Parent == ((Video)a![0]!).Id && l.Type == 2).Select(l => l.Child).ToArray(),
    "GetLinkedAlternateVersions" => links.Where(l => l.Parent == ((Video)a![0]!).Id && l.Type == 3).Select(l => items.GetValueOrDefault(l.Child)).OfType<Video>().OrderBy(v => v.SortName).ToArray(),
    _ => null
});
BaseItem.ConfigurationManager = Stub.Make<MediaBrowser.Controller.Configuration.IServerConfigurationManager>((m,a) => m.Name == "get_Configuration" ? new ServerConfiguration() : null);
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((m,a) => m.Name switch {
    "GetMediaStreams" => streams.GetValueOrDefault((Guid)a![0]!) ?? [],
    "GetMediaAttachments" => new List<MediaAttachment>(),
    "GetPathProtocol" => string.IsNullOrEmpty((string?)a![0]) || fs.IsPathFile((string)a[0]!) ? MediaProtocol.File : MediaProtocol.Http,
    "SupportsDirectStream" => (MediaProtocol)a![1]! == MediaProtocol.File || (MediaProtocol)a[1]! == MediaProtocol.Http && !((string?)a[0] ?? "").Contains(".m3u", StringComparison.OrdinalIgnoreCase),
    _ => null
});
BaseItem.MediaSegmentManager = Stub.Make<IMediaSegmentManager>((m,a) => m.Name == "IsTypeSupported" ? true : m.Name == "HasSegments" ? false : null);

// URL providers only read Configuration. No plugin constructor or network work is invoked.
var musicPluginType = typeof(MediaBrowser.Providers.Plugins.MusicBrainz.Plugin);
var musicPlugin = RuntimeHelpers.GetUninitializedObject(musicPluginType);
musicPluginType.GetProperty("Instance")!.SetValue(null, musicPlugin);
var musicConfig = new MediaBrowser.Providers.Plugins.MusicBrainz.Configuration.PluginConfiguration();
musicPluginType.GetProperty("Configuration")!.SetValue(musicPlugin, musicConfig);
var providers = typeof(MediaBrowser.Providers.Plugins.Tmdb.TmdbExternalUrlProvider).Assembly.GetTypes()
    .Where(type => !type.IsAbstract && typeof(IExternalUrlProvider).IsAssignableFrom(type)).Select(type => (IExternalUrlProvider)Activator.CreateInstance(type)!).OrderBy(p => p.Name).ToArray();
var results = new List<object>();
foreach (var entry in document.GetProperty("cases").EnumerateArray()) {
    items.Clear(); streams.Clear(); links.Clear();
    foreach (var row in entry.GetProperty("items").EnumerateArray()) {
        var type = typeof(BaseItem).Assembly.GetTypes().First(type => type.Name == row.GetProperty("Type").GetString() && typeof(BaseItem).IsAssignableFrom(type));
        var item = (BaseItem)Activator.CreateInstance(type)!;
        foreach (var field in row.EnumerateObject()) {
            if (field.Name is "Type" or "MediaStreams") continue;
            var property = type.GetProperty(field.Name);
            if (property?.CanWrite == true) property.SetValue(item, field.Name == "ProviderIds"
                ? new Dictionary<string,string>(JsonSerializer.Deserialize<Dictionary<string,string>>(field.Value.GetRawText())!, StringComparer.OrdinalIgnoreCase)
                : JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, options));
        }
        items[item.Id] = item;
        if (row.TryGetProperty("MediaStreams", out var mediaStreams)) streams[item.Id] = JsonSerializer.Deserialize<List<MediaStream>>(mediaStreams.GetRawText(),options)!;
    }
    if(entry.TryGetProperty("links",out var linkRows)) foreach(var link in linkRows.EnumerateArray()) links.Add((Guid.Parse(link.GetProperty("ParentId").GetString()!),Guid.Parse(link.GetProperty("ChildId").GetString()!),link.GetProperty("ChildType").GetInt32()));
    var queried = items[Guid.Parse(entry.GetProperty("query").GetString()!)];
    musicConfig.Server = entry.TryGetProperty("musicBrainzServer",out var server) ? server.GetString()! : "https://musicbrainz.org";
    var urls = providers.SelectMany(p => p.GetExternalUrls(queried).Select(url => new {Name=p.Name,Url=url})).ToArray();
    var sources = queried is IHasMediaSources sourceItem ? sourceItem.GetMediaSources(false) : null;
    results.Add(new { name=entry.GetProperty("name").GetString(), urls, sources, count=queried is Video video ? (int?)video.MediaSourceCount : null });
}
var prefixMethod = typeof(BaseItem).GetMethod("GetCommonVersionPrefix",BindingFlags.Static|BindingFlags.NonPublic)!;
var prefixes = document.GetProperty("prefixes").EnumerateArray().Select(names => new { names=names, value=prefixMethod.Invoke(null,[names.EnumerateArray().Select(x=>x.GetString()!).ToArray()]) }).ToArray();
var folders = document.GetProperty("folders").EnumerateArray().Select(name=> new { name=name.GetString(), value=BaseItem.GetItemByNameFolderName(name.GetString()!) }).ToArray();
var floatBits = new List<int> { BitConverter.SingleToInt32Bits(29.970029830932617f), BitConverter.SingleToInt32Bits(23.976023f), 0, int.MinValue, 1, int.MaxValue-0x800000, 0x7f7fffff, 0x00800000 };
var random = new Random(1731);
for(int i=0;i<4096;i++) { var bits=(int)random.NextInt64(int.MinValue,int.MaxValue); if(float.IsFinite(BitConverter.Int32BitsToSingle(bits)))floatBits.Add(bits); }
var floats=floatBits.Select(bits=>new {bits,value=BitConverter.Int32BitsToSingle(bits)}).ToArray();
File.WriteAllText(args[1],JsonSerializer.Serialize(new { results,prefixes,folders,floats },options));
if(args.Length>2) {
    var upper=new Dictionary<string,string>();
    for(int code=0;code<=0xffff;code++) {var ch=(char)code;var mapped=char.ToUpperInvariant(ch);if(mapped!=ch)upper[ch.ToString()]=mapped.ToString();}
    File.WriteAllText(args[2],JsonSerializer.Serialize(upper));
}
public class Stub : DispatchProxy {
    public Func<MethodInfo,object?[]?,object?> Handler = null!;
    public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T:class {var proxy=Create<T,Stub>();((Stub)(object)proxy).Handler=handler;return proxy;}
    protected override object? Invoke(MethodInfo? method,object?[]? args) {var value=Handler(method!,args);return value ?? (method!.ReturnType.IsValueType ? Activator.CreateInstance(method.ReturnType):null);}
}
