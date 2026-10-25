using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.Library;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv;
using Jellyfin.LiveTv.Guide;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
var settings = new ServerConfiguration { EnableCaseSensitiveItemIds = true, MetadataCountryCode = "US" };
var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name == "get_ProgramDataPath" ? "/guide-program-isolated-state" : Stub.Default(method.ReturnType));
var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
    "get_Configuration" => settings, "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths, _ => Stub.Default(method.ReturnType)
});
var identityLibrary = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
typeof(LibraryManager).GetField("_configurationManager", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(identityLibrary, configuration);
BaseItem.ConfigurationManager = configuration;
BaseItem.Logger = NullLogger<BaseItem>.Instance;
BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, _) => method.Name switch {
    "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions { MetadataCountryCode = "US" },
    _ => Stub.Default(method.ReturnType)
});
int ratingLookups = 0;
BaseItem.LocalizationManager = Stub.Make<ILocalizationManager>((method, _) => {
    if (method.Name == "GetRatingScore") { ratingLookups++; return new ParentalRatingScore(12, 3); }
    return Stub.Default(method.ReturnType);
});
var dto = new LiveTvDtoService(null!, null!, NullLogger<LiveTvDtoService>.Instance, null!, identityLibrary);
var manager = new GuideManager(NullLogger<GuideManager>.Instance, configuration, null!, null!, identityLibrary, null!, null!, null!, null!, dto);
var getProgram = typeof(GuideManager).GetMethod("GetProgram", BindingFlags.Instance | BindingFlags.NonPublic)!;
void Populate(object target, JsonElement values) {
    foreach (var entry in values.EnumerateObject()) {
        var property = target.GetType().GetProperty(entry.Name)!;
        object? value;
        if ((entry.Name is "ProviderIds" or "SeriesProviderIds") && entry.Value.ValueKind != JsonValueKind.Null) {
            var dictionary = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in entry.Value.EnumerateObject()) dictionary[pair.Name] = pair.Value.ValueKind == JsonValueKind.Null ? null : pair.Value.GetString();
            value = dictionary;
        } else value = entry.Value.Deserialize(property.PropertyType, JsonDefaults.Options);
        property.SetValue(target, value);
    }
}
object Image(ItemImageInfo image) => new { image.Path, Type = image.Type.ToString(), DateModified = image.DateModified.Ticks.ToString(CultureInfo.InvariantCulture),
    image.Width, image.Height, image.BlurHash };
object Project(LiveTvProgram item, bool created) => new {
    NativeType = item.GetType().FullName, Id = item.Id.ToString("N"), item.Name, ParentId = item.ParentId.ToString("N"), ChannelId = item.ChannelId.ToString("N"),
    item.ShowId, Audio = item.Audio?.ToString(), item.CommunityRating, item.EpisodeTitle, item.ExternalId, item.ExternalSeriesId, item.SeriesName,
    item.Tags, item.Genres, item.Width, item.Height, item.IsMovie, item.IsRepeat, item.IsSeries, item.OfficialRating, item.Overview,
    RunTimeTicks = item.RunTimeTicks?.ToString(CultureInfo.InvariantCulture), item.ProviderIds,
    StartDate = item.StartDate.Ticks.ToString(CultureInfo.InvariantCulture), EndDate = item.EndDate?.Ticks.ToString(CultureInfo.InvariantCulture),
    item.ProductionYear, PremiereDate = item.PremiereDate?.Ticks.ToString(CultureInfo.InvariantCulture), item.IndexNumber, item.ParentIndexNumber,
    ImageInfos = item.ImageInfos.Select(Image).ToArray(), item.InheritedParentalRatingValue, item.InheritedParentalRatingSubValue,
    DateCreated = created ? "$CREATED" : item.DateCreated.Ticks.ToString(CultureInfo.InvariantCulture),
    DateModified = created ? "$MODIFIED" : item.DateModified.Ticks.ToString(CultureInfo.InvariantCulture),
    item.IsVirtualItem, item.IsLive, item.IsPremiere, item.IsNews, item.IsSports, item.IsKids
};
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var info = new ProgramInfo(); Populate(info, sample.GetProperty("info"));
    var initializedInfo = JsonSerializer.SerializeToElement(info, options);
    var id = dto.GetInternalProgramId(info.Id!);
    var channel = new LiveTvChannel { Id = Guid.Parse(input.GetProperty("channelId").GetString()!) };
    LiveTvProgram? existing = null;
    if (sample.TryGetProperty("existing", out var prior)) { existing = new LiveTvProgram { Id = id }; Populate(existing, prior); }
    if (sample.TryGetProperty("duplicateImageReference", out var duplicate) && duplicate.GetBoolean()) existing!.ImageInfos = [.. existing.ImageInfos, existing.ImageInfos[0]];
    var originalImages = existing?.ImageInfos.ToArray() ?? [];
    var originalProviders = existing?.ProviderIds;
    var all = new Dictionary<Guid, LiveTvProgram>(); if (existing is not null) all.Add(id, existing);
    ratingLookups = 0; string? error = null; LiveTvProgram? item = existing; bool? isNew = null, isUpdated = null;
    var before = DateTime.UtcNow;
    try {
        var result = ((LiveTvProgram Item, bool IsNew, bool IsUpdated))getProgram.Invoke(manager, [info, all, channel])!;
        item = result.Item; isNew = result.IsNew; isUpdated = result.IsUpdated;
    } catch (TargetInvocationException caught) { error = caught.InnerException!.GetType().Name; }
    var after = DateTime.UtcNow;
    if (isNew == true && (item!.DateCreated < before || item.DateCreated > after || item.DateModified < before || item.DateModified > after)) {
        throw new InvalidOperationException("New program clock values escaped the actual invocation interval.");
    }
    results.Add(new { name = sample.GetProperty("name").GetString(), initializedInfo, id = id.ToString("N"), error, isNew, isUpdated,
        item = item is null ? null : Project(item, isNew == true), infoProviders = info.ProviderIds, infoSeriesProviders = info.SeriesProviderIds,
        providerAlias = item is not null && ReferenceEquals(item.ProviderIds, info.ProviderIds),
        preservedOriginalProviders = item is not null && ReferenceEquals(item.ProviderIds, originalProviders),
        originalImages = originalImages.Select(image => new { image = Image(image), indexInItem = item is null ? -1 : Array.IndexOf(item.ImageInfos, image) }).ToArray(),
        ratingLookups, existingDictionaryCount = all.Count, existingIdentity = existing is not null && ReferenceEquals(item, existing),
        genresCopied = item is not null && info.Genres is not null && !ReferenceEquals(item.Genres, info.Genres),
        clock = new { before = before.ToString("O"), after = after.ToString("O"), verified = isNew == true }
    });
}
var channelResults = new List<object>();
var getChannel = typeof(GuideManager).GetMethod("GetChannel", BindingFlags.Instance | BindingFlags.NonPublic)!;
foreach (var sample in input.GetProperty("channelCases").EnumerateArray()) {
    var info = new ChannelInfo(); Populate(info, sample.GetProperty("info"));
    var initializedInfo = JsonSerializer.SerializeToElement(info, options);
    var serviceName = sample.GetProperty("serviceName").GetString()!;
    var id = dto.GetInternalChannelId(serviceName, info.Id);
    var parent = new Folder { Id = Guid.Parse(input.GetProperty("parentId").GetString()!) };
    BaseItem? existing = null;
    if (sample.TryGetProperty("existing", out var prior)) {
        existing = sample.TryGetProperty("wrongType", out var wrongType) && wrongType.GetBoolean() ? new Video() : new LiveTvChannel();
        existing.Id = id; Populate(existing, prior);
    }
    var originalImages = existing?.ImageInfos.ToArray() ?? [];
    var calls = new List<object>(); int fileDateLookups = 0;
    var localDate = new DateTime(2024, 6, 1, 1, 2, 3, DateTimeKind.Utc);
    BaseItem.FileSystem = Stub.Make<IFileSystem>((method, values) => {
        if (method.Name == "GetFileInfo") {
            calls.Add(new { action = "file-info", value = values![0] });
            if (sample.TryGetProperty("fileFailure", out var fail) && fail.GetBoolean()) throw new IOException("Controlled channel image observation failure.");
            return new FileSystemMetadata { FullName = "/resolved" + values![0], LastWriteTimeUtc = localDate };
        }
        if (method.Name == "GetLastWriteTimeUtc") { fileDateLookups++; return localDate; }
        return Stub.Default(method.ReturnType);
    });
    var library = Stub.Make<ILibraryManager>((method, values) => {
        if (method.Name == "GetItemById") return existing;
        if (method.Name == "CreateItem") calls.Add(new { action = "create", value = (string?)null });
        if (method.Name == "UpdateItemAsync") { calls.Add(new { action = "update", value = values![2]!.ToString() }); return Task.CompletedTask; }
        return Stub.Default(method.ReturnType);
    });
    var channelManager = new GuideManager(NullLogger<GuideManager>.Instance, configuration, BaseItem.FileSystem, null!, library, null!, null!, null!, null!, dto);
    var allocated = existing is not LiveTvChannel;
    LiveTvChannel? item = existing as LiveTvChannel; string? error = null;
    var before = DateTime.UtcNow;
    try { item = await (Task<LiveTvChannel>)getChannel.Invoke(channelManager, [info, serviceName, parent, CancellationToken.None])!; }
    catch (TargetInvocationException caught) { error = caught.InnerException!.GetType().Name; }
    catch (Exception caught) { error = caught.GetType().Name; }
    var after = DateTime.UtcNow;
    if (error is null && allocated && (item!.DateCreated < before || item.DateCreated > after)) throw new InvalidOperationException("Channel creation clock escaped invocation.");
    channelResults.Add(new { name = sample.GetProperty("name").GetString(), initializedInfo, id = id.ToString("N"), error,
        item = item is null ? null : new { NativeType = item.GetType().FullName, Id = item.Id.ToString("N"), item.Name,
            ParentId = item.ParentId.ToString("N"), item.ExternalId, item.Number, ChannelType = item.ChannelType.ToString(), item.ServiceName, item.ProviderIds,
            item.Tags, ImageInfos = item.ImageInfos.Select(Image).ToArray(), DateCreated = allocated ? "$CREATED" : item.DateCreated.Ticks.ToString(CultureInfo.InvariantCulture),
            DateModified = item.DateModified.Ticks.ToString(CultureInfo.InvariantCulture), item.IsKids },
        tagAlias = item is not null && ReferenceEquals(item.Tags, info.Tags), existingIdentity = existing is not null && ReferenceEquals(item, existing),
        originalImages = originalImages.Select(image => new { image = Image(image), indexInItem = item is null ? -1 : Array.IndexOf(item.ImageInfos, image) }).ToArray(),
        calls = calls.ToArray(), fileDateLookups, allocated, clock = new { before = before.ToString("O"), after = after.ToString("O"), verified = error is null && allocated }
    });
}
var assemblies = new[] { typeof(GuideManager).Assembly, typeof(LiveTvDtoService).Assembly, typeof(LibraryManager).Assembly, typeof(ProgramInfo).Assembly }.Distinct()
    .Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualPrivateGetProgram = true, actualLiveTvDtoService = true, actualLibraryIdentity = true,
    actualNativeEntities = true, actualMetadataChanged = true, controlledRatingLookup = true, controlledLibraryNavigation = true,
    actualPrivateGetChannel = true, controlledChannelPersistence = true, controlledChannelImageFileInfo = true,
    databaseOwnersOpened = false, executorsStarted = false, inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), assemblies, results, channelResults }, options));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
