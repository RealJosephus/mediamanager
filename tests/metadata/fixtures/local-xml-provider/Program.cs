// Validation only: actual pinned local XML parsers/providers over neutral files.
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.IO;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;
using MediaBrowser.LocalMetadata;
using MediaBrowser.LocalMetadata.Parsers;
using MediaBrowser.LocalMetadata.Providers;
using MediaBrowser.LocalMetadata.Savers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Providers;
using MediaBrowser.Providers.BoxSets;
using MediaBrowser.Providers.Playlists;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var stateRoot = Path.GetFullPath(args[2]);
Directory.CreateDirectory(stateRoot);
var options = new JsonSerializerOptions { WriteIndented = true, NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals };
options.Converters.Add(new JsonStringEnumConverter());
var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch
{
    "get_DataPath" => Path.Combine(stateRoot, "data"),
    "get_ProgramDataPath" => stateRoot,
    "get_InternalMetadataPath" => Path.Combine(stateRoot, "metadata"),
    _ => Stub.Default(method.ReturnType)
});
var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch
{
    "get_ApplicationPaths" => paths,
    "get_Configuration" => new ServerConfiguration(),
    _ => Stub.Default(method.ReturnType)
});
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
BaseItem.FileSystem = fileSystem;
BaseItem.ConfigurationManager = configuration;
BaseItem.Logger = NullLogger<BaseItem>.Instance;
var parserResults = new List<object>();
foreach (var sample in input.GetProperty("parserCases").EnumerateArray())
foreach (var type in new[] { "BoxSet", "Playlist" })
{
    var name = sample.GetProperty("name").GetString()!;
    var target = Path.Combine(stateRoot, "parser", name + ".xml");
    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
    if (sample.TryGetProperty("xml", out var xml)) File.WriteAllBytes(target, Bytes(sample, xml.GetString()!));
    var provider = Manager(sample);
    var cancelled = sample.TryGetProperty("cancelled", out var cancel) && cancel.GetBoolean();
    var seed = sample.TryGetProperty("seed", out var seedValue) && seedValue.GetBoolean();
    object? error = null;
    object projection;
    if (type == "Playlist")
    {
        var result = new MetadataResult<Playlist> { Item = Seed(new Playlist(), seed) };
        result.AddPerson(new PersonInfo { Name = "Old Person" });
        try { new PlaylistXmlParser(NullLogger<PlaylistXmlParser>.Instance, provider).Fetch(result, target, new CancellationToken(cancelled)); }
        catch (Exception failure) { error = failure.GetType().Name; }
        projection = Project(result.Item, result.People);
    }
    else
    {
        var result = new MetadataResult<BoxSet> { Item = Seed(new BoxSet(), seed) };
        result.AddPerson(new PersonInfo { Name = "Old Person" });
        try { new BoxSetXmlParser(NullLogger<BoxSetXmlParser>.Instance, provider).Fetch(result, target, new CancellationToken(cancelled)); }
        catch (Exception failure) { error = failure.GetType().Name; }
        projection = Project(result.Item, result.People);
    }
    parserResults.Add(new { name, type, error, result = projection });
}
var providerResults = new List<object>();
foreach (var sample in input.GetProperty("providerCases").EnumerateArray())
{
    var name = sample.GetProperty("name").GetString()!;
    var type = sample.GetProperty("type").GetString()!;
    var kind = sample.GetProperty("kind").GetString();
    var root = Path.Combine(stateRoot, "providers", name);
    Directory.CreateDirectory(root);
    var target = Path.Combine(root, sample.GetProperty("path").GetString()!);
    if (kind == "directory") Directory.CreateDirectory(target);
    else if (kind == "file") File.WriteAllText(target, "neutral playlist");
    var xmlPath = type == "Playlist" ? PlaylistXmlSaver.GetSavePath(target) : Path.Combine(target, "collection.xml");
    if (sample.TryGetProperty("xml", out var xml))
    {
        Directory.CreateDirectory(Path.GetDirectoryName(xmlPath)!);
        File.WriteAllBytes(xmlPath, Bytes(sample, xml.GetString()!));
        File.SetLastWriteTimeUtc(xmlPath, new DateTime(2026, 10, 10, 2, 3, 4, DateTimeKind.Utc));
    }
    if (sample.TryGetProperty("xmlDirectory", out var xmlDirectory) && xmlDirectory.GetBoolean()) Directory.CreateDirectory(xmlPath);
    var info = fileSystem.GetFileSystemInfo(xmlPath);
    var modified = info.Exists ? fileSystem.GetLastWriteTimeUtc(info) : DateTime.MinValue;
    var savedOffset = sample.TryGetProperty("savedOffsetTicks", out var offset) ? offset.GetInt64() : 0;
    var token = new CancellationToken(sample.TryGetProperty("cancelled", out var cancel) && cancel.GetBoolean());
    object? error = null, result = null;
    bool? changed = null;
    var directory = new DirectoryService(fileSystem);
    if (type == "Playlist")
    {
        var provider = new PlaylistXmlProvider(fileSystem, NullLogger<PlaylistXmlParser>.Instance, Manager(sample));
        var item = new Playlist { Path = target, DateLastSaved = modified.AddTicks(savedOffset) };
        try { changed = provider.HasChanged(item, directory); var value = await provider.GetMetadata(new ItemInfo(item), directory, token);
            result = new { value.HasMetadata, item = value.Item is null ? null : Project(value.Item, value.People), provider.Name, provider.Order }; }
        catch (Exception failure) { error = failure.GetType().Name; }
    }
    else
    {
        var provider = new BoxSetXmlProvider(fileSystem, NullLogger<BoxSetXmlParser>.Instance, Manager(sample));
        var item = new BoxSet { Path = target, DateLastSaved = modified.AddTicks(savedOffset) };
        try { changed = provider.HasChanged(item, directory); var value = await provider.GetMetadata(new ItemInfo(item), directory, token);
            result = new { value.HasMetadata, item = value.Item is null ? null : Project(value.Item, value.People), provider.Name, provider.Order }; }
        catch (Exception failure) { error = failure.GetType().Name; }
    }
    providerResults.Add(new { name, path = Path.GetRelativePath(root, xmlPath).Replace('\\', '/'), changed, error, result });
}
var mergeResults = new List<object>();
var library = Stub.Make<ILibraryManager>((method, _) => method.Name == "GetLibraryOptions" ? new LibraryOptions() : Stub.Default(method.ReturnType));
BaseItem.LibraryManager = library;
foreach (var sample in input.GetProperty("mergeCases").EnumerateArray())
{
    var source = new MetadataResult<BoxSet> { Item = new BoxSet { LinkedChildren = MergeLinks(sample.GetProperty("source")) } };
    var target = new MetadataResult<BoxSet> { Item = new BoxSet { LinkedChildren = MergeLinks(sample.GetProperty("target")),
        Path = sample.GetProperty("managed").GetBoolean() ? Path.Combine(stateRoot, "data", "Set") : "Z:\\External\\Set" } };
    var before = Project(target.Item, target.People);
    var service = new BoxSetMetadataService(configuration, NullLogger<BoxSetMetadataService>.Instance, null!, fileSystem, library, null!, null!);
    typeof(BoxSetMetadataService).GetMethod("MergeData", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(service,
        [source, target, Array.Empty<MetadataField>(), sample.GetProperty("replaceData").GetBoolean(), sample.GetProperty("mergeSettings").GetBoolean()]);
    mergeResults.Add(new { name = sample.GetProperty("name").GetString(), before, after = Project(target.Item, target.People) });
}
var pipelineResults = new List<object>();
foreach (var sample in input.GetProperty("pipelineCases").EnumerateArray())
{
    var type = sample.GetProperty("type").GetString()!;
    var targetPath = "Z:\\External\\LogicalPlaylist";
    if (type == "Playlist")
    {
        var source = new MetadataResult<Playlist> { Item = new Playlist { LinkedChildren = MergeLinks(sample.GetProperty("source")) } };
        var target = new MetadataResult<Playlist> { Item = new Playlist { Path = targetPath, LinkedChildren = MergeLinks(sample.GetProperty("target")) } };
        var temp = new MetadataResult<Playlist> { Item = new Playlist { Path = targetPath } };
        var service = new PlaylistMetadataService(configuration, NullLogger<PlaylistMetadataService>.Instance, null!, fileSystem, library, null!, null!);
        var merge = typeof(PlaylistMetadataService).GetMethod("MergeData", BindingFlags.Instance | BindingFlags.NonPublic)!;
        merge.Invoke(service, [source, temp, Array.Empty<MetadataField>(), false, true]);
        var afterLocal = ProjectLinks(temp.Item);
        merge.Invoke(service, [target, temp, Array.Empty<MetadataField>(), false, false]);
        var afterExisting = ProjectLinks(temp.Item);
        merge.Invoke(service, [temp, target, Array.Empty<MetadataField>(), sample.GetProperty("replaceData").GetBoolean(), true]);
        pipelineResults.Add(new { name = sample.GetProperty("name").GetString(), afterLocal, afterExisting, afterFinal = ProjectLinks(target.Item) });
    }
    else
    {
        var source = new MetadataResult<BoxSet> { Item = new BoxSet { LinkedChildren = MergeLinks(sample.GetProperty("source")) } };
        var target = new MetadataResult<BoxSet> { Item = new BoxSet { Path = targetPath, LinkedChildren = MergeLinks(sample.GetProperty("target")) } };
        var temp = new MetadataResult<BoxSet> { Item = new BoxSet { Path = targetPath } };
        var service = new BoxSetMetadataService(configuration, NullLogger<BoxSetMetadataService>.Instance, null!, fileSystem, library, null!, null!);
        var merge = typeof(BoxSetMetadataService).GetMethod("MergeData", BindingFlags.Instance | BindingFlags.NonPublic)!;
        merge.Invoke(service, [source, temp, Array.Empty<MetadataField>(), false, true]);
        var afterLocal = ProjectLinks(temp.Item);
        merge.Invoke(service, [target, temp, Array.Empty<MetadataField>(), false, false]);
        var afterExisting = ProjectLinks(temp.Item);
        merge.Invoke(service, [temp, target, Array.Empty<MetadataField>(), sample.GetProperty("replaceData").GetBoolean(), true]);
        pipelineResults.Add(new { name = sample.GetProperty("name").GetString(), afterLocal, afterExisting, afterFinal = ProjectLinks(target.Item) });
    }
}
var output = new { candidateVerified = false, inputSha256 = Hash(inputBytes), parserResults, providerResults, mergeResults, pipelineResults,
    assemblies = new[] { typeof(PlaylistXmlParser).Assembly, typeof(Playlist).Assembly, typeof(ManagedFileSystem).Assembly, typeof(BoxSetMetadataService).Assembly }
        .Distinct().Select(assembly => new { name = assembly.GetName().Name, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }) };
File.WriteAllText(args[1], JsonSerializer.Serialize(output, options), new UTF8Encoding(false));

static byte[] Bytes(JsonElement sample, string xml) => sample.TryGetProperty("bytes", out var bytes)
    ? Convert.FromBase64String(bytes.GetString()!) : Encoding.UTF8.GetBytes(xml);
static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
static IProviderManager Manager(JsonElement sample)
{
    var keys = sample.TryGetProperty("externalIds", out var ids) ? ids.EnumerateArray().Select(value => value.GetString()!).ToArray() : [];
    return Stub.Make<IProviderManager>((method, _) => method.Name == "GetExternalIdInfos"
        ? keys.Select(key => new ExternalIdInfo(key, key, null)).ToArray() : Stub.Default(method.ReturnType));
}
static T Seed<T>(T item, bool seed) where T : BaseItem
{
    if (!seed) return item;
    item.Name = "Old Name";
    item.Tags = ["Old Tag"];
    item.Genres = ["Old Genre"];
    item.Studios = ["Old Studio"];
    item.LockedFields = [MetadataField.Overview];
    ((Folder)(BaseItem)item).LinkedChildren = [new LinkedChild { ItemId = Guid.Parse("10000000-0000-0000-0000-000000000001") }];
    if (item is Playlist playlist) playlist.Shares = [new PlaylistUserPermissions(Guid.Parse("20000000-0000-0000-0000-000000000001"), true)];
    return item;
}
static object Project(BaseItem item, IReadOnlyList<PersonInfo>? people)
{
    var playlist = item as Playlist;
    return new {
        type = item.GetType().Name, item.Name, item.OriginalTitle, item.ForcedSortName, item.Overview,
        item.PreferredMetadataLanguage, item.PreferredMetadataCountryCode, item.OfficialRating, item.CustomRating,
        dateCreated = item.DateCreated.ToString("O"), premiereDate = item.PremiereDate?.ToString("O"), endDate = item.EndDate?.ToString("O"),
        item.ProductionYear, CriticRating = (double?)item.CriticRating, CommunityRating = (double?)item.CommunityRating, item.IsLocked, item.LockedFields,
        runtime = item.RunTimeTicks?.ToString(CultureInfo.InvariantCulture), item.Tagline,
        displayOrder = (item as IHasDisplayOrder)?.DisplayOrder, item.Genres, item.Tags, item.Studios, item.ProductionLocations,
        item.ProviderIds, trailers = item.RemoteTrailers.Select(value => value.Url),
        people = people?.Select(value => new { value.Name, value.Role, value.Type, value.SortOrder, value.ImageUrl, value.ProviderIds }),
#pragma warning disable CS0618
        links = ((Folder)item).LinkedChildren.Select(value => new { value.Type, value.ItemId, value.Path, value.LibraryItemId }),
#pragma warning restore CS0618
        ownerUserId = playlist?.OwnerUserId, openAccess = playlist?.OpenAccess, shares = playlist?.Shares,
        playlistMediaType = playlist?.PlaylistMediaType.ToString()
    };
}
static LinkedChild[] MergeLinks(JsonElement input) => input.EnumerateArray().Select(value => new LinkedChild {
    ItemId = value.TryGetProperty("id", out var id) ? Guid.Parse(id.GetString()!) : null,
#pragma warning disable CS0618
    Path = value.TryGetProperty("path", out var path) ? path.GetString() : null,
#pragma warning restore CS0618
    Type = LinkedChildType.Manual
}).ToArray();
#pragma warning disable CS0618
static object[] ProjectLinks(Folder item) => item.LinkedChildren.Select(value => (object)new { value.Type, value.ItemId, value.Path, value.LibraryItemId }).ToArray();
#pragma warning restore CS0618
public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    { var proxy = Create<T, Stub>(); ((Stub)(object)proxy).Handler = handler; return proxy; }
    public static object? Default(Type type) => type == typeof(void) || !type.IsValueType ? null : Activator.CreateInstance(type);
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Handler(method!, args);
}
