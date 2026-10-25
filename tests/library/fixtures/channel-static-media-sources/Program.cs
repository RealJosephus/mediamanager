using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.Dto;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Jellyfin.Data;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv.Channels;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Channels;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
var outputOptions = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
var root = Path.GetFullPath(args[2]); Directory.CreateDirectory(root);
var status = typeof(ExceptionMiddleware).GetMethod("GetStatusCode", BindingFlags.Static | BindingFlags.NonPublic)!;
var sourceFields = input.GetProperty("sourceFields").EnumerateArray().Select(value => value.GetString()!).ToArray();
var streamFields = input.GetProperty("streamFields").EnumerateArray().Select(value => value.GetString()!).ToArray();
object? Project(MediaSourceInfo? source) {
    if (source is null) return null;
    var fields = sourceFields.ToDictionary(name => name, name => typeof(MediaSourceInfo).GetProperty(name)!.GetValue(source));
    fields["DefaultAudioIndexSource"] = (int)source.DefaultAudioIndexSource;
    fields["MediaStreams"] = source.MediaStreams?.Select(stream => stream is null ? null : streamFields.ToDictionary(name => name,
        name => typeof(MediaStream).GetProperty(name)!.GetValue(stream))).ToArray();
    fields["MediaAttachments"] = source.MediaAttachments;
    return fields;
}
Exception Unwrap(Exception error) => error is TargetInvocationException { InnerException: not null } target ? target.InnerException! : error;
object Failure(Exception error) { error = Unwrap(error); return new { type = error.GetType().Name, error.Message, status = (int)status.Invoke(null, [error])!, error.StackTrace }; }
object Observe(Func<object?> action) { try { return new { value = action() }; } catch (Exception error) { return new { failure = Failure(error) }; } }
void Set(object target, string name, object value) => target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
var activeMetadataPath = root;
var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
    "get_InternalMetadataPath" => activeMetadataPath, "get_ProgramDataPath" => root, "get_DataPath" => Path.Combine(root, "data"),
    _ => Stub.Default(method.ReturnType)
});
var settings = new ServerConfiguration();
var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
    "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths, "get_Configuration" => settings, _ => Stub.Default(method.ReturnType)
});
var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name switch {
    "get_SystemId" => "channel-static-component", "ExpandVirtualPath" or "ReverseVirtualPath" => values![0], _ => Stub.Default(method.ReturnType)
});
var localization = Stub.Make<ILocalizationManager>((method, values) => method.Name == "FindLanguageInfo" ? (string)values![0]! switch {
    "eng" or "en" => new CultureDto("English", "English", "en", ["eng"]), "zho" or "zh" => new CultureDto("Chinese", "Chinese", "zh", ["zho", "chi"]), _ => null
} : Stub.Default(method.ReturnType));
BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance; BaseItem.LocalizationManager = localization;
BaseItem.MediaSegmentManager = Stub.Make<IMediaSegmentManager>((method, _) => method.Name == "IsTypeSupported" ? false : throw new InvalidOperationException("Segments cannot execute."));
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var sampleRoot = Path.Combine(root, results.Count.ToString(CultureInfo.InvariantCulture)); activeMetadataPath = Path.Combine(sampleRoot, "metadata");
    Directory.CreateDirectory(sampleRoot);
    var item = new Video { Id = Guid.Parse(input.GetProperty("itemId").GetString()!), Name = "Retained channel video", Path = Path.Combine(sampleRoot, "original.mkv"),
        ChannelId = Guid.Parse(input.GetProperty("channelId").GetString()!), RunTimeTicks = 60000000000L, DateModified = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc) };
    var channel = new Channel { Id = item.ChannelId, Name = "Retained provider" };
    var alternate = new Video { Id = Guid.Parse(input.GetProperty("alternateId").GetString()!), Name = "Alternate", Path = Path.Combine(sampleRoot, "alternate.mkv"),
        PrimaryVersionId = item.Id, ChannelId = item.ChannelId, RunTimeTicks = item.RunTimeTicks };
    var visible = new Video { Id = Guid.Parse(input.GetProperty("visibleId").GetString()!), Name = "Outside loaded graph", Path = Path.Combine(sampleRoot, "visible.mkv") };
    var blocked = new Video { Id = Guid.Parse(input.GetProperty("blockedId").GetString()!), Name = "Blocked", Path = Path.Combine(sampleRoot, "blocked.mkv"), Tags = ["blocked"] };
    var entities = new Dictionary<Guid, BaseItem> { [item.Id] = item, [channel.Id] = channel, [alternate.Id] = alternate, [visible.Id] = visible, [blocked.Id] = blocked };
    if (sample.TryGetProperty("bulkIds", out var bulkIds)) foreach (var id in bulkIds.EnumerateArray()) {
        var candidate = new Video { Id = Guid.Parse(id.GetString()!), Name = "Bounded source", Path = Path.Combine(sampleRoot, id.GetString()! + ".mkv") }; entities.Add(candidate.Id, candidate);
    }
    bool Flag(string name) => sample.TryGetProperty(name, out var value) && value.GetBoolean();
    if (Flag("linked")) item.LinkedAlternateVersions = [new LinkedChild { ItemId = alternate.Id }];
    var queried = Flag("queryAlternate") ? alternate : item;
    var calls = new List<object>();
    var library = Stub.Make<ILibraryManager>((method, values) => {
        if (method.Name == "GetItemById") {
            var id = (Guid)values![0]!; calls.Add(new { method = method.Name, id, user = values.LastOrDefault() is User });
            if (id == Guid.Empty) throw new ArgumentException("Guid can't be empty", "id");
            var candidate = entities.GetValueOrDefault(id);
            return candidate is not null && values.LastOrDefault() is User user && !candidate.IsVisibleStandalone(user) ? null : candidate;
        }
        return method.Name switch {
            "GetLinkedAlternateVersions" => Flag("linked") && ((Video)values![0]!).Id == item.Id ? new Video[] { alternate } : Array.Empty<Video>(),
            "GetLocalAlternateVersionIds" => Array.Empty<Guid>(), "GetCollectionFolders" => new List<Folder>(),
            "GetPathAfterNetworkSubstitution" => values![0],
            "GetLibraryOptions" => new LibraryOptions(), _ => throw new InvalidOperationException("Unexpected library dependency: " + method.Name)
        };
    });
    BaseItem.LibraryManager = library;
    var channelManager = (ChannelManager)RuntimeHelpers.GetUninitializedObject(typeof(ChannelManager));
    Set(channelManager, "_jsonOptions", JsonDefaults.Options); Set(channelManager, "_libraryManager", library);
    Set(channelManager, "<Channels>k__BackingField", Array.Empty<IChannel>()); BaseItem.ChannelManager = channelManager;
    var data = entities.Keys.ToDictionary(id => id, id => new UserItemData { Key = id.ToString("D") });
    if (sample.TryGetProperty("userData", out var suppliedData)) {
        data[queried.Id].AudioStreamIndex = suppliedData.GetProperty("AudioStreamIndex").GetInt32(); data[queried.Id].SubtitleStreamIndex = suppliedData.GetProperty("SubtitleStreamIndex").GetInt32();
    }
    void Resume(Guid id) { data[id].PlaybackPositionTicks = 6000000000L; data[id].LastPlayedDate = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc); }
    if (Flag("alternateResume")) Resume(alternate.Id); if (Flag("primaryResume")) Resume(item.Id); if (Flag("externalResume")) Resume(visible.Id);
    var userData = Stub.Make<IUserDataManager>((method, values) => method.Name switch {
        "GetUserData" => data[((BaseItem)values![1]!).Id],
        "GetUserDataBatch" => ((IReadOnlyList<BaseItem>)values![0]!).ToDictionary(value => value.Id, value => data[value.Id]),
        _ => throw new InvalidOperationException("User data cannot be written: " + method.Name)
    });
    var pathFileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var fileSystem = Stub.Make<IFileSystem>((method, values) => method.Name == "IsPathFile" ? pathFileSystem.IsPathFile((string)values![0]!)
        : throw new InvalidOperationException("Source bytes cannot be opened."));
    BaseItem.FileSystem = fileSystem;
    var streams = Stub.Make<IMediaStreamRepository>((method, _) => method.Name == "GetMediaStreams" ? Array.Empty<MediaStream>() : throw new InvalidOperationException("Streams cannot be written."));
    var attachments = Stub.Make<IMediaAttachmentRepository>((method, _) => method.Name == "GetMediaAttachments" ? Array.Empty<MediaAttachment>() : throw new InvalidOperationException("Attachments cannot be written."));
    using var manager = new MediaSourceManager(appHost, null!, paths, localization, null!, library, NullLogger<MediaSourceManager>.Instance, fileSystem,
        userData, null!, null!, streams, attachments); manager.AddParts([]); BaseItem.MediaSourceManager = manager;
    var recordings = Stub.Make<IRecordingsManager>((method, _) => method.Name == "GetActiveRecordingInfo" ? null : throw new InvalidOperationException("Recording is forbidden."));
    Video.RecordingsManager = recordings;
    var dtoService = new DtoService(NullLogger<DtoService>.Instance, library, userData, null!, null!, recordings, appHost, manager, null!, null!, null!);
    User? user = null;
    if (sample.TryGetProperty("user", out var userInput)) {
        user = new User("channel-static", "controlled", "controlled") { Id = Guid.Parse(input.GetProperty("userId").GetString()!) };
        foreach (var permission in userInput.GetProperty("policy").EnumerateObject()) {
            if (permission.Value.ValueKind is JsonValueKind.True or JsonValueKind.False) user.Permissions.Add(new Permission(Enum.Parse<PermissionKind>(permission.Name), permission.Value.GetBoolean()));
            else user.SetPreference(Enum.Parse<PreferenceKind>(permission.Name), permission.Value.EnumerateArray().Select(value => value.GetString()!).ToArray());
        }
        foreach (var property in userInput.GetProperty("configuration").EnumerateObject()) {
            var target = typeof(User).GetProperty(property.Name)!; target.SetValue(user, property.Value.Deserialize(target.PropertyType, JsonDefaults.Options));
        }
    }
    var cachePath = Path.Combine(queried.GetInternalMetadataPath(), "channelmediasourceinfos.json"); Directory.CreateDirectory(Path.GetDirectoryName(cachePath)!);
    var storage = sample.GetProperty("storage").GetString();
    if (storage == "directory") Directory.CreateDirectory(cachePath);
    else if (storage == "file") File.WriteAllText(cachePath, sample.GetProperty("raw").GetString());
    string? CacheSha() => File.Exists(cachePath) ? Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(cachePath))) : null;
    var before = CacheSha();
    var direct = Observe(() => channelManager.GetStaticMediaSources(queried, CancellationToken.None).Select(Project).ToArray());
    var baseSources = Observe(() => queried.GetMediaSources(true).Select(Project).ToArray());
    var staticSources = Observe(() => manager.GetStaticMediaSources(queried, true, user).Select(Project).ToArray());
    var playbackSources = Observe(() => manager.GetPlaybackMediaSources(queried, user, false, false, CancellationToken.None).GetAwaiter().GetResult().Select(Project).ToArray());
    var options = new DtoOptions { Fields = sample.TryGetProperty("fields", out var fields) ? fields.EnumerateArray().Select(value => Enum.Parse<ItemFields>(value.GetString()!)).ToArray()
        : [ItemFields.MediaSources, ItemFields.MediaStreams, ItemFields.MediaSourceCount, ItemFields.EnableMediaSourceDisplay], EnableImages = false, EnableUserData = false };
    var dto = Observe(() => { var value = dtoService.GetBaseItemDto(queried, options, user); return new { value.SourceType,
        MediaSources = value.MediaSources?.Select(Project).ToArray(),
        MediaStreams = value.MediaStreams?.Select(stream => streamFields.ToDictionary(name => name, name => typeof(MediaStream).GetProperty(name)!.GetValue(stream))).ToArray(),
        value.MediaSourceCount, value.ChannelName, value.EnableMediaSourceDisplay }; });
    var rows = entities.Values.Select(value => BaseItemMapper.Map(value, appHost)).ToArray();
    results.Add(new { name = sample.GetProperty("name").GetString(), root = sampleRoot, metadataPath = activeMetadataPath, cachePath, cacheSha256 = before,
        cacheSha256After = CacheSha(), itemId = queried.Id.ToString("N"), rows, direct, baseSources, staticSources, playbackSources, dto,
        versionCount = queried.MediaSourceCount, calls, userData = data.Select(pair => new { itemId = pair.Key, value = pair.Value }) });
}
var normalization = new List<object>();
activeMetadataPath = Path.Combine(root, "path-controls");
var pathCases = new BaseItem[] { new Channel { Id = Guid.Parse(input.GetProperty("channelId").GetString()!), ChannelId = Guid.Parse(input.GetProperty("visibleId").GetString()!) },
    new Video { Id = Guid.Parse(input.GetProperty("itemId").GetString()!), ChannelId = Guid.Parse(input.GetProperty("channelId").GetString()!) },
    new Video { Id = Guid.Parse(input.GetProperty("itemId").GetString()!) } }.Select(item => new { nativeType = item.GetType().FullName,
        id = item.Id.ToString("N"), channelId = item.ChannelId.ToString("N"), metadataPath = activeMetadataPath,
        expectedPath = Path.Combine(item.GetInternalMetadataPath(), "channelmediasourceinfos.json") }).ToArray();
var dtoOnlyLibrary = Stub.Make<ILibraryManager>((method, values) => {
    if (method.Name != "GetItemById") throw new InvalidOperationException("Unexpected DTO-only dependency: " + method.Name);
    var id = (Guid)values![0]!; if (id == Guid.Empty) throw new ArgumentException("Guid can't be empty", "id");
    return id == Guid.Parse(input.GetProperty("visibleId").GetString()!) ? new Folder { Id = id, Name = "Outside loaded graph" } : null;
});
var dtoOnlyRecordings = Stub.Make<IRecordingsManager>((method, _) => method.Name == "GetActiveRecordingInfo" ? null : throw new InvalidOperationException("Recording is forbidden."));
var dtoOnly = new DtoService(NullLogger<DtoService>.Instance, dtoOnlyLibrary, null!, null!, null!, dtoOnlyRecordings, appHost, null!, null!, null!, null!);
var dtoCases = new List<object>();
foreach (var item in new BaseItem[] { new Channel(), new Video(), new Video { ChannelId = Guid.Parse(input.GetProperty("missingId").GetString()!) },
    new Video { ChannelId = Guid.Parse(input.GetProperty("visibleId").GetString()!) } }) {
    item.Id = Guid.Parse(input.GetProperty("itemId").GetString()!); item.Name = "Unselected display";
    var result = Observe(() => { var value = dtoOnly.GetBaseItemDto(item, new DtoOptions(false) { EnableImages = false, EnableUserData = false });
        return new { value.SourceType, value.ChannelName, value.EnableMediaSourceDisplay }; });
    dtoCases.Add(new { nativeType = item.GetType().FullName, channelId = item.ChannelId.ToString("N"), result });
}
var normalize = typeof(ChannelManager).GetMethod("NormalizeMediaSources", BindingFlags.Static | BindingFlags.NonPublic)!;
foreach (var sample in input.GetProperty("normalizeCases").EnumerateArray()) {
    var sources = sample.Deserialize<MediaSourceInfo[]>(JsonDefaults.Options)!;
    var item = new Video { Id = Guid.Parse(input.GetProperty("itemId").GetString()!), RunTimeTicks = 60000000000L };
    var result = Observe(() => ((IReadOnlyList<MediaSourceInfo>)normalize.Invoke(null, [item, sources])!).Select(Project).ToArray());
    normalization.Add(new { result, after = sources.Select(Project).ToArray() });
}
var assemblies = new[] { typeof(ChannelManager).Assembly, typeof(MediaSourceManager).Assembly, typeof(Video).Assembly, typeof(MediaSourceInfo).Assembly, typeof(BaseItemMapper).Assembly }
    .Distinct().Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), actualChannelManagerSavedReader = true,
    actualBaseItemMediaSources = true, actualMediaSourceManager = true, actualDtoService = true, actualTypedMapper = true,
    nativeLibraryAndUserDataLookupsControlled = true, nativeDatabaseOpened = false, originalMediaOpened = false, recordingOrTranscodingStarted = false,
    results, normalization, pathCases, dtoCases, assemblies }, outputOptions));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
