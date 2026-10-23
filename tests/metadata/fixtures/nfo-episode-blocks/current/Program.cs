using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
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
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var inputDirectory = Path.Combine(Path.GetDirectoryName(args[1])!, "episode-inputs");
Directory.CreateDirectory(inputDirectory);
var results = new List<object>();
var ordinal = 0;

foreach (var sample in input.EnumerateArray())
{
    var bytes = Encoding.UTF8.GetBytes(sample.GetProperty("text").GetString()!);
    var filename = Path.Combine(inputDirectory, $"{ordinal++:D3}.nfo");
    File.WriteAllBytes(filename, bytes);

    var calls = new List<object>();
    using var cancellation = new CancellationTokenSource();
    if (ReadBool(sample, "cancelBefore")) cancellation.Cancel();
    var configuration = DispatchProxy.Create<IConfigurationManager, ConfigurationProxy>();
    ((ConfigurationProxy)(object)configuration).Options = new XbmcMetadataOptions
    {
        UserId = "10000000-0000-0000-0000-000000000001"
    };
    var providers = DispatchProxy.Create<IProviderManager, ProviderProxy>();
    var users = DispatchProxy.Create<IUserManager, UserManagerProxy>();
    var userControl = (UserManagerProxy)(object)users;
    userControl.Calls = calls;
    userControl.FailAt = ReadInt(sample, "failUserAt");
    var userData = DispatchProxy.Create<IUserDataManager, UserDataProxy>();
    var dataControl = (UserDataProxy)(object)userData;
    dataControl.Calls = calls;
    dataControl.Cancellation = cancellation;
    dataControl.FailDataAt = ReadInt(sample, "failDataAt");
    dataControl.FailSaveAt = ReadInt(sample, "failSaveAt");
    dataControl.CancelAfterData = ReadInt(sample, "cancelAfterData");
    dataControl.CancelAfterSave = ReadInt(sample, "cancelAfterSave");
    var directories = DispatchProxy.Create<IDirectoryService, DirectoryServiceProxy>();

    var item = CreateItem(sample);
    var result = new MetadataResult<Episode> { Item = item };
    if (ReadBool(sample, "initialPeople"))
    {
        result.People = [new PersonInfo { Name = "Initial Person", Type = PersonKind.Actor, Role = "Initial" }];
    }

    string? exception = null;
    var hasMetadata = false;
    try
    {
        new EpisodeNfoParser(NullLogger<EpisodeNfoParser>.Instance, configuration, providers, users, userData, directories)
            .Fetch(result, filename, cancellation.Token);
        hasMetadata = true;
    }
    catch (Exception error)
    {
        exception = error.GetType().Name;
    }

    results.Add(new
    {
        name = sample.GetProperty("name").GetString(),
        file = new { filename, exists = true, bytes = bytes.Length, sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)) },
        raw = new
        {
            bytes = bytes.Length,
            sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            base64 = Convert.ToBase64String(bytes)
        },
        exception,
        hasMetadata,
        item = Projection.Item(item),
        people = (result.People ?? []).Select(Projection.Person).ToArray(),
        remoteImages = result.RemoteImages.Select(image => new { image.Url, Type = image.Type.ToString() }).ToArray(),
        localImages = result.Images.Select(image => new { Path = image.FileInfo?.FullName, Type = image.Type.ToString() }).ToArray(),
        calls,
        userData = new
        {
            current = UserDataProxy.Snapshot(dataControl.Data),
            persisted = dataControl.Persisted,
            committed = dataControl.Committed
        }
    });
}

var output = JsonSerializer.Serialize(new
{
    schemaVersion = 1,
    actualExecution = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    environment = new
    {
        os = Environment.OSVersion.ToString(),
        isWindows = OperatingSystem.IsWindows(),
        culture = CultureInfo.CurrentCulture.Name,
        uiCulture = CultureInfo.CurrentUICulture.Name
    },
    boundary = "Actual designated EpisodeNfoParser over exact UTF-8 files. Controlled user managers record full lookup, save and cancellation traces. Node reads the same files; functional comparison retains metadata prefixes, ordered save attempts, committed save prefixes and final user-data values after return or failure.",
    uncovered = new[]
    {
        "non-UTF-8 decoding outside these UTF-8 inputs",
        "local image filesystem behavior outside the controlled directory service",
        "real user-data database transactions and events outside these controlled managers",
        "Episode scalar, date, external-id and XML combinations outside the declared matrix",
        "provider file discovery and downstream metadata refresh persistence"
    },
    results,
    assemblies = new[] { typeof(EpisodeNfoParser).Assembly, typeof(Episode).Assembly, typeof(User).Assembly,
        typeof(XbmcMetadataOptions).Assembly, typeof(IConfigurationManager).Assembly }.Distinct().Select(assembly => new {
        name = assembly.GetName().Name, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) })
}, json).ReplaceLineEndings("\n") + "\n";
File.WriteAllText(args[1], output, new UTF8Encoding(false));

static Episode CreateItem(JsonElement sample)
{
    var item = new Episode();
    if (ReadBool(sample, "existingId")) item.Id = Guid.Parse("20000000-0000-0000-0000-000000000001");
    if (sample.TryGetProperty("initialName", out var value)) item.Name = value.GetString();
    if (sample.TryGetProperty("initialOriginalTitle", out value)) item.OriginalTitle = value.GetString();
    if (sample.TryGetProperty("initialOverview", out value)) item.Overview = value.GetString();
    if (sample.TryGetProperty("initialSeriesName", out value)) item.SeriesName = value.GetString();
    if (sample.TryGetProperty("initialIndexNumber", out value)) item.IndexNumber = value.GetInt32();
    if (sample.TryGetProperty("initialIndexNumberEnd", out value)) item.IndexNumberEnd = value.GetInt32();
    if (sample.TryGetProperty("initialParentIndexNumber", out value)) item.ParentIndexNumber = value.GetInt32();
    if (sample.TryGetProperty("initialAirsBeforeEpisodeNumber", out value)) item.AirsBeforeEpisodeNumber = value.GetInt32();
    if (sample.TryGetProperty("initialAirsAfterSeasonNumber", out value)) item.AirsAfterSeasonNumber = value.GetInt32();
    if (sample.TryGetProperty("initialAirsBeforeSeasonNumber", out value)) item.AirsBeforeSeasonNumber = value.GetInt32();
    if (sample.TryGetProperty("initialProviderIds", out value))
    {
        foreach (var property in value.EnumerateObject()) item.ProviderIds[property.Name] = property.Value.GetString()!;
    }

    return item;
}

static bool ReadBool(JsonElement sample, string name)
    => sample.TryGetProperty(name, out var value) && value.GetBoolean();

static int? ReadInt(JsonElement sample, string name)
    => sample.TryGetProperty(name, out var value) ? value.GetInt32() : null;

public static class Projection
{
    public static object Item(Episode item)
    {
        var providers = new SortedDictionary<string, string>(item.ProviderIds, StringComparer.Ordinal);
        return new
        {
            id = item.Id,
            item.Name,
            item.OriginalTitle,
            item.Overview,
            item.IndexNumber,
            item.IndexNumberEnd,
            item.ParentIndexNumber,
            item.AirsBeforeEpisodeNumber,
            item.AirsAfterSeasonNumber,
            item.AirsBeforeSeasonNumber,
            item.SeriesName,
            item.ProductionYear,
            item.CommunityRating,
            item.CriticRating,
            runTimeTicks = item.RunTimeTicks?.ToString(),
            premiereDate = item.PremiereDate?.ToString("O"),
            endDate = item.EndDate?.ToString("O"),
            item.OfficialRating,
            item.CustomRating,
            item.Tagline,
            item.IsLocked,
            lockedFields = item.LockedFields,
            productionLocations = item.ProductionLocations,
            genres = item.Genres,
            studios = item.Studios,
            tags = item.Tags,
            item.AspectRatio,
            item.Width,
            item.Height,
            item.HasSubtitles,
            providers
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
    public List<object> Calls = null!;
    public int? FailAt;
    public int Count;
    public User User = new("Episode NFO", "controlled-auth", "controlled-reset")
    {
        Id = Guid.Parse("10000000-0000-0000-0000-000000000001")
    };

    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name == "GetUserById")
        {
            var attempt = ++Count;
            Calls.Add(new { action = "user", attempt, id = (Guid)args![0]! });
            if (FailAt == attempt) throw new IOException("Injected user lookup failure.");
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
    public int? FailDataAt;
    public int? FailSaveAt;
    public int? CancelAfterData;
    public int? CancelAfterSave;
    public int DataCalls;
    public int Saves;
    public UserItemData Data = new() { Key = "controlled" };
    public object? Persisted;
    public List<object> Committed = [];

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
            var attempt = ++DataCalls;
            var item = (BaseItem)args![1]!;
            Calls.Add(new { action = "data", attempt, itemId = item.Id, value = Snapshot(Data) });
            if (FailDataAt == attempt) throw new IOException("Injected user-data read failure.");
            if (CancelAfterData == attempt) Cancellation.Cancel();
            return Data;
        }

        if (method.Name == "SaveUserData" && args!.Length == 5)
        {
            var token = (CancellationToken)args[4]!;
            var attempt = ++Saves;
            var item = (BaseItem)args[1]!;
            Calls.Add(new
            {
                action = "save",
                attempt,
                itemId = item.Id,
                reason = args[3]!.ToString(),
                tokenCanBeCanceled = token.CanBeCanceled,
                tokenIsCancellationRequested = token.IsCancellationRequested,
                value = Snapshot((UserItemData)args[2]!)
            });
            if (FailSaveAt == attempt) throw new IOException("Injected user-data save failure.");
            Persisted = Snapshot((UserItemData)args[2]!);
            Committed.Add(new { itemId = item.Id, reason = args[3]!.ToString(), value = Persisted });
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
