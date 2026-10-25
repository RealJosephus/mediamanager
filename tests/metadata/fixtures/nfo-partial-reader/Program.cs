// Records the current native NFO reader's partial-commit and error boundaries.
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
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
    var bytes = InputBytes(sample);
    var filename = Path.Combine(inputDirectory, $"{ordinal++:D3}.nfo");
    File.WriteAllBytes(filename, bytes);

    var calls = new List<object>();
    using var cancellation = new CancellationTokenSource();
    var configuration = DispatchProxy.Create<IConfigurationManager, ConfigurationProxy>();
    ((ConfigurationProxy)(object)configuration).Options = new XbmcMetadataOptions
    {
        UserId = "10000000-0000-0000-0000-000000000001"
    };
    var providers = DispatchProxy.Create<IProviderManager, ProviderProxy>();
    var users = DispatchProxy.Create<IUserManager, UserManagerProxy>();
    ((UserManagerProxy)(object)users).Calls = calls;
    var userData = DispatchProxy.Create<IUserDataManager, UserDataProxy>();
    var userDataControl = (UserDataProxy)(object)userData;
    userDataControl.Calls = calls;
    userDataControl.Cancellation = cancellation;
    userDataControl.CancelAfterSave = sample.TryGetProperty("cancelAfterSave", out var cancelAfter) ? cancelAfter.GetInt32() : null;
    userDataControl.FailSaveAt = sample.TryGetProperty("failSaveAt", out var failAt) ? failAt.GetInt32() : null;
    var directories = DispatchProxy.Create<IDirectoryService, DirectoryServiceProxy>();

    var run = Run(sample, filename, configuration, providers, users, userData, directories, cancellation.Token);
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
        run.people,
        run.remoteImages,
        run.localImages,
        calls,
        userData = new
        {
            current = UserDataProxy.Snapshot(userDataControl.Data),
            persisted = userDataControl.Persisted
        }
    });
}

var output = JsonSerializer.Serialize(new
{
    schemaVersion = 1,
    candidateVerified = false,
    frozenJellyfinHead = "208c278b75abd897aefa1e1175126eac5e4dbfaa",
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual BaseNfoParser, MovieNfoParser, EpisodeNfoParser, SeriesNfoParser, SeasonNfoParser and SeriesNfoSeasonParser over exact temporary file bytes. Dependencies are controlled DispatchProxy instances. HasMetadata models BaseNfoProvider by becoming true only after Fetch returns. Partial item/people/image state and IUserManager/IUserDataManager call order remain observable after exceptions. UserData persistence itself is not a real database transaction.",
    uncovered = new[]
    {
        "local image filesystem acceptance and logging",
        "all scalar, ratings and fileinfo child permutations",
        "real user-data database transactions and emitted events",
        "provider path discovery and file disappearance/IO catch behavior",
        "all release-date formats and every external-id provider"
    },
    results
}, json).ReplaceLineEndings("\n") + "\n";
File.WriteAllText(args[1], output, new UTF8Encoding(false));

static byte[] InputBytes(JsonElement sample)
{
    var text = sample.GetProperty("text").GetString()!;
    var encoding = sample.TryGetProperty("encoding", out var value) ? value.GetString()! : "utf8";
    if (encoding == "utf8-markers") return Encoding.UTF8.GetBytes(text.Replace("{{NUL}}", "\0", StringComparison.Ordinal));
    if (encoding == "utf8-malformed")
    {
        var pieces = text.Split("{{BAD_UTF8}}", StringSplitOptions.None);
        return [.. Encoding.UTF8.GetBytes(pieces[0]), 0xC3, 0x28, .. Encoding.UTF8.GetBytes(pieces[1])];
    }

    Encoding codec = encoding switch
    {
        "utf8" => new UTF8Encoding(false),
        "utf8-bom" => new UTF8Encoding(true),
        "utf16le-bom" => new UnicodeEncoding(false, true),
        "utf16be-bom" => new UnicodeEncoding(true, true),
        "utf16le-no-bom" => new UnicodeEncoding(false, false),
        "utf32le-bom" => new UTF32Encoding(false, true),
        "utf32be-bom" => new UTF32Encoding(true, true),
        _ => throw new NotSupportedException(encoding)
    };
    return [.. codec.GetPreamble(), .. codec.GetBytes(text)];
}

static RunResult Run(JsonElement sample, string filename, IConfigurationManager configuration, IProviderManager providers,
    IUserManager users, IUserDataManager userData, IDirectoryService directories, CancellationToken cancellationToken)
{
    var type = sample.GetProperty("type").GetString()!;
    BaseItem item = type switch
    {
        "Movie" => new Movie(),
        "Video" => new Video(),
        "MusicVideo" => new MusicVideo(),
        "Series" => new Series(),
        "SeriesSeason" or "Season" => new Season(),
        "Episode" => new Episode(),
        "MusicAlbum" => new MusicAlbum(),
        "MusicArtist" => new MusicArtist(),
        _ => throw new NotSupportedException(type)
    };
    if (sample.TryGetProperty("existingId", out var existingId) && existingId.GetBoolean())
        item.Id = Guid.Parse("20000000-0000-0000-0000-000000000001");
    if (sample.TryGetProperty("initialName", out var initialName)) item.Name = initialName.GetString();
    if (sample.TryGetProperty("indexNumber", out var indexNumber)) item.IndexNumber = indexNumber.GetInt32();

    return type switch
    {
        "Movie" or "Video" or "MusicVideo" => Fetch((Video)item,
            new MovieNfoParser(NullLogger<MovieNfoParser>.Instance, configuration, providers, users, userData, directories), filename, cancellationToken),
        "Series" => Fetch((Series)item,
            new SeriesNfoParser(NullLogger<SeriesNfoParser>.Instance, configuration, providers, users, userData, directories), filename, cancellationToken),
        "SeriesSeason" => Fetch((Season)item,
            new SeriesNfoSeasonParser(NullLogger<SeriesNfoSeasonParser>.Instance, configuration, providers, users, userData, directories), filename, cancellationToken),
        "Season" => Fetch((Season)item,
            new SeasonNfoParser(NullLogger<SeasonNfoParser>.Instance, configuration, providers, users, userData, directories), filename, cancellationToken),
        "Episode" => Fetch((Episode)item,
            new EpisodeNfoParser(NullLogger<EpisodeNfoParser>.Instance, configuration, providers, users, userData, directories), filename, cancellationToken),
        "MusicAlbum" => Fetch((MusicAlbum)item,
            new BaseNfoParser<MusicAlbum>(NullLogger<BaseNfoParser<MusicAlbum>>.Instance, configuration, providers, users, userData, directories), filename, cancellationToken),
        "MusicArtist" => Fetch((MusicArtist)item,
            new BaseNfoParser<MusicArtist>(NullLogger<BaseNfoParser<MusicArtist>>.Instance, configuration, providers, users, userData, directories), filename, cancellationToken),
        _ => throw new NotSupportedException(type)
    };
}

static RunResult Fetch<T>(T item, BaseNfoParser<T> parser, string filename, CancellationToken cancellationToken)
    where T : BaseItem
{
    var result = new MetadataResult<T> { Item = item };
    string? exception = null;
    var hasMetadata = false;
    try
    {
        parser.Fetch(result, filename, cancellationToken);
        hasMetadata = true;
    }
    catch (Exception error)
    {
        exception = error.GetType().Name;
    }

    return new RunResult(exception, hasMetadata, Projection.Item(item),
        (result.People ?? []).Select(Projection.Person).ToArray(),
        result.RemoteImages.Select(image => new { image.Url, Type = image.Type.ToString() }).ToArray(),
        result.Images.Select(image => new { Path = image.FileInfo?.FullName, Type = image.Type.ToString() }).ToArray());
}

public sealed record RunResult(string? exception, bool hasMetadata, object item, object[] people, object[] remoteImages, object[] localImages);

public static class Projection
{
    public static object Item(BaseItem item)
    {
        var providers = new SortedDictionary<string, string>(item.ProviderIds, StringComparer.Ordinal);
        return new
        {
            runtimeType = item.GetType().Name,
            id = item.Id,
            item.Name,
            nameUtf16 = Utf16(item.Name),
            item.OriginalTitle,
            item.Overview,
            overviewUtf16 = Utf16(item.Overview),
            item.IndexNumber,
            indexNumberEnd = (item as Episode)?.IndexNumberEnd,
            item.ParentIndexNumber,
            item.ProductionYear,
            item.CommunityRating,
            item.CriticRating,
            runTimeTicks = item.RunTimeTicks?.ToString(),
            item.PreferredMetadataLanguage,
            item.PreferredMetadataCountryCode,
            providers,
            collectionName = (item as Movie)?.CollectionName,
            seriesName = (item as Episode)?.SeriesName,
            width = (item as Video)?.Width,
            height = (item as Video)?.Height,
            hasSubtitles = (item as Video)?.HasSubtitles,
            artists = (item as MusicVideo)?.Artists,
            album = (item as MusicVideo)?.Album
        };
    }

    private static int[]? Utf16(string? value) => value?.Select(character => (int)character).ToArray();

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
    public List<object> Calls = null!;
    public User User = new("NFO Reader", "controlled-auth", "controlled-reset")
    {
        Id = Guid.Parse("10000000-0000-0000-0000-000000000001")
    };

    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name == "GetUserById")
        {
            Calls.Add(new { action = "user", id = (Guid)args![0]! });
            return User;
        }

        if (method.Name is "add_OnUserUpdated" or "remove_OnUserUpdated") return null;
        throw new NotSupportedException(method.Name);
    }
}

public class UserDataProxy : DispatchProxy
{
    public List<object> Calls = null!;
    public CancellationTokenSource Cancellation = null!;
    public int? CancelAfterSave;
    public int? FailSaveAt;
    public int Saves;
    public UserItemData Data = new() { Key = "controlled" };
    public object? Persisted;

    public static object Snapshot(UserItemData value) => new
    {
        value.Played,
        value.PlayCount,
        lastPlayedDate = value.LastPlayedDate?.ToString("O")
    };

    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name == "GetUserData")
        {
            Calls.Add(new { action = "data", value = Snapshot(Data) });
            return Data;
        }

        if (method.Name == "SaveUserData" && args!.Length == 5)
        {
            var token = (CancellationToken)args[4]!;
            var attempt = ++Saves;
            Calls.Add(new
            {
                action = "save",
                attempt,
                reason = args[3]!.ToString(),
                tokenCanBeCanceled = token.CanBeCanceled,
                tokenIsCancellationRequested = token.IsCancellationRequested,
                value = Snapshot((UserItemData)args[2]!)
            });
            if (FailSaveAt == attempt) throw new IOException("Injected user-data save failure.");
            Persisted = Snapshot((UserItemData)args[2]!);
            if (CancelAfterSave == attempt) Cancellation.Cancel();
            return null;
        }

        if (method.Name is "add_UserDataSaved" or "remove_UserDataSaved") return null;
        throw new NotSupportedException(method.Name);
    }
}

public class DirectoryServiceProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetFile" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
