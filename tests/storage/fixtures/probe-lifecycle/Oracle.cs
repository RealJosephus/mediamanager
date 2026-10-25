using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Naming.Common;
using Jellyfin.Extensions.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Providers.MediaInfo;
using Microsoft.Extensions.Logging.Abstractions;

if (args[0] == "select") { SelectionOracle.Run(args[1]); return; }
if (args[0] == "read-db") { NativeReader.Run(args[1], args[2]); return; }
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
var files = DispatchProxy.Create<IFileSystem, FixtureProxy>();
var directory = DispatchProxy.Create<IDirectoryService, FixtureProxy>();
BaseItem.MediaSourceManager = DispatchProxy.Create<IMediaSourceManager, FixtureProxy>();
BaseItem.FileSystem = files;
var local = DispatchProxy.Create<ILocalizationManager, FixtureProxy>();
var encoder = DispatchProxy.Create<IMediaEncoder, FixtureProxy>();
var lyrics = new LyricResolver(NullLogger<LyricResolver>.Instance, local, encoder, files, new NamingOptions());
var probe = (ProbeProvider)RuntimeHelpers.GetUninitializedObject(typeof(ProbeProvider));
void Field(string name, object value) => typeof(ProbeProvider).GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(probe, value);
Field("_logger", NullLogger<ProbeProvider>.Instance);
Field("_subtitleResolver", new SubtitleResolver(NullLogger<SubtitleResolver>.Instance, local, encoder, files, new NamingOptions()));
Field("_audioResolver", new AudioResolver(NullLogger<AudioResolver>.Instance, local, encoder, files, new NamingOptions()));
Field("_lyricResolver", lyrics);
Field("_cachedTask", Task.FromResult(ItemUpdateType.None));
var output = new List<object>();
foreach (var sample in JsonDocument.Parse(File.ReadAllText(args[0])).RootElement.EnumerateArray())
{
    FixtureProxy.Input = sample;
    var type = sample.GetProperty("item").GetProperty("Type").GetString();
    BaseItem item = (BaseItem)JsonSerializer.Deserialize(sample.GetProperty("item").GetRawText(), type == "Audio" ? typeof(FixtureAudio) : type == "AudioBook" ? typeof(FixtureBook) : typeof(FixtureMovie), options)!;
    // BaseItem persistence columns are JsonIgnore; populate actual CLR properties,
    // just as BaseItemMapper does, instead of pretending JSON Data stores them.
    foreach (var column in sample.GetProperty("item").EnumerateObject())
    {
        var property = item.GetType().GetProperty(column.Name);
        if (property?.CanWrite == true) property.SetValue(item, JsonSerializer.Deserialize(column.Value.GetRawText(), property.PropertyType, options));
    }
    if (sample.GetProperty("item").TryGetProperty("SourceType", out var source) && source.GetString() == "Channel") item.ChannelId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    bool changed = probe.HasChanged(item, directory);
    var missing = (bool)typeof(ProbeProvider).GetMethod("IsMissingMediaInfo", BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, [item])!;
    IReadOnlyList<MediaStream>? streams = item is Audio audio && item.SupportsLocalMetadata ? lyrics.GetExternalStreams(audio, 3, directory, false) : null;
    string gate;
    // The null prober is an explicit boundary: native FetchVideoInfo/FetchAudioInfo
    // has passed all early returns when it reaches that dependency.
    try
    {
        var refresh = new MetadataRefreshOptions(directory) { EnableRemoteContentProbe = sample.TryGetProperty("remote", out var remote) && remote.GetBoolean() };
        var result = item is Video video ? await probe.FetchVideoInfo(video, refresh, CancellationToken.None) : await probe.FetchAudioInfo((Audio)item, refresh, CancellationToken.None);
        gate = result.ToString();
    }
    catch (NullReferenceException) { gate = "ProberBoundary"; }
    output.Add(new { input = sample, expected = new { changed, missing, gate, lyricStreams = streams?.Select(stream => new { stream.Type, stream.Path, stream.Language, stream.Index, stream.IsExternal }) } });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(output, new JsonSerializerOptions(options) { WriteIndented = true }));

public class FixtureMovie : Movie
{
    public override string GetInternalMetadataPath() => @"Z:\metadata";
    protected override bool IsActiveRecording() => false;
}
public class FixtureAudio : Audio { public override string GetInternalMetadataPath() => @"Z:\metadata"; }
public class FixtureBook : AudioBook { public override string GetInternalMetadataPath() => @"Z:\metadata"; }
public class FixtureProxy : DispatchProxy
{
    public static JsonElement Input;
    protected override object? Invoke(MethodInfo? method, object?[]? values)
    {
        var name = method!.Name;
        if (name == "GetPathProtocol") return ((string)values![0]!).StartsWith("https:") ? MediaProtocol.Http : MediaProtocol.File;
        if (name == "DirectoryExists") return ((string)values![0]!) == @"Z:\metadata" ? Input.TryGetProperty("internalFiles", out _) : !Input.TryGetProperty("missingDirectory", out var absent) || !absent.GetBoolean();
        if (name == "GetFilePaths") return (Input.TryGetProperty(((string)values![0]!) == @"Z:\metadata" ? "internalFiles" : "files", out var paths) ? paths.EnumerateArray().Select(value => value.GetString()!).ToArray() : Array.Empty<string>());
        if (name == "GetFile") return Input.TryGetProperty("modified", out var modified) && modified.ValueKind != JsonValueKind.Null ? new FileSystemMetadata { FullName = (string)values![0]!, LastWriteTimeUtc = modified.GetDateTime() } : null;
        if (name == "FindLanguageInfo") return values![0]?.ToString() is "en" or "eng" ? new CultureDto("English", "English", "en", ["eng"]) : null;
        return method.ReturnType.IsValueType ? Activator.CreateInstance(method.ReturnType) : null;
    }
}
