// Records actual Jellyfin fanart/thumb and Movie set streaming commit boundaries.
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
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
    var movie = new Movie();
    if (sample.TryGetProperty("initialName", out var initialName)) movie.Name = initialName.GetString();
    if (sample.TryGetProperty("initialCollectionName", out var initialCollectionName)) movie.CollectionName = initialCollectionName.GetString();
    var result = new MetadataResult<Video> { Item = movie };
    string? exception = null;
    var hasMetadata = false;
    try
    {
        new MovieNfoParser(NullLogger<MovieNfoParser>.Instance, configuration, providers, users, userData, directories)
            .Fetch(result, filename, CancellationToken.None);
        hasMetadata = true;
    }
    catch (Exception error)
    {
        exception = error.GetType().Name;
    }

    results.Add(new
    {
        name = sample.GetProperty("name").GetString(),
        raw = new
        {
            bytes = bytes.Length,
            sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            base64 = Convert.ToBase64String(bytes)
        },
        exception,
        hasMetadata,
        item = new
        {
            movie.Name,
            collectionName = movie.CollectionName,
            providers = new SortedDictionary<string, string>(movie.ProviderIds, StringComparer.Ordinal)
        },
        remoteImages = result.RemoteImages.Select(image => new { url = image.Url, type = image.Type.ToString() }).ToArray(),
        localImages = result.Images.Select(image => new { type = image.Type.ToString() }).ToArray()
    });
}

var output = JsonSerializer.Serialize(new
{
    schemaVersion = 1,
    candidateVerified = false,
    frozenJellyfinHead = "208c278b75abd897aefa1e1175126eac5e4dbfaa",
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual MovieNfoParser over exact UTF-8 temporary file bytes. This independently isolates flat thumb look-ahead, fanart ReadSubtree/ReadToDescendant behavior, Movie set ReadInnerXml/reparse behavior, and malformed or truncated partial commits.",
    uncovered = new[]
    {
        "local image filesystem success and failure behavior",
        "all URI schemes and System.Uri normalization cases",
        "every XML 1.0 grammar production and encoding combination",
        "non-Movie parser types, Episode multi-block parsing and user-data persistence",
        "all NFO scalar, date and external-id provider combinations"
    },
    results
}, json).ReplaceLineEndings("\n") + "\n";
File.WriteAllText(args[1], output, new UTF8Encoding(false));

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
