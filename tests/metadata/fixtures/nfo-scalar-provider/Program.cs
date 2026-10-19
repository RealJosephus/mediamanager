// Records scalar, date, type-specific and external-id behavior from the pinned Jellyfin DLLs.
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
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
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var inputDirectory = Path.Combine(Path.GetDirectoryName(args[1])!, "nfo-inputs");
Directory.CreateDirectory(inputDirectory);
var results = new List<object>();
var ordinal = 0;

foreach (var sample in input.EnumerateArray())
{
    var bytes = Encoding.UTF8.GetBytes(sample.GetProperty("text").GetString()!);
    var filename = Path.Combine(inputDirectory, $"{ordinal++:D3}.nfo");
    File.WriteAllBytes(filename, bytes);

    var options = new XbmcMetadataOptions
    {
        ReleaseDateFormat = sample.TryGetProperty("releaseDateFormat", out var format)
            ? format.GetString()!
            : "yyyy-MM-dd"
    };
    var configuration = DispatchProxy.Create<IConfigurationManager, ConfigurationProxy>();
    ((ConfigurationProxy)(object)configuration).Options = options;
    var providers = DispatchProxy.Create<IProviderManager, ProviderProxy>();
    ((ProviderProxy)(object)providers).Keys = sample.TryGetProperty("externalIds", out var externalIds)
        ? externalIds.EnumerateArray().Select(value => value.GetString()!).ToArray()
        : ProviderProxy.DefaultKeys;
    var users = DispatchProxy.Create<IUserManager, UnusedProxy>();
    var userData = DispatchProxy.Create<IUserDataManager, UnusedProxy>();
    var directories = DispatchProxy.Create<IDirectoryService, DirectoryProxy>();
    using var cancellation = new CancellationTokenSource();
    if (sample.TryGetProperty("preCanceled", out var preCanceled) && preCanceled.GetBoolean()) cancellation.Cancel();

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
        run.people
    });
}

var output = JsonSerializer.Serialize(new
{
    schemaVersion = 1,
    candidateVerified = false,
    frozenJellyfinHead = "208c278b75abd897aefa1e1175126eac5e4dbfaa",
    inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    boundary = "Actual BaseNfoParser, MovieNfoParser, EpisodeNfoParser, SeriesNfoParser, SeasonNfoParser and SeriesNfoSeasonParser over exact UTF-8 file bytes. Provider availability, release-date format and pre-cancellation are controlled inputs. Item state and people remain observable after exceptions.",
    covered = new[]
    {
        "common scalar overwrite, CLR trim, list, lock, numeric and full CLR PersonKind Enum.TryParse behavior",
        "Movie, Video, MusicVideo, Series, Season, SeriesNfoSeason, Episode, MusicAlbum and MusicArtist dispatch",
        "dateadded 100ns tick preservation, release-date tag integration, UTC offset boundaries and ProductionYear precedence",
        "direct configured provider nodes, aliases, uniqueid, id attributes, validation and trailing provider URLs",
        "representative pre-cancellation and scalar/provider failure-prefix behavior"
    },
    excludedBecauseSealedElsewhere = new[]
    {
        "custom date-format token grammar and exhaustive date value matrix: nfo-date-format",
        "ratings and fileinfo child streaming plus namespace/name boundaries: nfo-complex-streaming",
        "generic partial XML, byte encoding and user-data failure ordering: nfo-partial-reader",
        "Episode multi-block sorting, winner replay, cancellation and user-data import: nfo-episode-blocks",
        "thumb, fanart and local filesystem URI behavior: nfo-local-images and nfo-fanart-set-streaming"
    },
    uncovered = new[]
    {
        "full XML 1.0 character, DTD, declaration and encoding behavior",
        "external-id providers not exposed by this controlled provider set or requiring provider plugin execution",
        "real user-data persistence, database transactions and emitted events",
        "provider file discovery, filesystem races and logging"
    },
    results
}, json).ReplaceLineEndings("\n") + "\n";
File.WriteAllText(args[1], output, new UTF8Encoding(false));

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
    if (sample.TryGetProperty("indexNumber", out var indexNumber)) item.IndexNumber = indexNumber.GetInt32();
    if (sample.TryGetProperty("initialName", out var initialName)) item.Name = initialName.GetString();
    if (sample.TryGetProperty("initialOverview", out var initialOverview)) item.Overview = initialOverview.GetString();
    if (sample.TryGetProperty("initialProviderIds", out var initialProviderIds))
    {
        foreach (var pair in initialProviderIds.EnumerateObject()) item.ProviderIds[pair.Name] = pair.Value.GetString()!;
    }

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

    return new RunResult(exception, hasMetadata, Projection.Item(item), (result.People ?? []).Select(Projection.Person).ToArray());
}

public sealed record RunResult(string? exception, bool hasMetadata, object item, object[] people);

public static class Projection
{
    public static object Item(BaseItem item)
    {
        var providers = new SortedDictionary<string, string>(item.ProviderIds, StringComparer.Ordinal);
        return new
        {
            runtimeType = item.GetType().Name,
            item.Name,
            item.OriginalTitle,
            SortName = SortNameBacking(item),
            item.ForcedSortName,
            item.Overview,
            item.PreferredMetadataLanguage,
            item.PreferredMetadataCountryCode,
            item.Tagline,
            item.OfficialRating,
            item.CustomRating,
            dateCreated = Date(item.DateCreated),
            premiereDate = Date(item.PremiereDate),
            endDate = Date(item.EndDate),
            item.ProductionYear,
            item.CommunityRating,
            item.CriticRating,
            runTimeTicks = item.RunTimeTicks?.ToString(CultureInfo.InvariantCulture),
            item.IsLocked,
            lockedFields = item.LockedFields.Select(value => value.ToString()).ToArray(),
            productionLocations = item.ProductionLocations,
            studios = item.Studios,
            genres = item.Genres,
            tags = item.Tags,
            trailers = item.RemoteTrailers.Select(value => value.Url).ToArray(),
            providers,
            aspectRatio = (item as IHasAspectRatio)?.AspectRatio,
            displayOrder = (item as IHasDisplayOrder)?.DisplayOrder,
            collectionName = (item as Movie)?.CollectionName,
            artists = (item as MusicVideo)?.Artists,
            album = (item as MusicVideo)?.Album,
            airTime = (item as Series)?.AirTime,
            airDays = (item as Series)?.AirDays.Select(value => value.ToString()).ToArray(),
            status = (item as Series)?.Status?.ToString(),
            item.IndexNumber,
            indexNumberEnd = (item as Episode)?.IndexNumberEnd,
            item.ParentIndexNumber,
            airsBeforeEpisodeNumber = (item as Episode)?.AirsBeforeEpisodeNumber,
            airsAfterSeasonNumber = (item as Episode)?.AirsAfterSeasonNumber,
            airsBeforeSeasonNumber = (item as Episode)?.AirsBeforeSeasonNumber,
            seriesName = (item as Episode)?.SeriesName
        };
    }

    private static string? Date(DateTime value) => value == default ? null : value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
    private static string? Date(DateTime? value) => value.HasValue ? Date(value.Value) : null;
    private static string? SortNameBacking(BaseItem item) => (string?)typeof(BaseItem)
        .GetField("_sortName", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(item);

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
    public static readonly string[] DefaultKeys =
    [
        "Imdb", "Tmdb", "Tvdb", "TvRage", "Zap2It", "MusicBrainzArtist", "MusicBrainzAlbum",
        "MusicBrainzAlbumArtist", "MusicBrainzReleaseGroup", "MusicBrainzTrack", "MusicBrainzRecording",
        "AudioDbArtist", "AudioDbAlbum", "CustomMapped"
    ];
    public string[] Keys = null!;

    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetExternalIdInfos" => Keys.Select(key => new ExternalIdInfo(key, key, ExternalIdMediaType.Movie)).ToArray(),
        "add_RefreshStarted" or "remove_RefreshStarted" or "add_RefreshCompleted" or "remove_RefreshCompleted"
            or "add_RefreshProgress" or "remove_RefreshProgress" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class UnusedProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "add_OnUserUpdated" or "remove_OnUserUpdated" or "add_UserDataSaved" or "remove_UserDataSaved" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class DirectoryProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetFile" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
