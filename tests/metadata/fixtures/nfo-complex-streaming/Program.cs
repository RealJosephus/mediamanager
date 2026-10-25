// Records actual Jellyfin XmlReader streaming and complex-subtree commit boundaries.
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Providers;
using MediaBrowser.XbmcMetadata.Parsers;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var inputDirectory = Path.Combine(Path.GetDirectoryName(args[1])!, "nfo-inputs");
Directory.CreateDirectory(inputDirectory);
var results = new List<object>();
var ordinal = 0;

foreach (var sample in input.EnumerateArray())
{
    var bytes = Encoding.UTF8.GetBytes(sample.GetProperty("text").GetString()!);
    var filename = Path.Combine(inputDirectory, $"{ordinal++:D3}.nfo");
    File.WriteAllBytes(filename, bytes);
    var configuration = DispatchProxy.Create<IConfigurationManager, ConfigurationProxy>();
    ((ConfigurationProxy)(object)configuration).Options = new XbmcMetadataOptions();
    var providers = DispatchProxy.Create<IProviderManager, ProviderProxy>();
    var users = DispatchProxy.Create<IUserManager, UserManagerProxy>();
    var userData = DispatchProxy.Create<IUserDataManager, UserDataProxy>();
    var directories = DispatchProxy.Create<IDirectoryService, DirectoryServiceProxy>();
    var run = Run(sample, filename, configuration, providers, users, userData, directories);
    results.Add(new
    {
        name = sample.GetProperty("name").GetString(),
        type = sample.GetProperty("type").GetString(),
        raw = new
        {
            bytes = bytes.Length,
            sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            base64 = Convert.ToBase64String(bytes)
        },
        run.exception,
        run.hasMetadata,
        run.item,
        run.people
    });
}

var output = JsonSerializer.Serialize(new
{
    schemaVersion = 1,
    candidateVerified = false,
    frozenJellyfinHead = "208c278b75abd897aefa1e1175126eac5e4dbfaa",
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual MovieNfoParser, SeasonNfoParser and SeriesNfoSeasonParser over exact UTF-8 temporary file bytes. This isolates XmlReader look-ahead, parser-specific subtree handling, complex subtree partial commits, namespace/name/attribute validation and malformed XML behavior.",
    uncovered = new[]
    {
        "every XML 1.0 grammar production and encoding combination",
        "local image filesystem behavior",
        "user-data persistence and cancellation",
        "episode multi-block merge behavior",
        "all NFO scalar fields and external-id providers"
    },
    results
}, json).ReplaceLineEndings("\n") + "\n";
File.WriteAllText(args[1], output, new UTF8Encoding(false));

static RunResult Run(JsonElement sample, string filename, IConfigurationManager configuration, IProviderManager providers,
    IUserManager users, IUserDataManager userData, IDirectoryService directories)
{
    var type = sample.GetProperty("type").GetString()!;
    BaseItem item = type switch
    {
        "Movie" => new Movie(),
        "Season" => new Season(),
        _ => throw new NotSupportedException(type)
    };
    if (sample.TryGetProperty("initialName", out var initialName)) item.Name = initialName.GetString();
    if (sample.TryGetProperty("indexNumber", out var indexNumber)) item.IndexNumber = indexNumber.GetInt32();
    if (type == "Season" && sample.TryGetProperty("seriesSeason", out var seriesSeason) && seriesSeason.GetBoolean())
    {
        return Fetch((Season)item,
            new SeriesNfoSeasonParser(NullLogger<SeriesNfoSeasonParser>.Instance, configuration, providers, users, userData, directories), filename);
    }

    return type switch
    {
        "Movie" => Fetch((Movie)item,
            new MovieNfoParser(NullLogger<MovieNfoParser>.Instance, configuration, providers, users, userData, directories), filename),
        "Season" => Fetch((Season)item,
            new SeasonNfoParser(NullLogger<SeasonNfoParser>.Instance, configuration, providers, users, userData, directories), filename),
        _ => throw new NotSupportedException(type)
    };
}

static RunResult Fetch<T>(T item, BaseNfoParser<T> parser, string filename) where T : BaseItem
{
    var result = new MetadataResult<T> { Item = item };
    string? exception = null;
    var hasMetadata = false;
    try
    {
        parser.Fetch(result, filename, CancellationToken.None);
        hasMetadata = true;
    }
    catch (Exception error)
    {
        exception = error.GetType().Name;
    }

    return new RunResult(exception, hasMetadata, Projection.Item(item),
        (result.People ?? []).Select(Projection.Person).ToArray());
}

public sealed record RunResult(string? exception, bool hasMetadata, object item, object[] people);

public static class Projection
{
    public static object Item(BaseItem item)
    {
        var video = item as Video;
        return new
        {
            runtimeType = item.GetType().Name,
            item.Name,
            item.Overview,
            item.CommunityRating,
            item.CriticRating,
            runTimeTicks = item.RunTimeTicks?.ToString(),
            providers = new SortedDictionary<string, string>(item.ProviderIds, StringComparer.Ordinal),
            aspectRatio = video?.AspectRatio,
            width = video?.Width,
            height = video?.Height,
            video3DFormat = video?.Video3DFormat?.ToString(),
            hasSubtitles = video?.HasSubtitles
        };
    }

    public static object Person(PersonInfo person) => new
    {
        person.Name,
        Type = person.Type.ToString(),
        person.Role,
        person.SortOrder,
        person.ImageUrl
    };
}

public class ConfigurationProxy : DispatchProxy
{
    public XbmcMetadataOptions Options = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetConfiguration" => Options,
        "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class ProviderProxy : DispatchProxy
{
    private readonly ExternalIdInfo[] _ids =
    [
        new("IMDb", "Imdb", ExternalIdMediaType.Movie),
        new("TMDb", "Tmdb", ExternalIdMediaType.Movie),
        new("TVDb", "Tvdb", ExternalIdMediaType.Series)
    ];

    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetExternalIdInfos" => _ids,
        "add_RefreshStarted" or "remove_RefreshStarted" or "add_RefreshCompleted" or "remove_RefreshCompleted"
            or "add_RefreshProgress" or "remove_RefreshProgress" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class UserManagerProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "add_OnUserUpdated" or "remove_OnUserUpdated" => null,
        "GetUserById" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class UserDataProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "add_UserDataSaved" or "remove_UserDataSaved" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class DirectoryServiceProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetFile" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
